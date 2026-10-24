// Interactive client (single-test view) against the mock vendor.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SmppClient, analyze } = require('../smpp-core');
const { MockSmsc } = require('../mock-smsc');
const { freePort, sleep } = require('./helpers');

const waitFor = (emitter, ev, pred, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { emitter.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
  const h = d => { if (!pred || pred(d)) { clearTimeout(t); emitter.off(ev, h); resolve(d); } };
  emitter.on(ev, h);
});
const MSG = { srcTon: 5, srcNpi: 0, src: 'TEST', dst: '447700900123', dstTon: 1, dstNpi: 1, dlr: 1 };

test('encoding analysis', () => {
  assert.deepEqual(analyze('Hello world', 'auto'), { enc: 'gsm7', bytes: 11, units: 11, parts: 1, dcs: 0 });
  assert.equal(analyze('Çalışıyor ğüşı', 'auto').enc, 'ucs2');
  assert.equal(analyze('a'.repeat(161), 'auto').parts, 2);
  assert.equal(analyze('€'.repeat(80), 'auto').parts, 1, '80 escape characters = 160 septets, still one SMS');
  assert.equal(analyze('€'.repeat(81), 'auto').parts, 2, 'GSM escape characters count as two septets');
  assert.ok(analyze('ğ', 'gsm7').error, 'non-GSM text in GSM-7 is an error');
});

test('bind, submit, concatenation, DLR, MO and batch', async t => {
  const port = freePort();
  const vendor = new MockSmsc();
  vendor.start({ port, systemId: 'user', password: 'pw', dlrDelay: 100 });
  await waitFor(vendor, 'listening');
  const c = new SmppClient();
  t.after(() => { c.disconnect(); vendor.stop(); });

  c.connect({ host: '127.0.0.1', port, systemId: 'user', password: 'pw', bindMode: 'trx' });
  await waitFor(c, 'state', s => s.state === 'bound');

  const dlrs = [];
  c.on('dlr', d => dlrs.push(d));

  const long = await c.submitOne({ ...MSG, text: 'Long UCS-2 message ğüşıöç '.repeat(8), encoding: 'auto', split: 'udh' }, 1);
  assert.equal(long.ok, true);
  assert.equal(long.rec.enc, 'ucs2');
  assert.equal(long.rec.parts, 4, '208 UCS-2 chars at 67 chars per part');

  const payload = await c.submitOne({ ...MSG, text: 'payload '.repeat(30), encoding: 'gsm7', split: 'payload' }, 2);
  assert.equal(payload.ok, true);
  assert.equal(payload.rec.parts, 1);

  const batch = await c.submitBatch({ ...MSG, text: 'Batch {n}', count: 50, tps: 200 });
  assert.equal(batch.ok, 50);
  assert.equal(batch.fail, 0);

  await sleep(800);
  assert.equal(dlrs.length, 4 + 1 + 50, 'one DLR per submitted PDU');
  assert.ok(dlrs.every(d => d.matched), 'every DLR matches a sent message');

  const mo = waitFor(c, 'mo');
  assert.equal(vendor.sendMo('Hello MO ğüş', '447700900999', 'TEST'), 1);
  const m = await mo;
  assert.equal(m.from, '447700900999');
});

test('wrong credentials are rejected', async t => {
  const port = freePort();
  const vendor = new MockSmsc();
  vendor.start({ port, systemId: 'user', password: 'pw' });
  await waitFor(vendor, 'listening');
  const c = new SmppClient();
  t.after(() => { c.disconnect(); vendor.stop(); });
  c.connect({ host: '127.0.0.1', port, systemId: 'user', password: 'wrong' });
  const s = await waitFor(c, 'state', s => s.state === 'error');
  assert.match(s.info, /ESME_RBINDFAIL/);
  assert.equal(s.infoKey, 'Bind rejected: {status}');
});

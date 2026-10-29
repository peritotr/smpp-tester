// "Vendor messages": the vendor keeps what arrived and decodes it (encoding, UDH parts, text).
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeSm, alphabet, GSM7 } = require('../sms-decode');
const { SmppClient } = require('../smpp-core');
const { MockSmsc } = require('../mock-smsc');
const { freePort } = require('./helpers');

const waitFor = (emitter, ev, pred, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { emitter.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
  const h = d => { if (!pred || pred(d)) { clearTimeout(t); emitter.off(ev, h); resolve(d); } };
  emitter.on(ev, h);
});

test('decoder: data_coding names, GSM7 with escapes, UCS2, UDH parts', () => {
  assert.equal(GSM7.length, 128);
  assert.equal(alphabet(0), 'GSM7'); assert.equal(alphabet(8), 'UCS2'); assert.equal(alphabet(3), 'LATIN1'); assert.equal(alphabet(4), 'BINARY');
  assert.equal(alphabet(0x10), 'GSM7', 'GSM 03.38 class 0'); assert.equal(alphabet(0x18), 'UCS2'); assert.equal(alphabet(0xf0), 'GSM7'); assert.equal(alphabet(0xf4), 'BINARY');

  // GSM7 unpacked as SMPP carries it: '@' is 0x00, '€' is 0x1B 0x65
  const g = decodeSm(0, 0, Buffer.from([0x00, 0x20, 0x1b, 0x65, 0x20, 0x41, 0x7f]));
  assert.equal(g.text, '@ € Aà'); assert.equal(g.encLabel, 'GSM7 (0)');

  const u = decodeSm(8, 0, Buffer.from('Teşekkürler ğ', 'utf16le').swap16());
  assert.equal(u.text, 'Teşekkürler ğ'); assert.equal(u.enc, 'UCS2');

  // UDH 05 00 03 <ref> <total> <seq> then the text
  const p = decodeSm(0, 0x40, Buffer.concat([Buffer.from([5, 0, 3, 0x2a, 2, 1]), Buffer.from('Part one')]));
  assert.equal(p.parts, '1/2'); assert.equal(p.text, 'Part one');

  const b = decodeSm(4, 0, Buffer.from([0xde, 0xad]));
  assert.equal(b.text, ''); assert.equal(b.hex, 'dead');
});

test('vendor keeps incoming messages: account, numbers, encoding and text; search and clear', async t => {
  const port = freePort();
  const vendor = new MockSmsc();
  vendor.start({ port, dlrDelay: 50 });
  await waitFor(vendor, 'listening');
  const c = new SmppClient();
  t.after(() => { c.disconnect(); vendor.stop(); });
  c.connect({ host: '127.0.0.1', port, systemId: 'acme', password: 'x', bindMode: 'trx' });
  await waitFor(c, 'state', s => s.state === 'bound');

  const base = { srcTon: 5, srcNpi: 0, src: 'ACME', dstTon: 1, dstNpi: 1, dlr: 1 };
  assert.equal((await c.submitOne({ ...base, dst: '447700900137', text: 'Your code is ready. Thank you B137', encoding: 'auto' }, 1)).ok, true);
  assert.equal((await c.submitOne({ ...base, dst: '905551112233', text: 'Teşekkürler, siparişiniz yolda', encoding: 'auto' }, 2)).ok, true);
  assert.equal((await c.submitOne({ ...base, dst: '905551112244', text: 'Uzun mesaj ğüşıöç '.repeat(6), encoding: 'auto', split: 'udh' }, 3)).ok, true);

  const all = vendor.listMsgs();
  assert.equal(all.total, 4, 'one + one + a two-part message');
  const [first] = vendor.listMsgs('B137').list;
  assert.equal(first.text, 'Your code is ready. Thank you B137');
  assert.equal(first.encLabel, 'GSM7 (0)'); assert.equal(first.sid, 'acme'); assert.equal(first.src, 'ACME'); assert.equal(first.dst, '447700900137'); assert.equal(first.reg, 1);
  const tr = vendor.listMsgs('siparişiniz').list[0];
  assert.equal(tr.enc, 'UCS2'); assert.equal(tr.dcs, 8);
  const parts = vendor.listMsgs('905551112244').list.map(r => r.parts).sort();
  assert.deepEqual(parts, ['1/2', '2/2']);
  assert.deepEqual(all.enc, { 0: 1, 8: 3 });
  assert.equal(all.list[0].dst, '905551112244', 'newest first');

  vendor.clearMsgs();
  assert.equal(vendor.listMsgs().list.length, 0);
});

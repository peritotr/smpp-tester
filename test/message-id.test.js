// message_id from the built-in vendor: never repeats (also across restarts), ≤ 64 chars, and the DLR carries the same id
// in its receipt text and in the receipted_message_id TLV. Reusing ids is an explicit, opt-in test scenario.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const smpp = require('smpp');
const { MockSmsc } = require('../mock-smsc');
const { freePort } = require('./helpers');

const once = (em, ev) => new Promise(r => em.once(ev, r));

// A minimal submit_sm body (no DLR requested) that goes through the vendor's real submit path
function submitBody(i) {
  const s = (x) => Buffer.from(x + '\0', 'latin1');
  return Buffer.concat([s(''), Buffer.from([5, 0]), s('TEST'), Buffer.from([1, 1]), s('4477009' + String(i % 100000).padStart(5, '0')),
    Buffer.from([0, 0, 0]), s(''), s(''), Buffer.from([0, 0, 0, 0, 2]), Buffer.from('hi')]);
}
// Runs n submits through the vendor and returns the message_ids it answered with
function submitMany(v, n, ids) {
  const c = { bound: true, rx: false, sock: { destroyed: false } };
  const write = v._write; v._write = (_, b) => { let e = 16; while (b[e]) e++; ids.push(b.toString('latin1', 16, e)); };
  try { for (let i = 0; i < n; i++) v._submit(c, i + 1, submitBody(i)); } finally { v._write = write; }
}

test('1M submits with a vendor restart in between: no duplicate message_id, all ≤ 64 chars', async () => {
  const port = freePort();
  const v = new MockSmsc();
  const ids = [];
  v.start({ port }); await once(v, 'listening');
  submitMany(v, 600000, ids);
  v.stop();
  v.start({ port }); await once(v, 'listening'); // restart: the counter starts again, the prefix must not
  submitMany(v, 400000, ids);
  v.stop();
  // A vendor in a separate process (e.g. after the app or container restarts)
  const other = execFileSync(process.execPath, ['-e', `
    const { MockSmsc } = require(${JSON.stringify(path.join(__dirname, '..', 'mock-smsc.js'))});
    const v = new MockSmsc(); v.o = {}; const out = []; for (let i = 0; i < 1000; i++) out.push(v.nextId()); console.log(out.join(','));
  `]).toString().trim().split(',');

  const all = ids.concat(other);
  assert.equal(ids.length, 1000000);
  assert.equal(new Set(all).size, all.length, 'every message_id is unique');
  assert.ok(all.every(id => id.length > 0 && id.length <= 64), 'SMPP 3.4: message_id fits in 65 bytes with its terminator');
  assert.notEqual(ids[0].split('-')[0], ids[600000].split('-')[0], 'a restart gets a new prefix');
  assert.match(ids[0], /^[0-9A-F]+-0$/);
});

test('the DLR carries the submit_sm_resp message_id in its text and in receipted_message_id (0x001E)', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 20 }); await once(v, 'listening');
  const s = smpp.connect({ url: `smpp://127.0.0.1:${port}`, auto_enquire_link_period: 0 });
  t.after(() => { try { s.destroy(); } catch {} v.stop(); });
  await once(s, 'connect');
  await new Promise((res, rej) => s.bind_transceiver({ system_id: 'x', password: 'y' }, p => p.command_status === 0 ? res() : rej(new Error('bind'))));
  const dlrs = new Map();
  s.on('deliver_sm', p => { s.send(p.response()); const txt = Buffer.isBuffer(p.short_message.message) ? p.short_message.message.toString('latin1') : String(p.short_message.message); dlrs.set(p.receipted_message_id, txt); });
  const sent = [];
  for (let i = 0; i < 20; i++) {
    sent.push(await new Promise(res => s.submit_sm({ source_addr: 'TEST', destination_addr: '447700900' + (100 + i), short_message: 'Hello ' + i, registered_delivery: 1 }, p => res(p.message_id))));
  }
  for (let i = 0; i < 100 && dlrs.size < sent.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(new Set(sent).size, sent.length);
  for (const id of sent) {
    assert.ok(dlrs.has(id), `DLR with receipted_message_id ${id}`);
    assert.equal(/id:(\S+)/.exec(dlrs.get(id))[1], id, 'id: in the receipt text matches submit_sm_resp');
  }
});

test('reusing message_ids is opt-in: off by default, every N submits when set', async () => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port }); await once(v, 'listening');
  const plain = []; submitMany(v, 10, plain);
  assert.equal(new Set(plain).size, 10);
  v.stop();
  v.start({ port, idReuse: 3 }); await once(v, 'listening');
  const reused = []; submitMany(v, 7, reused);
  v.stop();
  assert.deepEqual(reused, ['100000', '100001', '100002', '100000', '100001', '100002', '100000']);
});

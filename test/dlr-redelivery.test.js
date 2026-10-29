// DLR redelivery: DLRs the client could not take are kept per system_id (also across a vendor restart) and sent
// again, identical, when it binds again. The full 10,000-message acceptance run is tools/dlr-redelivery-check.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const smpp = require('smpp');
const { MockSmsc } = require('../mock-smsc');
const { freePort, sleep } = require('./helpers');

const once = (em, ev) => new Promise(r => em.once(ev, r));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smpp-dlr-'));

// A gateway stand-in: binds TRX as `sid`, can answer DLRs with OK, an error, or not at all
async function client(port, sid = 'gw', { answer = 'ok', bind = 'trx' } = {}) {
  const s = smpp.connect({ url: `smpp://127.0.0.1:${port}`, auto_enquire_link_period: 0 });
  s.on('error', () => {});
  await once(s, 'connect');
  await new Promise((res, rej) => s[bind === 'tx' ? 'bind_transmitter' : 'bind_transceiver']({ system_id: sid, password: 'x' }, p => p.command_status === 0 ? res() : rej(new Error('bind failed'))));
  const dlrs = [];
  s.mode = answer;
  s.on('deliver_sm', p => {
    const txt = Buffer.isBuffer(p.short_message.message) ? p.short_message.message.toString('latin1') : String(p.short_message.message);
    dlrs.push({ rid: p.receipted_message_id, txt });
    if (s.mode === 'ok') s.send(p.response());
    else if (s.mode === 'error') s.send(p.response({ command_status: 0x08 }));
    // 'none': no deliver_sm_resp
  });
  s.dlrs = dlrs;
  s.submitN = async n => {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(await new Promise(res => s.submit_sm({ source_addr: 'TEST', destination_addr: '4477009' + String(i).padStart(5, '0'), short_message: 'm' + i, registered_delivery: 1 }, p => res(p.message_id))));
    return ids;
  };
  return s;
}
const waitFor = async (pred, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(50); } return pred(); };
const idOf = txt => (/id:(\S+)/.exec(txt) || [])[1];

test('bind drops before the DLRs are due: all of them arrive after the client binds again, once each', async t => {
  const port = freePort();
  const v = new MockSmsc(); const logs = []; v.on('log', m => logs.push(m.text));
  v.start({ port, dlrDelay: 300 }); await once(v, 'listening');
  t.after(() => v.stop());
  const a = await client(port, 'gw', { bind: 'tx' }); // sends only: DLRs wait for a receiver
  const ids = await a.submitN(1500);
  a.destroy();                                  // gateway restarts
  await sleep(800);                             // DLRs fall due with nobody bound
  assert.equal(v.D.live.size, 1500, 'kept, not dropped');
  const b = await client(port);
  assert.ok(await waitFor(() => b.dlrs.length >= 1500), `got ${b.dlrs.length}`);
  await sleep(300);
  assert.equal(b.dlrs.length, 1500, 'no duplicates');
  assert.deepEqual(new Set(b.dlrs.map(d => d.rid)), new Set(ids), 'every message_id exactly once');
  assert.ok(b.dlrs.every(d => idOf(d.txt) === d.rid), 'receipt text id = receipted_message_id');
  assert.ok(logs.some(l => /Started delivering 1500 pending DLRs to gw/.test(l)), 'one summary line on reconnect');
  assert.equal(v.D.redelivered, 1500); assert.equal(v.D.live.size, 0);
  b.destroy();
});

test('sent but not confirmed when the connection drops: sent again, byte-for-byte the same', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 50 }); await once(v, 'listening');
  t.after(() => v.stop());
  const a = await client(port, 'gw', { answer: 'none' });
  const ids = await a.submitN(200);
  assert.ok(await waitFor(() => a.dlrs.length >= 200));
  const first = new Map(a.dlrs.map(d => [d.rid, d.txt]));
  a.destroy();
  await sleep(200);
  const b = await client(port);
  assert.ok(await waitFor(() => b.dlrs.length >= 200));
  assert.deepEqual(new Set(b.dlrs.map(d => d.rid)), new Set(ids));
  for (const d of b.dlrs) assert.equal(d.txt, first.get(d.rid), 'same id, stat, err, submit date and done date');
  b.destroy();
});

test('error deliver_sm_resp: retried after a back-off until confirmed', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 0 }); await once(v, 'listening');
  t.after(() => v.stop());
  const a = await client(port, 'gw', { answer: 'error' });
  const [id] = await a.submitN(1);
  assert.ok(await waitFor(() => a.dlrs.length >= 1));
  const t1 = Date.now(); a.mode = 'ok';
  assert.ok(await waitFor(() => a.dlrs.length >= 2, 5000), 'sent again');
  const gap = Date.now() - t1;
  assert.ok(gap >= 700, `waited ~1 s before retrying (${gap} ms)`);
  assert.equal(a.dlrs[1].rid, id); assert.equal(a.dlrs[1].txt, a.dlrs[0].txt);
  await waitFor(() => v.D.live.size === 0, 2000);
  assert.equal(v.D.retried, 1); assert.equal(v.D.live.size, 0);
  a.destroy();
});

test('vendor restart while the client is away: pending DLRs come back from disk; new ids stay unique', async t => {
  const port = freePort(), dir = tmpDir();
  let v = new MockSmsc();
  v.start({ port, dlrDelay: 200, stateDir: dir }); await once(v, 'listening');
  const a = await client(port, 'gw', { bind: 'tx' });
  const ids = await a.submitN(800);
  a.destroy();
  await sleep(100);
  v.stop();                                     // restart: some DLRs were due, some not yet
  v = new MockSmsc(); const logs = []; v.on('log', m => logs.push(m.text));
  v.start({ port, dlrDelay: 200, stateDir: dir }); await once(v, 'listening');
  t.after(() => { v.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.ok(logs.some(l => /Restored 800 pending DLRs/.test(l)), logs.join(' | '));
  const b = await client(port);
  assert.ok(await waitFor(() => b.dlrs.length >= 800), `got ${b.dlrs.length}`);
  await sleep(300);
  assert.equal(b.dlrs.length, 800);
  assert.deepEqual(new Set(b.dlrs.map(d => d.rid)), new Set(ids));
  const fresh = await b.submitN(50);
  assert.ok(fresh.every(id => !ids.includes(id)), 'message_ids after the restart are new');
  b.destroy();
});

test('expired pending DLRs are dropped and counted; redelivery off drops instead of keeping', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 400, dlrRetentionHours: 1 / 3600 }); await once(v, 'listening'); // keep for 1 s
  t.after(() => v.stop());
  const a = await client(port, 'gw', { bind: 'tx' });
  await a.submitN(30); a.destroy();
  await sleep(2600);
  assert.equal(v.D.expired, 30); assert.equal(v.D.live.size, 0);
  v.stop();

  const port2 = freePort();
  const w = new MockSmsc();
  w.start({ port: port2, dlrDelay: 300, dlrRedelivery: false }); await once(w, 'listening');
  t.after(() => w.stop());
  const c = await client(port2, 'gw', { bind: 'tx' });
  await c.submitN(30); c.destroy();
  await sleep(600);
  assert.equal(w.D.dropped, 30);
  const d = await client(port2);
  await sleep(500);
  assert.equal(d.dlrs.length, 0);
  d.destroy();
});

test('pending DLRs go out at the redelivery rate, then fresh DLRs flow behind them in order', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 0, dlrRedeliveryTps: 500 }); await once(v, 'listening');
  t.after(() => v.stop());
  const a = await client(port, 'gw', { bind: 'tx' });
  const old = await a.submitN(1000); a.destroy();
  await sleep(200);
  const b = await client(port);
  const t0 = Date.now();
  const fresh = await b.submitN(20);
  assert.ok(await waitFor(() => b.dlrs.length >= 1020, 10000));
  const took = Date.now() - t0;
  assert.ok(took >= 1500 && took < 4000, `1,000 pending at 500/s took ${took} ms`);
  const order = b.dlrs.map(d => d.rid);
  assert.deepEqual(order.slice(0, 1000), old, 'oldest first');
  assert.deepEqual(order.slice(1000), fresh, 'new DLRs after the backlog');
  b.destroy();
});

// Vendor under gateway load: error classes, spread-out retries, DLR rate limits, delay distributions, metrics endpoint.
// The full 8,000 TPS × 10 min check is tools/vendor-load-check.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const smpp = require('smpp');
const { MockSmsc } = require('../mock-smsc');
const { delaySampler, backoff, parseCodes, MinHeap } = require('../dlr-sched');
const { freePort, sleep } = require('./helpers');

const once = (em, ev) => new Promise(r => em.once(ev, r));
const waitFor = async (pred, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(50); } return pred(); };
const req = (port, method, p) => new Promise((res, rej) => http.request({ host: '127.0.0.1', port, method, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(b) })); }).on('error', rej).end());

// Gateway stand-in: answers each DLR with what `answer(n, pdu)` returns (status code), records arrival times
async function gateway(port, answer = () => 0) {
  const s = smpp.connect({ url: `smpp://127.0.0.1:${port}`, auto_enquire_link_period: 0 });
  s.on('error', () => {});
  await once(s, 'connect');
  await new Promise((res, rej) => s.bind_transceiver({ system_id: 'gw', password: 'x' }, p => p.command_status === 0 ? res() : rej(new Error('bind'))));
  s.got = []; let n = 0;
  s.on('deliver_sm', p => { const st = answer(++n, p); s.got.push({ rid: p.receipted_message_id, at: Date.now(), st }); s.send(p.response({ command_status: st })); });
  s.submitN = async k => Promise.all(Array.from({ length: k }, (_, i) => new Promise(r => s.submit_sm({ source_addr: 'T', destination_addr: '4477' + String(i).padStart(8, '0'), short_message: 'x', registered_delivery: 1 }, p => r(p.message_id)))));
  return s;
}

test('helpers: back-off grows to the cap with jitter; delay distributions; codes; heap order', () => {
  for (let f = 1; f <= 10; f++) {
    const d = Math.min(30000, 1000 * 2 ** (f - 1));
    for (let i = 0; i < 50; i++) { const b = backoff(f, 1000, 30000); assert.ok(b >= d / 2 && b <= d, `attempt ${f}: ${b}`); }
  }
  const spread = new Set(Array.from({ length: 50 }, () => Math.round(backoff(1, 1000, 30000)))); assert.ok(spread.size > 20, 'jitter spreads retries');
  const avg = (fn, n = 20000) => { let s = 0; for (let i = 0; i < n; i++) s += fn(); return s / n; };
  assert.equal(delaySampler('fixed', 1500, 500)(), 1500);
  const u = delaySampler('uniform', 3000, 1000); for (let i = 0; i < 1000; i++) { const v = u(); assert.ok(v >= 2000 && v <= 4000); }
  assert.ok(Math.abs(avg(delaySampler('normal', 3000, 500)) - 3000) < 50);
  assert.ok(Math.abs(avg(delaySampler('exponential', 2000, 0)) - 2000) < 100);
  assert.deepEqual([...parseCodes('0x14, 88,0X0b')], [0x14, 88, 0x0b]);
  const h = new MinHeap('due'); [5, 1, 3, 1, 2].forEach((due, n) => h.push({ due, n }));
  assert.deepEqual(Array.from({ length: 5 }, () => h.pop()).map(x => `${x.due}/${x.n}`), ['1/1', '1/3', '2/4', '3/2', '5/0']);
});

test('MSGQFUL is retried until delivered; a permanent error is not retried and is counted', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 0, dlrRetryMinMs: 100, dlrRetryMaxMs: 400, metricsPort: 0 }); await once(v, 'listening');
  t.after(() => v.stop());
  // First attempt of every DLR: MSGQFUL. DLR for the number ending in 0: permanent 0x0B.
  const tried = new Set();
  const g = await gateway(port, (n, p) => p.source_addr.endsWith('0') ? 0x0b : tried.has(p.receipted_message_id) ? 0 : (tried.add(p.receipted_message_id), 0x14));
  t.after(() => g.destroy());
  const ids = await g.submitN(50);
  assert.ok(await waitFor(() => v.D.pending === 0, 10000), `pending ${v.D.pending}`);
  const ok = new Set(g.got.filter(x => x.st === 0).map(x => x.rid));
  assert.equal(v.M.permanentFailed, 5, 'destination ending in 0: 5 of 50');
  assert.equal(ok.size, 45); assert.equal(v.M.rejectedByCode['0x14'], 45); assert.equal(v.M.rejectedByCode['0x0B'], 5);
  assert.equal(v.M.dropped, 0);
  assert.ok(ids.every(id => ok.has(id) || g.got.some(x => x.rid === id && x.st === 0x0b)));
});

test('retries of DLRs rejected together are spread out, not sent back in one burst', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 0, dlrRetryMinMs: 1000, dlrRetryMaxMs: 1000, metricsPort: 0 }); await once(v, 'listening');
  t.after(() => v.stop());
  const first = new Set();
  const g = await gateway(port, (n, p) => first.has(p.receipted_message_id) ? 0 : (first.add(p.receipted_message_id), 0x14));
  t.after(() => g.destroy());
  await g.submitN(400);
  assert.ok(await waitFor(() => v.D.pending === 0, 10000));
  const retries = g.got.filter(x => x.st === 0).map(x => x.at).sort((a, b) => a - b);
  const span = retries[retries.length - 1] - retries[0];
  assert.ok(span >= 300, `retries spread over ${span} ms (jitter over 0.5–1 s)`);
});

test('DLR rate limits: total and per bind', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 0, dlrMaxTps: 200, metricsPort: 0 }); await once(v, 'listening');
  t.after(() => v.stop());
  const g = await gateway(port);
  t.after(() => g.destroy());
  await g.submitN(400);
  const t0 = Date.now();
  assert.ok(await waitFor(() => g.got.length >= 400, 8000));
  const took = Date.now() - t0;
  assert.ok(took >= 1500 && took < 3500, `400 DLRs at 200/s took ${took} ms`);

  const port2 = freePort();
  const w = new MockSmsc();
  w.start({ port: port2, dlrDelay: 0, dlrMaxTpsPerBind: 100, metricsPort: 0 }); await once(w, 'listening');
  t.after(() => w.stop());
  const a = await gateway(port2), b = await gateway(port2);
  t.after(() => { a.destroy(); b.destroy(); });
  await a.submitN(400);
  const t1 = Date.now();
  assert.ok(await waitFor(() => a.got.length + b.got.length >= 400, 8000));
  const took2 = Date.now() - t1;
  assert.ok(took2 >= 1500 && took2 < 3500, `400 DLRs over 2 binds at 100/s each took ${took2} ms`);
  assert.ok(a.got.length > 100 && b.got.length > 100, 'both binds used');
});

test('DLR delay follows the configured distribution', async t => {
  const port = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 600, dlrDelayMode: 'uniform', dlrDelaySpread: 400, metricsPort: 0 }); await once(v, 'listening');
  t.after(() => v.stop());
  const g = await gateway(port);
  t.after(() => g.destroy());
  const t0 = Date.now();
  await g.submitN(300);
  assert.ok(await waitFor(() => g.got.length >= 300, 5000));
  const d = g.got.map(x => x.at - t0).sort((a, b) => a - b);
  assert.ok(d[0] >= 150 && d[d.length - 1] <= 1150, `delays ${d[0]}–${d[d.length - 1]} ms for 600 ± 400`);
  assert.ok(d[d.length - 1] - d[0] >= 500, 'spread out, not all at once');
});

test('metrics endpoint: counters, rates, latency, reset', async t => {
  const port = freePort(), mport = freePort();
  const v = new MockSmsc();
  v.start({ port, dlrDelay: 0, metricsPort: mport }); await once(v, 'listening');
  t.after(() => v.stop());
  const g = await gateway(port, n => n % 2 ? 0x14 : 0);
  t.after(() => g.destroy());
  await g.submitN(100);
  await waitFor(() => v.D.pending === 0, 10000);
  let { status, json } = await req(mport, 'GET', '/metrics');
  assert.equal(status, 200);
  assert.equal(json.submitted, 100); assert.equal(json.dlr.confirmed, 100); assert.ok(json.dlr.rejectedByCode['0x14'] > 0);
  assert.ok(json.submitResp.n === 100 && json.submitResp.p99 < 50, JSON.stringify(json.submitResp));
  for (const k of ['pending', 'notYetDue', 'ready', 'retryWaiting', 'inflight', 'dropped', 'permanentFailed', 'expired']) assert.ok(k in json.dlr, k);
  for (const k of ['cpuPct', 'heapMB', 'rssMB']) assert.ok(k in json.process, k);
  ({ json } = await req(mport, 'POST', '/metrics/reset'));
  assert.equal(json.ok, true); assert.equal(json.before.submitted, 100);
  ({ json } = await req(mport, 'GET', '/metrics'));
  assert.equal(json.submitted, 0); assert.equal(json.dlr.confirmed, 0); assert.deepEqual(json.dlr.rejectedByCode, {});
  assert.equal((await req(mport, 'GET', '/nope')).status, 404);
});

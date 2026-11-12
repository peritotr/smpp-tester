// Load engine against the mock vendor: throughput, end-to-end tracking, throttling, bind limits, analysis.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../ui/analysis.js');
const { startVendor, runLoad, freePort, sleep } = require('./helpers');

const BASE = { src: 'TEST', srcTon: 5, srcNpi: 0, dst: '4477009XXXXX', dstTon: 1, dstNpi: 1, text: 'Load test message', encoding: 'auto', dlr: true, dlrWait: 3, respTimeout: 5 };
const cfgFor = port => ({ host: '127.0.0.1', port, bindMode: 'trx', connectTimeout: 2 });

test('constant load with end-to-end tracking: nothing lost, nothing duplicated', async t => {
  const port = freePort();
  const v = await startVendor({ port, dlrDelay: 200, failRate: 0 });
  t.after(() => v.kill());
  const r = await runLoad(cfgFor(port), { ...BASE, sessions: 4, window: 200, tps: 2000, duration: 5, ramp: 1, e2e: true });
  assert.ok(r.done, 'test finished');
  const T = r.done.totals;
  assert.equal(T.err, 0);
  assert.equal(T.ok, T.sent);
  assert.ok(T.sent > 8000, `sent ${T.sent}`);
  assert.equal(T.dlr, T.ok, 'a DLR for every accepted message');
  await sleep(1200); // let the vendor publish its last stats
  assert.equal(v.e2e.n, T.ok, 'every accepted message reached the vendor');
  assert.equal(v.e2e.dup, 0);
});

test('throttling: the engine slows down and retries', async t => {
  const port = freePort();
  const v = await startVendor({ port, dlrDelay: 100, maxTps: 1000 });
  t.after(() => v.kill());
  const r = await runLoad(cfgFor(port), { ...BASE, sessions: 4, window: 200, tps: 2000, duration: 5, ramp: 0, retryThrottle: true });
  const T = r.done.totals;
  assert.ok(T.throttled > 0, 'throttle responses were received');
  assert.equal(T.retries, T.throttled, 'every throttled message was retried');
  assert.equal(T.err, 0);
  assert.ok(r.done.events.some(e => e.type === 'throttle'));
});

test('bind limit: continues with the sessions that bound', async t => {
  const port = freePort();
  const v = await startVendor({ port, maxBinds: 3 });
  t.after(() => v.kill());
  const r = await runLoad({ ...cfgFor(port), connectTimeout: 1 }, { ...BASE, sessions: 5, window: 50, tps: 500, duration: 2, ramp: 0 });
  assert.ok(r.done, 'test finished instead of hanging');
  assert.equal(r.done.totals.bound, 3);
  const bf = r.done.events.find(e => e.type === 'bindfail');
  assert.ok(bf);
  assert.deepEqual([bf.p.failed, bf.p.total, bf.p.ok], [2, 5, 3]);
});

test('step test: the analysis finds the saturation point', async t => {
  const port = freePort();
  const v = await startVendor({ port, dlrDelay: 100, capacity: 3000 });
  t.after(() => v.kill());
  const r = await runLoad(cfgFor(port), { ...BASE, sessions: 8, window: 300, tps: 5000, steps: { start: 1000, inc: 1000, dur: 4 }, ramp: 0, criteria: { p95Max: 100, minTps: 5000 } });
  const steps = r.done.events.filter(e => e.type === 'step').map(e => e.p.i);
  assert.deepEqual(steps, [1, 2, 3, 4, 5], 'one event per step, in order');
  const a = analyze(r.done);
  assert.equal(a.lastGood.target, 3000);
  assert.equal(a.knee.target, 4000);
  assert.equal(a.knee.status, 'saturated');
  assert.equal(a.saturation.cause, 'backpressure');
  assert.ok(a.onset, 'latency onset detected');
  assert.equal(a.verdict, 'fail');
});

test('window too small for the response time: rate held back, window advice with the gateway limit; steady TPS excludes the ramp-up', async t => {
  const port = freePort();
  const v = await startVendor({ port, respDelay: 100, dlrDelay: 0 });
  t.after(() => v.kill());
  // 2 sessions × window 10 at ~100 ms → at most ~200 TPS for a 400 TPS target; the gateway account allows 15
  const r = await runLoad(cfgFor(port), { ...BASE, dlr: false, sessions: 2, window: 10, gwWindow: 15, tps: 400, duration: 8, ramp: 2 });
  const T = r.done.totals, a = T.windowAdvice;
  assert.ok(a, 'window advice in the totals');
  assert.ok(a.need >= 20 && a.need <= 40, `needed window ${a.need}`);
  assert.equal(a.gwTooLow, true);
  const ev = r.done.events.filter(e => e.type === 'window').map(e => e.key);
  assert.ok(ev.some(k => /^Rate held back by the window/.test(k)));
  assert.ok(ev.some(k => /raise the gateway account's window setting too/.test(k)));
  assert.ok(T.steadyTps > 150 && T.steadyTps < 230, `steady ${T.steadyTps}`);
  assert.ok(analyze({ test: r.done.test, totals: T, series: r.done.series, events: r.done.events }).findings.some(f => /held back by the window/.test(f.text)));

  const r2 = await runLoad(cfgFor(port), { ...BASE, dlr: false, sessions: 2, window: 100, tps: 400, duration: 6, ramp: 2 });
  const T2 = r2.done.totals;
  assert.equal(T2.windowAdvice, undefined, 'no advice when the window is large enough');
  assert.ok(Math.abs(T2.steadyTps - 400) < 12, `steady ${T2.steadyTps}`);
  assert.ok(T2.avgTps < T2.steadyTps * 0.9, `average incl. ramp-up ${T2.avgTps}`);
});

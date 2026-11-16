// Load test over several worker threads (load-cluster.js), the fast PDU decoder, DLR receiver binds,
// and the split of latency into server time and client queue time.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDU } = require('smpp/lib/pdu');
const { LoadEngine } = require('../load-engine');
const { workerCount } = require('../load-cluster');
const { startVendor, runLoad, freePort, sleep } = require('./helpers');

const BASE = { src: 'TEST', srcTon: 5, srcNpi: 0, dst: '4477009XXXXX', dstTon: 1, dstNpi: 1, text: 'Load test message', encoding: 'auto', dlr: true, dlrWait: 5, respTimeout: 5 };
const cfgFor = port => ({ host: '127.0.0.1', port, bindMode: 'trx', connectTimeout: 2 });

test('fast deliver_sm decoder reads what the library encodes', () => {
  const pdu = new PDU('deliver_sm', { service_type: 'X', source_addr_ton: 1, source_addr_npi: 1, source_addr: '447700900123', dest_addr_ton: 5, dest_addr_npi: 0, destination_addr: 'TEST',
    esm_class: 4, registered_delivery: 0, data_coding: 0, short_message: 'id:ABC-1 sub:001 dlvrd:001 submit date:2611161200 done date:2611161200 stat:DELIVRD err:000 text:x',
    receipted_message_id: 'ABC-1', message_state: 2 });
  pdu.sequence_number = 77;
  const b = pdu.toBuffer(), d = new LoadEngine()._decodeDeliver(b, 16, b.length, 77);
  assert.equal(d.esm, 4); assert.equal(d.src, '447700900123'); assert.equal(d.rid, 'ABC-1'); assert.equal(d.state, 2);
  assert.match(d.sm.toString('latin1'), /stat:DELIVRD/);
});

test('worker count: setting, automatic, never more than the sessions; one engine for routing clients', () => {
  assert.equal(workerCount({ sessions: 12, workers: 3 }), 3);
  assert.equal(workerCount({ sessions: 2, workers: 6 }), 2);
  assert.equal(workerCount({ sessions: 12, workers: 20 }), 8);
  assert.equal(workerCount({ sessions: 12, workers: 4, clientTag: 1 }), 1);
  assert.ok(workerCount({ sessions: 12 }) >= 1);
});

test('two worker threads: every DLR matched across workers, no duplicate markers, latency split', async t => {
  const port = freePort();
  const v = await startVendor({ port, dlrDelay: 200, failRate: 0 });
  t.after(() => v.kill());
  const r = await runLoad(cfgFor(port), { ...BASE, sessions: 4, window: 200, tps: 2000, duration: 5, ramp: 1, workers: 2, e2e: true });
  assert.ok(r.done, 'finished');
  const T = r.done.totals;
  assert.equal(T.workers, 2);
  assert.equal(T.err, 0); assert.equal(T.ok, T.sent); assert.ok(T.sent > 8000, `sent ${T.sent}`);
  assert.equal(T.dlr, T.ok, 'a DLR for every message');
  assert.equal(T.dlrUnmatched, 0, 'DLRs that arrived on the other worker were matched');
  assert.equal(T.pendingDlr, 0); assert.equal(T.dlrLat.n, T.ok);
  assert.ok(T.lat.n === T.ok && T.qLat.n === T.ok, 'server latency and client queue per message');
  assert.ok(T.qLat.p95 < T.lat.p95 + 5);
  assert.ok(T.loop && T.loop.p99Max != null);
  const row = r.ticks.find(x => x.sentTps > 1000);
  for (const k of ['qP95', 'loopP99', 'elu', 'p95']) assert.ok(k in row, k);
  assert.ok(r.done.events.some(e => e.type === 'workers'));
  await sleep(1200);
  assert.equal(v.e2e.n, T.ok, 'every message reached the vendor');
  assert.equal(v.e2e.dup, 0, 'end-to-end markers unique across workers');
});

test('DLR receiver binds: sending binds as transmitters, DLRs on the receivers', async t => {
  const port = freePort();
  const v = await startVendor({ port, dlrDelay: 100, failRate: 0 });
  t.after(() => v.kill());
  const r = await runLoad(cfgFor(port), { ...BASE, sessions: 2, rxSessions: 1, window: 100, tps: 500, duration: 3, ramp: 0, workers: 1 });
  const T = r.done.totals;
  assert.equal(T.err, 0); assert.ok(T.ok > 1200);
  assert.equal(T.dlr, T.ok); assert.equal(T.dlrUnmatched, 0);
});

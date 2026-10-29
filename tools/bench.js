// Command-line throughput benchmark: load engine → built-in mock vendor, both on this machine.
// Usage: node tools/bench.js [tps=10000] [seconds=15] [sessions=8] [window=500] [vendorTpsLimit=0]
// Set TEXT="..." to change the message (e.g. a non-GSM text to exercise UCS-2).
const { fork } = require('child_process');
const path = require('path');
const [tps = 10000, dur = 15, sess = 8, win = 500, maxTps = 0] = process.argv.slice(2).map(Number);
const port = 12800 + Math.floor(Math.random() * 100);
const mock = fork(path.join(__dirname, '..', 'mock-worker.js'));
const load = fork(path.join(__dirname, '..', 'load-worker.js'));
let lastMock = {};
mock.on('message', m => { if (m.type === 'log' || m.type === 'error') console.log('[vendor]', m.text); if (m.type === 'stats') lastMock = m.stats; });
mock.send({ type: 'start', opts: { port, dlrDelay: 500, failRate: 0.02, maxTps, stateDir: process.env.STATE_DIR || '' } }); // STATE_DIR=… to include the DLR journal
setTimeout(() => load.send({ type: 'start', cfg: { host: '127.0.0.1', port, systemId: 'bench', password: 'bench', bindMode: 'trx' },
  test: { sessions: sess, window: win, tps, duration: dur, ramp: 2, dlr: true, dlrWait: 5, respTimeout: 5,
          src: 'BENCH', srcTon: 5, srcNpi: 0, dst: '4477009XXXXX', dstTon: 1, dstNpi: 1, text: process.env.TEXT || 'Benchmark message 123', encoding: 'auto', e2e: true } }), 500);
load.on('message', m => {
  if (m.type === 'tick') {
    const r = m.row, f = v => v == null ? '—' : v.toFixed(1);
    console.log(`t=${String(r.t).padStart(3)} sent=${r.sentTps.toFixed(0).padStart(6)} ok=${r.okTps.toFixed(0).padStart(6)} thr=${r.thrTps.toFixed(0).padStart(5)} dlr=${r.dlrTps.toFixed(0).padStart(6)} inflight=${String(r.inflight).padStart(5)} p50=${f(r.p50)} p95=${f(r.p95)} p99=${f(r.p99)} ms | vendor rx=${lastMock.rx} e2e p95=${f(lastMock.e2e?.sec?.p95)}`);
  } else if (m.type === 'done') {
    const t = m.totals;
    console.log('\nRESULT', JSON.stringify({ sent: t.sent, ok: t.ok, err: t.err, throttled: t.throttled, retries: t.retries, timeouts: t.timeouts, dlr: t.dlr, avgTps: Math.round(t.avgTps), secs: +t.secs.toFixed(1), p50: +t.lat.p50.toFixed(1), p95: +t.lat.p95.toFixed(1), p99: +t.lat.p99.toFixed(1) }));
    setTimeout(() => { console.log('VENDOR', JSON.stringify({ received: lastMock.e2e?.n, duplicates: lastMock.e2e?.dup, e2eP95: lastMock.e2e?.total?.p95 })); mock.kill(); load.kill(); }, 1200);
  } else console.log('[load]', m.type, m.text || '');
});

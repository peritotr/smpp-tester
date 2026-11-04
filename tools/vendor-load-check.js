// Load check for the built-in vendor as a gateway sees it: the load engine plays the gateway (10 binds, window 200),
// the vendor runs in its own process with the DLR journal on, like in the apps.
//   node tools/vendor-load-check.js [tps=8000] [seconds=600] [rejectEvery=0] [dlrWaitSeconds=180]
// rejectEvery=3 answers every third DLR with ESME_RMSGQFUL (0x14), like a gateway under journal pressure.
// Env: SESSIONS (10), WINDOW (200), DLR_DELAY (vendor dlrDelay, default 1500), METRICS_PORT (vendor metrics, if supported)
// Pass: submit_sm_resp p99 < 50 ms (whole run, as the client measures it), every accepted message got its DLR, nothing dropped.
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const [TPS = 8000, DUR = 600, REJECT = 0, WAIT = 180] = process.argv.slice(2).map(Number);
const SESSIONS = Number(process.env.SESSIONS || 10), WINDOW = Number(process.env.WINDOW || 200);
const root = path.join(__dirname, '..');
const port = 14000 + Math.floor(Math.random() * 1000), metricsPort = Number(process.env.METRICS_PORT || 0) || port + 1000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-load-'));
const mock = fork(path.join(root, 'mock-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const load = fork(path.join(root, 'load-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
let V = {}, rows = [], lastPrint = 0;
const vendorOpts = { port, dlrDelay: process.env.DLR_DELAY || 1500, failRate: 0, stateDir: dir, metricsPort, metricsLog: true };
mock.on('message', m => { if (m.type === 'stats') V = m.stats; else if (m.type === 'log' && !/^\[metrics\]/.test(m.text || '')) console.log('[vendor]', m.text); });
mock.send({ type: 'start', opts: vendorOpts });
const f = (v, d = 1) => v == null || isNaN(v) ? '—' : Number(v).toFixed(d);

function metrics() {
  return new Promise(res => http.get({ host: '127.0.0.1', port: metricsPort, path: '/metrics' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }).on('error', () => res(null)));
}

setTimeout(() => load.send({ type: 'start', cfg: { host: '127.0.0.1', port, systemId: 'gateway', password: 'x', bindMode: 'trx' },
  test: { sessions: SESSIONS, window: WINDOW, tps: TPS, duration: DUR, ramp: 5, dlr: true, dlrWait: WAIT, respTimeout: 10, dlrRejectEvery: REJECT, dlrRejectStatus: 0x14,
          src: 'LOAD', srcTon: 5, srcNpi: 0, dst: '4477009XXXXX', dstTon: 1, dstNpi: 1, text: 'Load check message 123', encoding: 'auto' } }), 800);

load.on('message', async m => {
  if (m.type === 'tick') {
    rows.push(m.row);
    const r = m.row;
    if (r.t - lastPrint >= 5) {
      lastPrint = r.t;
      const w = rows.slice(-5), avg = k => w.reduce((a, x) => a + (x[k] || 0), 0) / w.length, mx = k => Math.max(...w.map(x => x[k] || 0));
      console.log(`t=${String(r.t).padStart(4)} submit ${f(avg('sentTps'), 0).padStart(5)}/s resp p50 ${f(avg('p50'))} p99(max/s) ${f(mx('p99'))} ms | DLR in ${f(avg('dlrTps'), 0).padStart(5)}/s | vendor pending ${V.dlrPending ?? '—'} retry ${V.dlrRetryWaiting ?? '—'} dropped ${V.dlrDropped ?? 0} permFail ${V.dlrPermanentFailed ?? 0}`);
    }
  } else if (m.type === 'done') {
    const T = m.totals;
    await new Promise(r => setTimeout(r, 1500));
    const met = await metrics();
    const lat = T.lat, drops = (V.dlrDropped || 0), pending = V.dlrPending;
    const worst = Math.max(...rows.filter(r => r.sentTps > 0).map(r => r.p99 || 0));
    const ok = lat.p99 < 50 && T.dlr >= T.ok && !drops && !pending;
    console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${TPS} TPS × ${DUR} s, ${SESSIONS} binds × window ${WINDOW}${REJECT ? `, every ${REJECT}rd DLR rejected with MSGQFUL` : ''}`);
    console.log(`  submit_sm_resp (client): p50 ${f(lat.p50)} · p95 ${f(lat.p95)} · p99 ${f(lat.p99)} · max ${f(lat.max)} ms · worst 1-s p99 ${f(worst)} ms`);
    console.log(`  submitted ${T.sent} · accepted ${T.ok} · throttled ${T.throttled} · timeouts ${T.timeouts} · avg ${Math.round(T.avgTps)}/s`);
    console.log(`  DLRs received ${T.dlr} of ${T.ok} · rejected by the client ${T.dlrRejected || 0} · vendor: pending ${pending} · dropped ${drops} · permanent failures ${V.dlrPermanentFailed || 0} · expired ${V.dlrExpired || 0}`);
    if (met) console.log('  vendor metrics:', JSON.stringify({ submitResp: met.submitResp, rejectedByCode: met.dlr && met.dlr.rejectedByCode, cpu: met.process && met.process.cpuPct, heapMB: met.process && met.process.heapMB }));
    mock.kill('SIGTERM'); load.kill();
    setTimeout(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(ok ? 0 : 1); }, 800);
  } else if (m.type === 'phase' && m.phase === 'error') { console.error('load error', m.text); process.exit(2); }
});

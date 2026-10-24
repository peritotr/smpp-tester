// Step test against a capacity-limited mock vendor, then prints the analysis the report page would show.
// The report should find the step where the platform (here: the vendor) saturates.
// Usage: node tools/report-demo.js [vendorCapacity=6000] [maxTps=10000] [increment=1000] [stepSeconds=6]
//        (increment 0 = constant test of stepSeconds at maxTps)
const { fork } = require('child_process');
const path = require('path');
const { analyze } = require('../ui/analysis.js');
const [cap = 6000, max = 10000, inc = 1000, dur = 6] = process.argv.slice(2).map(Number);
const constant = inc === 0;
const port = 13100 + Math.floor(Math.random() * 100);
const mock = fork(path.join(__dirname, '..', 'mock-worker.js'));
const load = fork(path.join(__dirname, '..', 'load-worker.js'));
let e2e = null;
mock.on('message', m => { if (m.type === 'stats' && m.stats.e2e.n) e2e = m.stats.e2e; });
mock.send({ type: 'start', opts: { port, dlrDelay: 300, capacity: cap } });
setTimeout(() => load.send({ type: 'start', cfg: { host: '127.0.0.1', port, bindMode: 'trx' },
  test: { sessions: 8, window: 300, tps: max, steps: constant ? null : { start: inc, inc, dur }, duration: constant ? dur : 0, ramp: constant ? 5 : 0,
          dlr: true, dlrWait: 3, respTimeout: 10, e2e: true, criteria: { p95Max: 100, errMaxPct: 0.1, lossMaxPct: 0, minTps: max },
          src: 'DEMO', srcTon: 5, srcNpi: 0, dst: '4477009XXXXX', dstTon: 1, dstNpi: 1, text: 'Report demo' } }), 500);
load.on('message', m => {
  if (m.type === 'tick') { const r = m.row; console.log(`t=${r.t} target=${r.target} ok=${Math.round(r.okTps)} p95=${r.p95?.toFixed(1)} windowFull=${r.windowFull}`); }
  if (m.type === 'done') setTimeout(() => {
    const a = analyze({ ...m, vendor: { e2e } });
    if (a.steps) { console.log('\nSTEPS'); for (const s of a.steps) console.log(s.step, s.target, Math.round(s.ok), s.p95?.toFixed(1), s.status); }
    console.log('\nFINDINGS'); for (const f of a.findings) console.log(`[${f.level}] ${f.text}`);
    console.log('\nVERDICT', a.verdict, JSON.stringify(a.criteria));
    mock.kill(); load.kill();
  }, 1500);
});

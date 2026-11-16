// Worker thread for a sharded load test: one LoadEngine with a share of the sessions and of the target TPS.
// Talks to the coordinator (load-cluster.js) over parentPort.
const { parentPort } = require('worker_threads');
const { LoadEngine } = require('./load-engine');

const e = new LoadEngine();
for (const ev of ['phase', 'tick', 'done', 'log', 'ready', 'dlrBatch']) e.on(ev, d => parentPort.postMessage({ type: ev, d }));
parentPort.on('message', m => {
  if (m.type === 'start') e.start(m.cfg, m.test).catch(x => parentPort.postMessage({ type: 'phase', d: { phase: 'error', text: x.message, key: x.key, p: x.p } }));
  else if (m.type === 'go') e.go();
  else if (m.type === 'stop') e.stop();
  else if (m.type === 'dlrDone') e.dlrDone();
});
process.on('uncaughtException', x => parentPort.postMessage({ type: 'log', d: { text: 'Error: ' + x.message } }));

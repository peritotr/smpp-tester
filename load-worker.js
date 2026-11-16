// Child process that hosts the load test; talks to the web server or the desktop app over IPC.
// One engine in this process, or several engines in worker threads (load-cluster.js) when the test asks for it.
const { LoadEngine } = require('./load-engine');
const { LoadCluster, workerCount } = require('./load-cluster');
let engine = null;
const send = require('./ipc-child')(async m => {
  try {
    if (m.type === 'start') {
      if (engine && engine.running) throw new Error('A test is already running');
      const n = workerCount(m.test || {});
      engine = n > 1 ? new LoadCluster(n) : new LoadEngine();
      for (const ev of ['phase', 'tick', 'done', 'log']) engine.on(ev, d => send({ type: ev, ...(typeof d === 'object' ? d : { text: d }) }));
      await engine.start(m.cfg, m.test);
    } else if (m.type === 'stop') engine && engine.stop();
  } catch (e) { if (engine) engine.running = false; send({ type: 'phase', phase: 'error', text: e.message, key: e.key, p: e.p }); }
});
process.on('uncaughtException', e => send({ type: 'log', text: 'Error: ' + e.message }));

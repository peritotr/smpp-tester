// Child process that hosts the load test; talks to the web server or the desktop app over IPC.
// One engine in this process, or several engines in worker threads (load-cluster.js) when the test asks for it.
// With per-message records on, the records are summarised (duplicate and missing DLRs) before the result goes out.
const { LoadEngine } = require('./load-engine');
const { LoadCluster, workerCount } = require('./load-cluster');
const { summarize } = require('./records');
let engine = null;
const runId = sid => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${String(sid || 'x').replace(/[^\w.-]+/g, '_').slice(0, 32)}-${Math.random().toString(36).slice(2, 6)}`; };
const send = require('./ipc-child')(async m => {
  try {
    if (m.type === 'start') {
      if (engine && engine.running) throw new Error('A test is already running');
      const test = { ...(m.test || {}) };
      if (test.record && test.recordDir && !test.recordRun) test.recordRun = runId(m.cfg && m.cfg.systemId);
      const n = workerCount(test);
      engine = n > 1 ? new LoadCluster(n) : new LoadEngine();
      for (const ev of ['tick', 'log']) engine.on(ev, d => send({ type: ev, ...(typeof d === 'object' ? d : { text: d }) }));
      // "done" goes out after the result (the records summary may take a moment)
      engine.on('phase', d => { if (d.phase !== 'done') send({ type: 'phase', ...d }); });
      engine.on('done', async d => {
        if (d.records) {
          send({ type: 'phase', phase: 'draining', key: 'Summarising the per-message records…', text: 'Summarising the per-message records…' });
          try { d.totals.records = { ...(await summarize(d.records.dir, d.records.run, { dlr: !!test.dlr })), rows: d.records.rows }; }
          catch (e) { d.totals.records = { run: d.records.run, error: e.message }; }
        }
        send({ type: 'done', ...d });
        send({ type: 'phase', phase: 'done', key: 'Done', text: 'Done' });
      });
      await engine.start(m.cfg, test);
    } else if (m.type === 'stop') engine && engine.stop();
  } catch (e) { if (engine) engine.running = false; send({ type: 'phase', phase: 'error', text: e.message, key: e.key, p: e.p }); }
});
process.on('uncaughtException', e => send({ type: 'log', text: 'Error: ' + e.message }));

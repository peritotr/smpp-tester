// Child process that hosts the load engine; talks to the web server or the desktop app over IPC.
const { LoadEngine } = require('./load-engine');
const engine = new LoadEngine();
const send = require('./ipc-child')(async m => {
  try {
    if (m.type === 'start') await engine.start(m.cfg, m.test);
    else if (m.type === 'stop') engine.stop();
  } catch (e) { engine.running = false; send({ type: 'phase', phase: 'error', text: e.message, key: e.key, p: e.p }); }
});
for (const ev of ['phase', 'tick', 'done', 'log']) engine.on(ev, d => send({ type: ev, ...(typeof d === 'object' ? d : { text: d }) }));
process.on('uncaughtException', e => send({ type: 'log', text: 'Error: ' + e.message }));

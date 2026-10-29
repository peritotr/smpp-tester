// Child process that hosts the mock vendor SMSC; talks to the web server or the desktop app over IPC.
const { MockSmsc } = require('./mock-smsc');
const mock = new MockSmsc();
const send = require('./ipc-child')(m => {
  try {
    if (m.type === 'start') mock.start(m.opts);
    else if (m.type === 'stop') { mock.stop(); send({ type: 'stopped' }); }
    else if (m.type === 'reset') mock.resetE2e();
    else if (m.type === 'mo') send({ type: 'mo', n: mock.sendMo(m.text, m.from, m.to) });
    else if (m.type === 'msgs') send({ type: 'msgs', rid: m.rid, data: mock.listMsgs(m.q, m.limit) });
    else if (m.type === 'msgsClear') mock.clearMsgs();
  } catch (e) { send({ type: 'error', text: e.message }); }
});
// Messages are { key, p, text } objects so the UI can translate them
mock.on('listening', () => send({ type: 'started' }));
mock.on('listenError', m => send({ type: 'error', msg: m, text: m.text }));
mock.on('log', m => send({ type: 'log', msg: m, text: m.text }));
mock.on('stats', s => send({ type: 'stats', stats: s }));
process.on('uncaughtException', e => send({ type: 'error', text: e.message }));
// Stopped by the app or server (kill): close the DLR journal cleanly so nothing pending is lost
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { mock.stop(); } catch {} process.exit(0); });
process.on('disconnect', () => { try { mock.stop(); } catch {} });

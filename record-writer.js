// Worker thread for per-message records (records.js): gzips and appends the lines the engine hands over, so the
// engine's event loop never compresses or writes to disk itself.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const zlib = require('zlib');

const out = new Map(); // file → { gz, done }
function stream(file) {
  let s = out.get(file);
  if (!s) {
    const gz = zlib.createGzip({ level: 3 }), ws = fs.createWriteStream(file);
    gz.pipe(ws);
    s = { gz, done: new Promise(r => ws.on('close', r)) };
    out.set(file, s);
  }
  return s;
}
parentPort.on('message', async m => {
  if (m.t === 'w') stream(m.file).gz.write(m.s);
  else if (m.t === 'close') {
    for (const s of out.values()) s.gz.end();
    await Promise.all([...out.values()].map(s => s.done));
    out.clear();
    parentPort.postMessage({ t: 'closed' });
  }
});

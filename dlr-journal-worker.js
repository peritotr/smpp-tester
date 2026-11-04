// Worker thread for the DLR journal: appends what the vendor hands over and compacts the file when it has grown well
// past the live records, without ever blocking the vendor's event loop. See dlr-journal.js.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const { file, flag } = workerData;
let fd = fs.openSync(file, 'a');
let lines = workerData.live || 0, live = workerData.live || 0;

function compact() {
  fs.fsyncSync(fd); fs.closeSync(fd);
  // Replay the file in chunks: keep the last line of every key that was not removed
  const keep = new Map(), buf = Buffer.allocUnsafe(8 << 20), rfd = fs.openSync(file, 'r'); let rest = '';
  for (;;) {
    const n = fs.readSync(rfd, buf, 0, buf.length, null); if (!n) break;
    const parts = (rest + buf.toString('latin1', 0, n)).split('\n'); rest = parts.pop();
    for (const l of parts) {
      if (!l) continue;
      const t = l.indexOf('\t', 2), k = t < 0 ? l.slice(2) : l.slice(2, t);
      if (l.charCodeAt(0) === 68) keep.delete(k); else keep.set(k, l);
    }
  }
  fs.closeSync(rfd);
  const tmp = file + '.tmp', w = fs.openSync(tmp, 'w');
  let chunk = [];
  for (const l of keep.values()) { chunk.push(l); if (chunk.length >= 5000) { fs.writeSync(w, chunk.join('\n') + '\n'); chunk = []; } }
  if (chunk.length) fs.writeSync(w, chunk.join('\n') + '\n');
  fs.fsyncSync(w); fs.closeSync(w);
  fs.renameSync(tmp, file);
  fd = fs.openSync(file, 'a');
  lines = live = keep.size;
}

parentPort.on('message', m => {
  if (m.t === 'w') {
    fs.writeSync(fd, m.s);
    lines += m.n; live += m.a - m.d;
    if (lines > Math.max(200000, live * 4)) compact();
  } else if (m.t === 'close') {
    try { fs.fsyncSync(fd); fs.closeSync(fd); } catch {}
    Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
  }
});

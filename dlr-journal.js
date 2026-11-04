// Append-only journal that keeps the built-in vendor's undelivered DLRs across restarts.
// Each DLR is written once when it is created and once more when it is done with: confirmed by a deliver_sm_resp
// status 0, failed permanently, expired or dropped ("D"). On start the journal is replayed: whatever was added and
// never removed is still pending.
//
// While the vendor runs, all file work (appending and compaction) happens in a worker thread
// (dlr-journal-worker.js): the event loop that answers submit_sm only hands it lines, so disk I/O and compaction can
// never delay a submit_sm_resp. Loading at start-up is synchronous; it runs once, before the port opens.
//
// Line formats (tab separated; sid, id, src, dst URI-encoded):
//   B k sid created due n id src srcTon srcNpi dst dstTon dstNpi fail     (current)
//   A k sid created due n id body-base64                                  (1.6.0, still read)
//   D k
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const enc = encodeURIComponent, dec = decodeURIComponent;

function parseLine(line) {
  const f = line.split('\t');
  if (f[0] === 'B' && f.length >= 14) return { k: f[1], sid: dec(f[2]), created: Number(f[3]), due: Number(f[4]), n: Number(f[5]), id: dec(f[6]), src: dec(f[7]), srcTon: Number(f[8]), srcNpi: Number(f[9]), dst: dec(f[10]), dstTon: Number(f[11]), dstNpi: Number(f[12]), fail: f[13] === '1' };
  if (f[0] === 'A' && f.length >= 8) return { k: f[1], sid: dec(f[2]), created: Number(f[3]), due: Number(f[4]), n: Number(f[5]), id: dec(f[6]), body: Buffer.from(f[7], 'base64') };
  return null;
}

function line(r) {
  if (r.body) return `A\t${r.k}\t${enc(r.sid)}\t${r.created}\t${r.due}\t${r.n}\t${enc(r.id)}\t${r.body.toString('base64')}\n`;
  return `B\t${r.k}\t${enc(r.sid)}\t${r.created}\t${Math.round(r.due)}\t${r.n}\t${enc(r.id)}\t${enc(r.src)}\t${r.srcTon}\t${r.srcNpi}\t${enc(r.dst)}\t${r.dstTon}\t${r.dstNpi}\t${r.fail ? 1 : 0}\n`;
}

// Live records in creation order. Reads in chunks so a large file never becomes one giant string.
function load(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const live = new Map(), buf = Buffer.allocUnsafe(8 << 20); let rest = '';
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break;
      const parts = (rest + buf.toString('latin1', 0, n)).split('\n'); rest = parts.pop();
      for (const l of parts) {
        if (!l) continue;
        if (l.charCodeAt(0) === 68 /* D */) { live.delete(l.slice(2)); continue; }
        const r = parseLine(l); if (r) live.set(r.k, r); // anything else: a half-written last line after a crash
      }
    }
  } finally { fs.closeSync(fd); }
  return [...live.values()].sort((a, b) => a.n - b.n);
}

// Rewrite the file with just these records (start-up only; while running the worker compacts)
function rewrite(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp', fd = fs.openSync(tmp, 'w');
  let chunk = [];
  for (const r of records) { chunk.push(line(r)); if (chunk.length >= 5000) { fs.writeSync(fd, chunk.join('')); chunk = []; } }
  if (chunk.length) fs.writeSync(fd, chunk.join(''));
  fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

// The running vendor's side: collects lines and hands them to the worker thread once per tick
class JournalWriter {
  constructor(file, live) {
    this.buf = []; this.adds = 0; this.dels = 0;
    this.flag = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(path.join(__dirname, 'dlr-journal-worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), { workerData: { file, flag: this.flag, live } });
    this.worker.on('error', e => { this.error = e; });
    this.worker.unref();
  }
  add(r) { this.buf.push(line(r)); this.adds++; }
  remove(k) { this.buf.push(`D\t${k}\n`); this.dels++; }
  flush() {
    if (!this.buf.length || !this.worker) return;
    this.worker.postMessage({ t: 'w', s: this.buf.join(''), n: this.buf.length, a: this.adds, d: this.dels });
    this.buf = []; this.adds = 0; this.dels = 0;
  }
  // Blocks until the worker has written and synced everything (bounded), so a restart reads a complete file
  close(timeoutMs = 15000) {
    if (!this.worker) return;
    this.flush();
    this.worker.postMessage({ t: 'close' });
    Atomics.wait(this.flag, 0, 0, timeoutMs);
    this.worker.terminate(); this.worker = null;
  }
}

module.exports = { load, rewrite, line, parseLine, JournalWriter };

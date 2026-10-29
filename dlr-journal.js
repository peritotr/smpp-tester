// Append-only journal that keeps the built-in vendor's undelivered DLRs across restarts.
// Each DLR is written once when it is created ("A") and once more when the client confirmed it with a
// deliver_sm_resp status 0, or when it expired / was dropped ("D"). On start the journal is replayed:
// whatever was added and never removed is still pending. The file is rewritten with only the live records
// on start and whenever it has grown well past them, so it stays small.
//
// Line format (tab separated, sid and id URI-encoded):  A k sid created due n id body-base64   |   D k
const fs = require('fs');
const path = require('path');

class DlrJournal {
  constructor(file) { this.file = file; this.fd = null; this.buf = []; this.lines = 0; }

  // → [{ k, sid, created, due, n, id, body }] in creation order (live records only)
  load() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'latin1'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const live = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const f = line.split('\t');
      if (f[0] === 'A' && f.length >= 8) live.set(f[1], { k: f[1], sid: decodeURIComponent(f[2]), created: Number(f[3]), due: Number(f[4]), n: Number(f[5]), id: decodeURIComponent(f[6]), body: Buffer.from(f[7], 'base64') });
      else if (f[0] === 'D') live.delete(f[1]);
      // anything else is a half-written last line after a crash: ignored
    }
    return [...live.values()].sort((a, b) => a.n - b.n);
  }

  static line(r) { return `A\t${r.k}\t${encodeURIComponent(r.sid)}\t${r.created}\t${r.due}\t${r.n}\t${encodeURIComponent(r.id)}\t${r.body.toString('base64')}\n`; }

  // Rewrite the file with just these records, then keep appending to it
  rewrite(records) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.close();
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    let chunk = [];
    for (const r of records) { chunk.push(DlrJournal.line(r)); if (chunk.length >= 5000) { fs.writeSync(fd, chunk.join('')); chunk = []; } }
    if (chunk.length) fs.writeSync(fd, chunk.join(''));
    fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, this.file);
    this.fd = fs.openSync(this.file, 'a');
    this.lines = 0; this.liveAtRewrite = records.length || 0;
  }

  add(r) { this.buf.push(DlrJournal.line(r)); }
  remove(k) { this.buf.push(`D\t${k}\n`); }

  // Called every tick: one write for everything queued since the last one
  flush() {
    if (!this.buf.length || this.fd == null) return;
    const s = this.buf.join(''); this.lines += this.buf.length; this.buf = [];
    fs.writeSync(this.fd, s);
  }
  needsCompaction(live) { return this.lines > Math.max(200000, live * 4); }

  close() {
    if (this.fd == null) return;
    try { this.flush(); fs.fsyncSync(this.fd); } catch {}
    try { fs.closeSync(this.fd); } catch {}
    this.fd = null;
  }
}

module.exports = { DlrJournal };

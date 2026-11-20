// Per-message records of a load test: one row per submit (with the message_id from submit_sm_resp) and one row
// per DLR received, gzipped CSV in <dir>/<run>-<worker>-submits.csv.gz and …-dlrs.csv.gz. Writing happens in a
// worker thread (record-writer.js); the engine only joins lines and posts them every 250 ms.
// After the test, summarize() reads them back and writes the duplicate-DLR and missing-DLR lists.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { Worker } = require('worker_threads');

const SUBMIT_COLS = ['sent_utc', 'system_id', 'session', 'dest_addr', 'message_id', 'resp_utc', 'status', 'sequence'];
const DLR_COLS = ['received_utc', 'system_id', 'session', 'receipted_message_id', 'text_id', 'message_state', 'stat', 'err', 'submit_date', 'done_date', 'source_addr', 'dest_addr', 'sequence'];
const DUP_COLS = ['receipted_message_id', 'count', 'arrivals_utc', 'stats', 'sessions', 'system_id', 'submit_sent_utc', 'submit_dest_addr', 'submit_session'];
const MISSING_COLS = ['message_id', 'sent_utc', 'system_id', 'session', 'dest_addr'];
const UNMATCHED_COLS = ['receipted_message_id', 'received_utc', 'stat', 'session', 'system_id'];
const HEADERS = { submits: SUBMIT_COLS, dlrs: DLR_COLS, duplicates: DUP_COLS, missing: MISSING_COLS, unmatched: UNMATCHED_COLS };

const csv = v => { if (typeof v === 'number') return String(v); v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const iso = ms => new Date(ms).toISOString();

class Recorder {
  // dir: folder; run: test id; part: worker number (1 for a single engine)
  constructor(dir, run, part) {
    fs.mkdirSync(dir, { recursive: true });
    this.files = { submits: path.join(dir, `${run}-w${part}-submits.csv.gz`), dlrs: path.join(dir, `${run}-w${part}-dlrs.csv.gz`) };
    this.buf = { submits: [], dlrs: [] }; this.rows = { submits: 0, dlrs: 0 };
    this.w = new Worker(path.join(__dirname, 'record-writer.js'));
    this.w.unref();
    this.timer = setInterval(() => this.flush(), 250);
  }
  submit(a) { this.buf.submits.push(a.map(csv).join(',') + '\n'); this.rows.submits++; }
  dlr(a) { this.buf.dlrs.push(a.map(csv).join(',') + '\n'); this.rows.dlrs++; }
  flush() {
    for (const k of ['submits', 'dlrs']) if (this.buf[k].length) { this.w.postMessage({ t: 'w', file: this.files[k], s: this.buf[k].join('') }); this.buf[k] = []; }
  }
  // Everything written and the files closed
  close() {
    clearInterval(this.timer); this.flush();
    return new Promise(res => {
      const timer = setTimeout(res, 60000);
      this.w.once('message', () => { clearTimeout(timer); this.w.terminate(); res(); });
      this.w.postMessage({ t: 'close' });
    });
  }
}

// Lines of all of a run's files of one kind (submits / dlrs), parsed as arrays
async function* rows(dir, run, kind) {
  const files = fs.readdirSync(dir).filter(f => f.startsWith(run + '-') && f.endsWith(`-${kind}.csv.gz`)).sort();
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) if (line) yield parseCsv(line);
  }
}
function parseCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}

// Ids in DLRs may differ in letter case or be decimal for a hex id: try those forms
function findId(map, id) {
  if (map.has(id)) return id;
  for (const a of [id.toUpperCase(), id.toLowerCase()]) if (map.has(a)) return a;
  if (/^\d+$/.test(id)) { try { const h = BigInt(id).toString(16); for (const a of [h, h.toUpperCase()]) if (map.has(a)) return a; } catch {} }
  return null;
}

// Read a run's records back: duplicates (same receipted_message_id more than once), submits that never got a DLR,
// DLRs that match no submit. Writes <run>-duplicates / -missing / -unmatched .csv.gz and returns the counts.
async function summarize(dir, run, { dlr = true } = {}) {
  const S = col => SUBMIT_COLS.indexOf(col), D = col => DLR_COLS.indexOf(col);
  const subs = new Map(); let submits = 0, accepted = 0;
  for await (const r of rows(dir, run, 'submits')) {
    submits++;
    if (r[S('status')] !== '0x00000000' || !r[S('message_id')]) continue;
    accepted++;
    subs.set(r[S('message_id')], [r[S('sent_utc')], r[S('system_id')], r[S('session')], r[S('dest_addr')]]);
  }
  const seen = new Map(); let dlrs = 0;
  const unmatched = zlib.createGzip(), unmatchedFile = path.join(dir, `${run}-unmatched.csv.gz`), uw = fs.createWriteStream(unmatchedFile); unmatched.pipe(uw);
  let unmatchedN = 0;
  for await (const r of rows(dir, run, 'dlrs')) {
    dlrs++;
    const raw = r[D('receipted_message_id')] || r[D('text_id')];
    const id = raw && (findId(subs, raw) || raw);
    if (!id) continue;
    let e = seen.get(id);
    if (!e) seen.set(id, e = { n: 0, at: [], stat: [], sess: [], sid: r[D('system_id')] });
    e.n++; e.at.push(r[D('received_utc')]); e.stat.push(r[D('stat')] || r[D('message_state')]); e.sess.push(r[D('session')]);
    if (e.n === 1 && !subs.has(id)) { unmatchedN++; unmatched.write([id, r[D('received_utc')], r[D('stat')], r[D('session')], r[D('system_id')]].map(csv).join(',') + '\n'); }
  }
  unmatched.end(); await new Promise(r => uw.on('close', r));

  const dupFile = path.join(dir, `${run}-duplicates.csv.gz`), dg = zlib.createGzip(), dw = fs.createWriteStream(dupFile); dg.pipe(dw);
  let dupIds = 0, extra = 0; const examples = [];
  for (const [id, e] of seen) {
    if (e.n < 2) continue;
    dupIds++; extra += e.n - 1;
    const s = subs.get(id) || [];
    const row = [id, e.n, e.at.join(' | '), e.stat.join(' | '), e.sess.join(' | '), e.sid, s[0], s[3], s[2]];
    dg.write(row.map(csv).join(',') + '\n');
    if (examples.length < 20) examples.push({ id, n: e.n, at: e.at, stat: e.stat, sess: e.sess, sent: s[0] || null, dst: s[3] || null });
  }
  dg.end(); await new Promise(r => dw.on('close', r));

  const missFile = path.join(dir, `${run}-missing.csv.gz`), mg = zlib.createGzip(), mw = fs.createWriteStream(missFile); mg.pipe(mw);
  let missing = 0;
  if (dlr) for (const [id, s] of subs) if (!seen.has(id)) { missing++; mg.write([id, s[0], s[1], s[2], s[3]].map(csv).join(',') + '\n'); }
  mg.end(); await new Promise(r => mw.on('close', r));

  return { run, submits, accepted, dlrs, uniqueDlrs: seen.size, duplicateIds: dupIds, extraDlrs: extra, missing, unmatched: unmatchedN, examples };
}

// File list of a run for downloads: kind → files (submits/dlrs may be one per worker thread)
function runFiles(dir, run, kind) {
  if (!/^[\w.-]+$/.test(String(run)) || !HEADERS[kind]) return [];
  try { return fs.readdirSync(dir).filter(f => f.startsWith(run + '-') && f.endsWith(`-${kind}.csv.gz`)).sort().map(f => path.join(dir, f)); } catch { return []; }
}
function removeRun(dir, run) {
  if (!/^[\w.-]+$/.test(String(run))) return;
  try { for (const f of fs.readdirSync(dir)) if (f.startsWith(run + '-')) fs.unlinkSync(path.join(dir, f)); } catch {}
}
// Stream a run's files of one kind as one plain CSV (header + rows)
async function pipeCsv(dir, run, kind, out) {
  out.write(HEADERS[kind].join(',') + '\n');
  for (const f of runFiles(dir, run, kind)) {
    await new Promise((res, rej) => { const g = zlib.createGunzip(); fs.createReadStream(f).on('error', rej).pipe(g).on('error', rej); g.on('end', res); g.pipe(out, { end: false }); });
  }
  out.end();
}

module.exports = { Recorder, summarize, runFiles, removeRun, pipeCsv, iso, HEADERS };

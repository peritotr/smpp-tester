// Sharded load test: the sessions and the target TPS are split over several worker threads, each running its own
// LoadEngine (load-shard.js), so sending, reading responses and DLRs use several CPU cores. This coordinator
// starts them together, merges their per-second rows and totals (percentiles from the raw histograms), and matches
// DLRs to submits across workers: a platform may deliver a DLR on any bind, not the one the message went out on.
//
// Same interface as LoadEngine: start(cfg, test), stop(), events phase / tick / log / done.
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { Worker } = require('worker_threads');
const { performance } = require('perf_hooks');
const { Hist } = require('./hist');

const fill = (s, p) => p ? s.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : s;
const msg = (key, p) => ({ key, p, text: fill(key, p) });
const epochNow = () => performance.timeOrigin + performance.now();
const MAX_WORKERS = 8;

// Worker threads for a test: the setting, or automatically one per CPU core but one, at most one per session
function workerCount(test) {
  if (Number(test.clientTag)) return 1; // routing test client: one engine (it reports DLR ids per client)
  const sessions = Math.max(1, Number(test.sessions) || 4);
  const want = Math.floor(Number(test.workers) || Number(process.env.SMPP_TESTER_WORKERS) || 0);
  const auto = Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1);
  return Math.max(1, Math.min(want > 0 ? want : auto, sessions, MAX_WORKERS));
}

// Split n into k parts as evenly as possible
const split = (n, k) => Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));

const SUM_G = ['sent', 'ok', 'err', 'timeouts', 'throttled', 'retries', 'dlr', 'dlrOk', 'dlrFail', 'windowFullMs', 'dlrRejected'];
const SUM_ROW = ['target', 'bound', 'toTps', 'sentTps', 'okTps', 'errTps', 'thrTps', 'dlrTps', 'inflight', 'bp'];

class LoadCluster extends EventEmitter {
  constructor(n) { super(); this.n = n; this.running = false; }

  async start(cfg, test) {
    this.running = true; this.test = test;
    const S = Math.max(1, Math.min(64, Number(test.sessions) || 4)), n = Math.min(this.n, S);
    const sess = split(S, n), rx = split(Math.max(0, Number(test.rxSessions) || 0), n);
    const total = Math.max(0, Number(test.total) || 0), totals = split(total, n);
    this.events = []; this.series = []; this.logSeen = new Set();
    this.dlr = { pending: new Map(), early: new Map(), unmatched: 0, earlyHits: 0, all: new Hist(), sec: new Hist() };
    this.rowsByT = new Map(); this.done = 0; this.drained = false;
    this.emit('phase', { phase: 'binding', ...msg('Binding {n} sessions…', { n: S }) });

    this.shards = sess.map((s, i) => {
      const f = s / S, w = new Worker(path.join(__dirname, 'load-shard.js'));
      const sh = { i, w, sessions: s, live: true, ready: false, failed: false, row: null, totals: null, done: null, phase: 'binding' };
      w.on('message', m => this._onShard(sh, m.type, m.d));
      w.on('error', e => { this._log(msg('Worker {n} error: {msg}', { n: i + 1, msg: e.message })); this._shardGone(sh); });
      w.on('exit', () => { if (!sh.done) this._shardGone(sh); });
      const t = { ...test, sessions: s, rxSessions: rx[i], tps: (Number(test.tps) || 1000) * f, total: total ? totals[i] : 0, shardTag: i + 1, shard: true, workers: 1 };
      if (test.steps) t.steps = { start: (Number(test.steps.start) || Number(test.steps.inc)) * f, inc: Number(test.steps.inc) * f, dur: test.steps.dur };
      w.postMessage({ type: 'start', cfg, test: t });
      return sh;
    });
    this.secTimer = setInterval(() => this._second(), 1000);
  }

  // A worker's step event names its own share of the TPS: show the test's step TPS instead
  _step(m) {
    if (!m || m.key !== 'Step {i}/{n}: {tps} TPS' || !this.test.steps) return m;
    const st = this.test.steps, max = Number(this.test.tps), start = Number(st.start) || Number(st.inc), i = m.p.i;
    const tps = i >= m.p.n ? max : Math.min(max, start + (i - 1) * Number(st.inc));
    return { ...m, ...msg(m.key, { ...m.p, tps }) };
  }

  _log(m) { const k = m.key ? m.key + JSON.stringify(m.p || {}) : m.text; if (this.logSeen.has(k)) return; this.logSeen.add(k); this.emit('log', m); }

  _onShard(sh, type, d) {
    if (type === 'ready') { sh.ready = true; sh.bindInfo = d; return this._maybeGo(); }
    if (type === 'phase') {
      sh.phase = d.phase;
      if (d.phase === 'error') { sh.failed = true; sh.error = d; if (!this.started) this._maybeGo(); else this._shardGone(sh); }
      if (d.phase === 'draining') this._maybeDraining();
      return;
    }
    if (type === 'log') return this._log(this._step(d));
    if (type === 'dlrBatch') return this._dlrBatch(d);
    if (type === 'tick') { sh.totals = d.totals; sh.row = d.row; return this._addRow(sh, d.row); }
    if (type === 'done') { sh.done = d; sh.totals = d.totals; sh.live = false; this._flushRows(true); return this._maybeDone(); }
  }

  // All workers bound (or failed): start them together
  _maybeGo() {
    if (this.started || !this.shards.every(s => s.ready || s.failed)) return;
    const ok = this.shards.filter(s => s.ready);
    if (!ok.length) {
      const e = this.shards.find(s => s.error); this._end();
      const er = e && e.error;
      this.emit('phase', { phase: 'error', ...(er && er.key ? msg(er.key, er.p) : er && er.text ? { text: er.text } : msg('No session could bind')) });
      return;
    }
    this.started = true; this.startedAt = Date.now(); this.t0 = performance.now();
    for (const s of this.shards) if (s.failed) s.live = false;
    const bound = ok.reduce((a, s) => a + s.bindInfo.bound, 0), wanted = Number(this.test.sessions) || 4;
    this._event('start', '{n} sessions bound, sending started', { n: bound });
    this._event('workers', 'Sending from {n} worker threads (CPU cores)', { n: ok.length });
    if (bound < wanted) this._event('bindfail', '{failed}/{total} sessions could not bind; the test continued with {ok}.', { failed: wanted - bound, total: wanted, ok: bound, reason: (ok.find(s => s.bindInfo.reason) || {}).bindInfo?.reason });
    for (const s of ok) s.w.postMessage({ type: 'go' });
    this.emit('phase', { phase: 'running', ...msg('Sending') });
  }

  _event(type, key, p) {
    const t = this.t0 ? (performance.now() - this.t0) / 1000 : 0;
    const m = msg(key, p); this.events.push({ t: Math.round(t * 10) / 10, type, ...m }); this._log(m);
  }

  // ---- DLR matching across workers (times are epoch ms, the same clock in every thread) ----
  _dlrBatch(B) {
    const D = this.dlr;
    for (let i = 0; i < B.sub.length; i += 2) {
      const id = B.sub[i], t0 = B.sub[i + 1], early = D.early.get(id);
      if (early !== undefined) { D.early.delete(id); this._dlrLat(Math.max(0, early.t - t0)); D.earlyHits++; continue; }
      D.pending.set(id, t0);
      if (D.pending.size > 2000000) D.pending.delete(D.pending.keys().next().value);
    }
    for (let i = 0; i < B.dlr.length; i += 2) {
      let id = B.dlr[i]; const at = B.dlr[i + 1];
      let t0 = D.pending.get(id);
      if (t0 === undefined && /^[0-9a-f]+$/i.test(id)) {
        // Some platforms format the id differently in the DLR (letter case, hex ↔ decimal)
        const alts = [id.toUpperCase(), id.toLowerCase()];
        if (/^\d+$/.test(id)) { const h = BigInt(id).toString(16); alts.push(h, h.toUpperCase()); }
        const alt = alts.find(a => D.pending.has(a)); if (alt) { t0 = D.pending.get(alt); id = alt; }
      }
      if (t0 !== undefined) { D.pending.delete(id); this._dlrLat(Math.max(0, at - t0)); }
      else { D.early.set(id, { t: at }); if (D.early.size > 500000) { D.early.delete(D.early.keys().next().value); D.unmatched++; } }
    }
  }
  _dlrLat(l) { this.dlr.all.add(l); this.dlr.sec.add(l); }

  // ---- Per-second rows: merged once every live worker has sent its row for that second ----
  _addRow(sh, row) {
    if (this.lastT != null && row.t <= this.lastT) return; // a worker that finished later: its idle tail
    let m = this.rowsByT.get(row.t); if (!m) this.rowsByT.set(row.t, m = new Map());
    m.set(sh.i, row); this._flushRows(false);
  }
  _flushRows(force) {
    const live = this.shards.filter(s => s.live).map(s => s.i);
    for (const t of [...this.rowsByT.keys()].sort((a, b) => a - b)) {
      const m = this.rowsByT.get(t);
      if (!force && !live.every(i => m.has(i))) break;
      this.rowsByT.delete(t);
      const row = this._merge([...m.values()], t); this.series.push(row); this.lastT = t;
      this.emit('tick', { row, totals: this._totals() });
    }
  }
  _merge(rows, t) {
    const r = { t, step: rows[0].step, workers: rows.length };
    for (const k of SUM_ROW) r[k] = rows.reduce((a, x) => a + (x[k] || 0), 0);
    r.target = Math.round(r.target);
    r.windowFull = Math.round(rows.reduce((a, x) => a + (x.windowFull || 0), 0) / rows.length * 100) / 100;
    r.rate = Math.min(...rows.map(x => x.rate ?? 1));
    const lat = new Hist(), q = new Hist();
    for (const x of rows) if (x.h) { lat.merge(Hist.from(x.h.lat)); q.merge(Hist.from(x.h.q)); }
    const l = lat.summary(), qs = q.summary(), d = this.dlr.sec.summary(); this.dlr.sec = new Hist();
    Object.assign(r, { p50: l.p50, p95: l.p95, p99: l.p99, max: l.max, qP50: qs.p50, qP95: qs.p95, qP99: qs.p99, dlrP50: d.p50, dlrP95: d.p95 });
    // Event loop: the busiest worker is the one that limits
    r.loopP99 = Math.max(...rows.map(x => x.loopP99 || 0)); r.loopMax = Math.max(...rows.map(x => x.loopMax || 0));
    r.elu = Math.max(...rows.map(x => x.elu || 0)); r.eluAll = rows.map(x => x.elu || 0);
    return r;
  }

  _second() {
    const D = this.dlr, now = epochNow();
    // Early DLRs whose submit_sm_resp never showed up within 30 s count as unmatched
    for (const [k, v] of D.early) { if (now - v.t < 30000) break; D.early.delete(k); D.unmatched++; }
    // Draining: tell the workers when every response and DLR is in
    if (this.drained && !this.dlrSignalled) {
      const inflight = this.shards.filter(s => s.live && s.row).reduce((a, s) => a + s.row.inflight, 0);
      if (inflight === 0 && (!this.test.dlr || D.pending.size === 0)) { this.dlrSignalled = true; for (const s of this.shards) if (s.live) s.w.postMessage({ type: 'dlrDone' }); }
    }
  }

  _maybeDraining() {
    if (this.drained || !this.shards.filter(s => s.live).every(s => s.phase === 'draining' || s.done)) return;
    this.drained = true; this.sendEnd = performance.now();
    this._event('sendEnd', 'Sending finished, waiting for responses and DLRs');
    this.emit('phase', { phase: 'draining', ...msg(this.test.dlr ? 'Waiting for responses and DLRs…' : 'Waiting for responses…') });
  }

  _shardGone(sh) {
    if (!sh.live) return;
    sh.live = false; this._flushRows(true);
    if (this.started) this._event('worker', 'Worker {n} stopped early', { n: sh.i + 1 });
    this._maybeDraining(); this._maybeDone();
  }

  _totals() {
    const T = this.shards.map(s => s.totals).filter(Boolean), D = this.dlr;
    const out = { workers: this.shards.filter(s => s.ready).length };
    for (const k of SUM_G) out[k] = T.reduce((a, x) => a + (x[k] || 0), 0);
    for (const k of ['errs', 'dlrStats', 'okByDst']) { out[k] = {}; for (const x of T) for (const [a, b] of Object.entries(x[k] || {})) out[k][a] = (out[k][a] || 0) + b; }
    out.bound = T.reduce((a, x) => a + (x.bound || 0), 0);
    out.secs = Math.max(0, ...T.map(x => x.secs || 0));
    out.avgTps = out.sent / Math.max(out.secs, 0.001);
    const st = T.map(x => x.steadyTps).filter(v => v != null);
    out.steadyTps = st.length ? st.reduce((a, b) => a + b, 0) : null; out.steadySecs = Math.max(0, ...T.map(x => x.steadySecs || 0));
    const lat = new Hist(), q = new Hist(); for (const x of T) if (x.h) { lat.merge(Hist.from(x.h.lat)); q.merge(Hist.from(x.h.q)); }
    out.lat = lat.summary(); out.qLat = q.summary(); out.dlrLat = D.all.summary();
    // DLRs: matched here across workers; workers count only those without an id
    out.dlrUnmatched = T.reduce((a, x) => a + (x.dlrUnmatched || 0), 0) + D.unmatched + (this.finished ? D.early.size : 0);
    out.pendingDlr = D.pending.size; if (D.earlyHits) out.dlrEarly = D.earlyHits;
    const wa = T.map(x => x.windowAdvice).filter(Boolean).sort((a, b) => b.need - a.need)[0]; if (wa) out.windowAdvice = wa;
    const cl = T.map(x => x.cpuLimit).find(Boolean); if (cl) out.cpuLimit = cl;
    out.loop = { p99Max: Math.max(0, ...T.map(x => x.loop ? x.loop.p99Max : 0)), eluMax: Math.max(0, ...T.map(x => x.loop ? x.loop.eluMax : 0)),
      eluAvg: T.length ? Math.round(T.reduce((a, x) => a + (x.loop && x.loop.eluAvg || 0), 0) / T.length * 100) / 100 : null, busySecs: Math.max(0, ...T.map(x => x.loop ? x.loop.busySecs : 0)) };
    return out;
  }

  _maybeDone() {
    if (!this.started || this.finished || this.shards.some(s => s.live)) return;
    this.finished = true;
    this._flushRows(true);
    const totals = this._totals();
    // Worker events (deduplicated) and the coordinator's own, in time order
    const seen = new Set(), ev = [...this.events];
    for (const s of this.shards) for (let e of (s.done && s.done.events) || []) {
      if (['start', 'sendEnd', 'done'].includes(e.type)) continue;
      if (e.type === 'step') e = { ...this._step(e), t: e.t, type: e.type };
      const k = e.type + (e.key || e.text) + JSON.stringify(e.p || {}); if (seen.has(k)) continue; seen.add(k); ev.push(e);
    }
    ev.sort((a, b) => a.t - b.t);
    ev.push({ t: Math.round((performance.now() - this.t0) / 100) / 10, type: 'done', ...msg('Test finished') });
    const t0 = this.shards.find(s => s.done);
    this._end();
    // The test as one engine would have reported it (step list in total TPS, not a worker's share)
    const test = { ...(t0 ? t0.done.test : {}), ...this.test, workers: totals.workers, respTimeout: Number(this.test.respTimeout) || 10, dlrWait: Number(this.test.dlrWait ?? 10) };
    delete test.shard; delete test.shardTag;
    test.tps = Number(this.test.tps) || test.tps; test.sessions = Number(this.test.sessions) || test.sessions; test.total = Number(this.test.total) || 0;
    if (this.test.steps && t0 && t0.done.test.steps) {
      const st = this.test.steps, max = test.tps, start = Number(st.start) || Number(st.inc), inc = Number(st.inc), list = [];
      for (let v = start; v < max + inc * 0.001 && list.length < 100; v += inc) list.push(Math.min(v, max));
      if (list.at(-1) < max) list.push(max);
      test.steps = list; test.stepDur = Number(st.dur); test.duration = t0.done.test.duration;
    }
    this.emit('done', { totals, series: this.series, events: ev, startedAt: this.startedAt, endedAt: Date.now(), test });
    this.emit('phase', { phase: 'done', ...msg('Done') });
  }

  _end() {
    clearInterval(this.secTimer); this.secTimer = null; this.running = false;
    for (const s of this.shards || []) setTimeout(() => s.w.terminate(), 2000);
  }

  stop() {
    if (!this.running) return;
    for (const s of this.shards || []) if (s.live) try { s.w.postMessage({ type: 'stop' }); } catch {}
  }
}

module.exports = { LoadCluster, workerCount };

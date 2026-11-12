// Routing test: up to 4 vendors and 4 clients at once, each in its own process. The clients send to the platform
// under test with a prefix mix; the platform routes each prefix to a vendor. Every message carries the end-to-end
// marker with the client's number, so each vendor counts what it got per client × prefix and flags prefixes it
// should not get (misroutes). At the end, DLRs one client could not match are looked up in the other clients'
// sent messages: a DLR that went to the wrong customer.
//
// Shared by the web server and the desktop app. `spawn(file, onMessage)` starts a worker and returns
// { post(msg), kill(), onExit(fn) }.
const { EventEmitter } = require('events');

const MAX = 4;
const normNum = v => String(v || '').replace(/\D/g, '').replace(/^00/, '');
const prefixOf = dst => normNum(String(dst).replace(/[xX].*$/, ''));
const list = v => String(v || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
const dstList = v => list(v).map(x => x.replace(/:[\d.]+$/, ''));
const err = (key, p) => Object.assign(new Error(key.replace(/\{(\w+)\}/g, (_, k) => p && p[k] != null ? p[k] : '')), { key, p });

class RoutingRun extends EventEmitter {
  constructor(spawn) { super(); this.spawn = spawn; this.running = false; this.phase = 'idle'; }

  _phase(phase, key, p) { this.phase = phase; this.emit('phase', { phase, key, p, text: key && err(key, p).message }); }
  _log(key, p) { const m = { key, p, text: err(key, p).message }; this.events.push({ t: this.t0 ? Math.round((Date.now() - this.t0) / 100) / 10 : 0, type: 'log', ...m }); this.emit('log', m); }

  _checkVendors(spec) {
    const V = (spec.vendors || []).filter(v => v && Number(v.port));
    if (!V.length) throw err('Add at least one vendor and one client');
    if (V.length > MAX) throw err('At most {n} vendors and {n} clients', { n: MAX });
    const ports = V.map(v => Number(v.port));
    if (new Set(ports).size !== ports.length) throw err('Each vendor needs its own port');
    const sids = V.map(v => String(v.systemId || '').trim());
    if (sids.some(s => !s)) throw err('Each vendor needs a system_id');
    if (new Set(sids).size !== sids.length) throw err('Each vendor needs its own system_id');
    return V;
  }
  _check(spec) {
    const V = this._checkVendors(spec), C = (spec.clients || []).filter(c => c && c.host && dstList(c.dst).length);
    if (!C.length) throw err('Add at least one vendor and one client');
    if (C.length > MAX) throw err('At most {n} vendors and {n} clients', { n: MAX });
    return { V, C };
  }
  // Same vendor settings → the running vendors can be reused (the platform stays bound to them)
  _vkey(V) { return JSON.stringify(V.map(v => [Number(v.port), String(v.systemId).trim(), v.password || '', v.bindHost || '0.0.0.0', Number(v.respDelay) || 0, Number(v.dlrDelay ?? 1000), Number(v.failPct) || 0, Number(v.maxTps) || 0, v.name || ''])); }
  get vendorsUp() { return !!(this.vendors && this.vendors.length && this.vendors.every(v => v.proc)); }

  // Start the vendors on their own, so the platform can bind to them before the test (and stay bound between tests)
  async startVendors(spec) {
    if (this.running) throw err('A routing test is already running');
    const V = this._checkVendors(spec);
    this.events = this.events || [];
    await this._startVendors(V, spec, true);
    this._vtick(true);
    return this.vendorList();
  }
  stopVendors() {
    if (this.running) throw err('A routing test is already running');
    this._killVendors(); this._vtick(false);
  }
  vendorList() { return (this.vendors || []).map(v => ({ name: v.name, port: Number(v.def.port), systemId: v.def.systemId, conns: v.stats ? v.stats.conns : 0 })); }
  _killVendors() { for (const v of this.vendors || []) { try { v.proc && v.proc.kill(); } catch {} v.proc = null; } this.vendors = []; this.vkey = null; this.vendorsKeep = false; }
  // While vendors run without a test: their bind count once a second (the UI shows whether the platform is bound)
  _vtick(on) {
    clearInterval(this.vtimer); this.vtimer = null;
    if (on) this.vtimer = setInterval(() => { if (!this.running) this.emit('vendors', { up: this.vendorsUp, list: this.vendorList() }); }, 1000);
    this.emit('vendors', { up: this.vendorsUp, list: this.vendorList() });
  }

  async _startVendors(V, spec, keep) {
    const key = this._vkey(V);
    const prefixes = [...new Set([...V.flatMap(v => list(v.prefixes).map(normNum)), ...(spec.clients || []).flatMap(c => dstList(c.dst).map(prefixOf))].filter(Boolean))];
    const routing = v => ({ prefixes, expect: list(v.prefixes).map(normNum).filter(Boolean) });
    if (this.vendorsUp && this.vkey === key) {
      // Reuse: new prefixes, counters back to zero
      this.vendors.forEach((v, k) => { v.def = V[k]; v.expect = routing(V[k]).expect; v.stats = null; v.proc.post({ type: 'routing', routing: routing(V[k]) }); v.proc.post({ type: 'reset' }); });
      if (keep) this.vendorsKeep = true;
      return false;
    }
    this._killVendors();
    this.vkey = key; this.vendorsKeep = keep;
    this.vendors = V.map((v, i) => ({ i, def: v, name: v.name || 'Vendor ' + String.fromCharCode(65 + i), expect: routing(v).expect, stats: null, proc: null }));
    try {
      await Promise.all(this.vendors.map(v => new Promise((resolve, reject) => {
        const d = v.def;
        const timer = setTimeout(() => reject(err('{name}: no answer from the vendor process', { name: v.name })), 8000);
        v.proc = this.spawn('mock-worker.js', m => {
          if (m.type === 'started') { clearTimeout(timer); resolve(); }
          else if (m.type === 'error') { clearTimeout(timer); reject(err('{name}: {msg}', { name: v.name, msg: (m.msg && m.msg.text) || m.text })); }
          else if (m.type === 'stats') v.stats = m.stats;
          else if (m.type === 'log' && m.msg && /^(Bound|Bind rejected)/.test(m.msg.key || '')) { this.emit('vlog', { vendor: v.name, msg: m.msg }); if (this.running) this.events.push({ t: this.t0 ? Math.round((Date.now() - this.t0) / 100) / 10 : 0, type: 'log', key: '{name}: {msg}', p: { name: v.name, msg: m.msg.text } }); }
        });
        v.proc.post({ type: 'start', opts: {
          port: Number(d.port), bindHost: d.bindHost || '0.0.0.0', systemId: String(d.systemId).trim(), password: d.password || '',
          respDelay: Number(d.respDelay) || 0, dlrDelay: Number(d.dlrDelay ?? 1000), failRate: Math.max(0, Math.min(1, (Number(d.failPct) || 0) / 100)),
          maxTps: Number(d.maxTps) || 0, metricsPort: 0, metricsLog: false, stateDir: '', routing: routing(d),
        } });
      })));
    } catch (e) { this._killVendors(); throw e; }
    this.vendors.forEach(v => this._log('{name} listening on port {port} (system_id {sid}), expects {pre}', { name: v.name, port: v.def.port, sid: v.def.systemId, pre: v.expect.join(', ') || '—' }));
    return true;
  }

  async start(spec) {
    if (this.running) throw err('A routing test is already running');
    const { V, C } = this._check(spec);
    this.running = true; this.stopping = false; this.events = []; this.t0 = 0;
    this.spec = spec;
    this.clients = C.map((c, i) => ({ i, tag: i + 1, def: c, name: c.name || 'Client ' + (i + 1), phase: 'idle', row: null, totals: null, done: null, proc: null }));
    this.vSeries = [];
    this._phase('starting', 'Starting {v} vendors…', { v: V.length });

    // Vendors first, and the platform bound to them, before any traffic
    try { await this._startVendors(V, spec, !!this.vendorsKeep); }
    catch (e) { this.running = false; this._phase('error', e.key || e.message, e.p); return; }
    const wait = Math.max(0, Number(spec.bindWait ?? 30)) * 1000, w0 = Date.now();
    const unbound = () => this.vendors.filter(v => !(v.stats && v.stats.conns > 0));
    if (unbound().length) {
      this._phase('waiting', 'Waiting for your platform to bind to the vendors…');
      while (unbound().length && Date.now() - w0 < wait && !this.stopping) await new Promise(r => setTimeout(r, 250));
    }
    for (const v of unbound()) this._log('{name}: your platform has not bound to this vendor; the test starts anyway', { name: v.name });
    if (this.stopping) { this._finishAbort(); return; }

    // Then all clients at once
    this._phase('running', 'Sending');
    this.t0 = Date.now(); this.startedAt = this.t0;
    clearInterval(this.vtimer); this.vtimer = null;
    for (const c of this.clients) {
      const d = c.def;
      c.proc = this.spawn('load-worker.js', m => this._onClient(c, m));
      c.proc.post({ type: 'start', cfg: {
        host: String(d.host).trim(), port: Number(d.port) || 2775, tls: !!d.tls, verifyCert: false, systemId: d.systemId || '', password: d.password || '',
        bindMode: d.bindMode || 'trx', systemType: d.systemType || '', connectTimeout: 10, enquireLink: 30,
      }, test: {
        sessions: d.sessions, window: d.window, tps: d.tps, duration: spec.duration, ramp: spec.ramp, dlr: spec.dlr !== false, dlrWait: spec.dlrWait,
        respTimeout: spec.respTimeout, retryThrottle: true, src: d.src || spec.src || 'TEST', srcTon: spec.srcTon ?? 5, srcNpi: spec.srcNpi ?? 0,
        dst: d.dst, dstTon: spec.dstTon ?? 1, dstNpi: spec.dstNpi ?? 1, text: spec.text || 'Routing test', encoding: spec.encoding || 'auto',
        e2e: true, clientTag: c.tag,
      } });
    }
    this.timer = setInterval(() => this._second(), 1000);
  }

  _onClient(c, m) {
    if (m.type === 'phase') {
      c.phase = m.phase;
      if (m.phase === 'error') { c.error = m; this._log('{name}: {msg}', { name: c.name, msg: m.key ? err(m.key, m.p).message : m.text }); this._maybeDone(); }
    } else if (m.type === 'tick') { c.row = m.row; c.totals = m.totals; }
    else if (m.type === 'log') this.emit('clog', { client: c.name, msg: m });
    else if (m.type === 'done') { c.done = m; c.totals = m.totals; c.phase = 'done'; this._maybeDone(); }
  }

  _second() {
    const t = Math.round((Date.now() - this.t0) / 1000);
    const vrow = { t, rx: this.vendors.map(v => v.stats ? v.stats.rx : 0), mis: this.vendors.map(v => v.stats && v.stats.routing ? v.stats.routing.misroute : 0) };
    this.vSeries.push(vrow);
    this.emit('tick', {
      t,
      clients: this.clients.map(c => ({ name: c.name, phase: c.phase, sentTps: c.row ? c.row.sentTps : 0, okTps: c.row ? c.row.okTps : 0, p95: c.row ? c.row.p95 : null,
        thrTps: c.row ? c.row.thrTps : 0, errTps: c.row ? c.row.errTps : 0, inflight: c.row ? c.row.inflight : 0, sent: c.totals ? c.totals.sent : 0, ok: c.totals ? c.totals.ok : 0, dlr: c.totals ? c.totals.dlr : 0 })),
      vendors: this.vendors.map((v, k) => ({ name: v.name, rx: vrow.rx[k], conns: v.stats ? v.stats.conns : 0, n: v.stats ? v.stats.e2e.n : 0, misroute: vrow.mis[k], e2eP95: v.stats && v.stats.e2e.sec ? v.stats.e2e.sec.p95 : null })),
    });
  }

  _maybeDone() {
    if (!this.clients.every(c => c.done || c.phase === 'error') || this.finishing) return;
    this.finishing = true;
    this._phase('finishing', 'Collecting results…');
    // One more vendor stats round so the last messages are counted
    setTimeout(() => {
      let rep = null;
      try { rep = this._report(); } catch (e) { this._log('Could not build the report: {msg}', { msg: e.message }); }
      this._cleanup(); this.running = false; this.finishing = false;
      this.emit('done', rep);
      this._phase('done', 'Done');
    }, 2200);
  }

  stop() {
    if (!this.running) return;
    if (this.stopping) { for (const c of this.clients || []) if (!c.done) { c.phase = 'error'; c.error = { text: 'Stopped' }; try { c.proc && c.proc.kill(); } catch {} } this._maybeDone(); return; }
    this.stopping = true;
    for (const c of this.clients || []) try { c.proc && c.proc.post({ type: 'stop' }); } catch {}
  }

  _cleanup() {
    clearInterval(this.timer); this.timer = null;
    for (const x of this.clients || []) { try { x.proc && x.proc.kill(); } catch {} x.proc = null; }
    if (this.vendorsKeep) this._vtick(true); else this._killVendors();
  }
  _finishAbort() { this._cleanup(); this.running = false; this.stopping = false; this._phase('done', 'Done'); }
  // App or server shutting down
  shutdown() { this.vendorsKeep = false; clearInterval(this.vtimer); this._cleanup(); }

  _report() {
    const S = this.spec, vendors = this.vendors, clients = this.clients;
    // ---- client × prefix × vendor ----
    const matrix = [];
    for (const c of clients) {
      const okByDst = (c.totals && c.totals.okByDst) || {};
      const byPrefix = {};
      for (const d of dstList(c.def.dst)) { const p = prefixOf(d); byPrefix[p] = (byPrefix[p] || 0) + (okByDst[d] || 0); }
      for (const [prefix, accepted] of Object.entries(byPrefix)) matrix.push({ client: c.tag, prefix, accepted, cells: vendors.map(() => null) });
    }
    vendors.forEach((v, k) => {
      for (const cell of (v.stats && v.stats.routing && v.stats.routing.cells) || []) {
        let row = matrix.find(r => r.client === cell.client && r.prefix === cell.prefix);
        if (!row) matrix.push(row = { client: cell.client, prefix: cell.prefix, accepted: null, cells: vendors.map(() => null), extra: true });
        row.cells[k] = { n: cell.n, dup: cell.dup, mis: cell.mis, p50: cell.lat.p50 ?? null, p95: cell.lat.p95 ?? null, p99: cell.lat.p99 ?? null };
      }
    });
    for (const r of matrix) {
      r.received = r.cells.reduce((a, x) => a + (x ? x.n : 0), 0);
      r.dup = r.cells.reduce((a, x) => a + (x ? x.dup : 0), 0);
      r.mis = r.cells.reduce((a, x) => a + (x ? x.mis : 0), 0);
      r.lost = r.accepted == null ? null : Math.max(0, r.accepted - r.received);
      r.expected = vendors.filter(v => v.expect.includes(r.prefix)).map(v => v.name);
    }
    matrix.sort((a, b) => a.client - b.client || a.prefix.localeCompare(b.prefix));

    // ---- DLRs that reached the wrong client ----
    const pend = clients.map(c => new Set((c.done && c.done.ids && c.done.ids.pending) || []));
    const dlrCross = [];
    clients.forEach((c, a) => {
      const un = (c.done && c.done.ids && c.done.ids.unmatched) || [];
      clients.forEach((o, b) => { if (a === b || !un.length) return; let n = 0; for (const id of un) if (pend[b].has(id)) n++; if (n) dlrCross.push({ from: o.tag, to: c.tag, n }); });
    });

    const strip = T => { if (!T) return null; const { okByDst, ...rest } = T; return { ...rest, okByDst }; };
    const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
    const tot = {
      sent: sum(clients, c => c.totals && c.totals.sent), accepted: sum(clients, c => c.totals && c.totals.ok),
      received: sum(matrix, r => r.received), lost: sum(matrix, r => r.lost), dup: sum(matrix, r => r.dup), misroute: sum(matrix, r => r.mis),
      wrongDlr: sum(dlrCross, x => x.n), unknown: sum(matrix.filter(r => !r.client), r => r.received),
      clientErrors: clients.filter(c => c.error).length,
    };
    const issues = [tot.lost, tot.dup, tot.misroute, tot.wrongDlr, tot.clientErrors].filter(Boolean).length;
    return {
      version: 1, kind: 'routing', name: S.name || '', createdAt: Date.now(), startedAt: this.startedAt, endedAt: Date.now(),
      test: { duration: S.duration, ramp: S.ramp, dlr: S.dlr !== false, dlrWait: S.dlrWait, respTimeout: S.respTimeout, text: S.text, encoding: S.encoding },
      vendors: vendors.map(v => ({ name: v.name, port: Number(v.def.port), systemId: v.def.systemId, expect: v.expect, respDelay: Number(v.def.respDelay) || 0, dlrDelay: Number(v.def.dlrDelay ?? 1000),
        failPct: Number(v.def.failPct) || 0, maxTps: Number(v.def.maxTps) || 0,
        received: v.stats ? v.stats.e2e.n : 0, dup: v.stats ? v.stats.e2e.dup : 0, e2e: v.stats ? v.stats.e2e.total : null,
        misroute: v.stats && v.stats.routing ? v.stats.routing.misroute : 0, samples: v.stats && v.stats.routing ? v.stats.routing.samples : [] })),
      clients: clients.map(c => ({ tag: c.tag, name: c.name, host: c.def.host, port: Number(c.def.port) || 2775, systemId: c.def.systemId, sessions: Number(c.def.sessions), window: Number(c.def.window), tps: Number(c.def.tps), dst: c.def.dst,
        error: c.error ? (c.error.key ? err(c.error.key, c.error.p).message : c.error.text) : null,
        totals: strip(c.totals), series: c.done ? c.done.series : [], events: c.done ? c.done.events : [] })),
      matrix, dlrCross, totals: tot, vendorSeries: this.vSeries, events: this.events,
      verdict: issues ? 'fail' : 'pass', issues,
    };
  }
}

module.exports = { RoutingRun, prefixOf, normNum };

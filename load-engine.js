// Load test engine: N parallel binds, windowing, token-bucket rate control,
// back-off on throttling, latency histograms. Runs in its own process (load-worker.js).
//
// User-facing messages are English templates ({key, p}) so the UI can translate them.
const EventEmitter = require('events');
const smpp = require('smpp');
const defs = require('smpp/lib/defs');
const { analyze } = require('./smpp-core');

const STATUS_NAME = {}; for (const [k, v] of Object.entries(defs.errors)) STATUS_NAME[v] = k;
const sname = s => STATUS_NAME[s] || '0x' + s.toString(16).padStart(8, '0');
const THROTTLE = new Set([0x58, 0x14]); // ESME_RTHROTTLED, ESME_RMSGQFUL
const now = () => performance.now();
const fill = (s, p) => p ? s.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : s;
const msg = (key, p) => ({ key, p, text: fill(key, p) });
const err = (key, p) => Object.assign(new Error(fill(key, p)), { key, p });

const { Hist } = require('./hist');

class LoadEngine extends EventEmitter {
  constructor() { super(); this.running = false; }

  async start(cfg, t) {
    if (this.running) throw err('A test is already running');
    this.running = true; this.stopping = false;
    this.cfg = cfg;
    this.t = {
      sessions: Math.max(1, Math.min(64, Number(t.sessions) || 4)),
      window: Math.max(1, Math.min(5000, Number(t.window) || 100)),
      tps: Math.max(1, Math.min(100000, Number(t.tps) || 1000)),
      total: Math.max(0, Number(t.total) || 0),
      duration: Math.max(0, Number(t.duration) || 0),
      ramp: Math.max(0, Number(t.ramp) || 0),
      respTimeout: Math.max(1, Number(t.respTimeout) || 10) * 1000,
      dlrWait: Math.max(0, Number(t.dlrWait ?? 10)) * 1000,
      retryThrottle: t.retryThrottle !== false,
      dlr: !!t.dlr,
      e2e: !!t.e2e,
      criteria: t.criteria || {},
    };
    // Step test: from the start TPS to the target TPS, fixed duration per step
    const st = t.steps;
    if (st && Number(st.inc) > 0 && Number(st.dur) > 0) {
      const start = Math.max(1, Number(st.start) || Number(st.inc)), inc = Number(st.inc), max = this.t.tps, dur = Number(st.dur);
      this.t.steps = [];
      for (let v = start; v < max + inc * 0.001 && this.t.steps.length < 100; v += inc) this.t.steps.push(Math.min(v, max));
      if (this.t.steps.at(-1) < max) this.t.steps.push(max);
      this.t.stepDur = dur; this.t.duration = this.t.steps.length * dur; this.t.total = 0;
    } else this.t.steps = null;
    if (!this.t.total && !this.t.duration) this.t.duration = 60;
    this.events = []; this.flags = {};

    this._buildTemplates(t);
    this.sessions = []; this.rr = 0;
    this.G = { sent: 0, ok: 0, err: 0, timeouts: 0, throttled: 0, retries: 0, dlr: 0, dlrOk: 0, dlrFail: 0, dlrUnmatched: 0, windowFullMs: 0, errs: {}, dlrStats: {} };
    this.S = this._emptySec();
    this.latAll = new Hist(); this.dlrAll = new Hist();
    this.pendingDlr = new Map(); this.earlyDlr = new Map();
    this.retryQ = 0; this.rateFactor = 1;
    this.series = [];

    this.emit('phase', { phase: 'binding', ...msg('Binding {n} sessions…', { n: this.t.sessions }) });
    // Binds have a response deadline; if some fail, the test continues with the ones that bound
    this.binding = true; this.aborted = false; this.allSessions = [];
    const res = await Promise.allSettled(Array.from({ length: this.t.sessions }, (_, i) =>
      new Promise(r => setTimeout(r, i * 100)).then(() => this.aborted ? Promise.reject(err('Stopped')) : this._openSession(i))));
    this.binding = false;
    if (this.aborted) return;
    const failedErr = res.filter(r => r.status === 'rejected').map(r => r.reason || {});
    const failed = failedErr.map(e => e.message);
    if (!this.sessions.length) {
      this._closeAll(); this.running = false;
      const e0 = failedErr[0];
      this.emit('phase', { phase: 'error', ...(e0 && e0.key ? msg(e0.key, e0.p) : e0 && e0.message ? { text: e0.message } : msg('No session could bind')) }); return;
    }
    this.emit('phase', { phase: 'running', ...msg('Sending') });
    this.startedAt = Date.now();
    this.t0 = now(); this.curStep = -1;
    this._event('start', '{n} sessions bound, sending started', { n: this.sessions.length });
    if (failed.length) this._event('bindfail', '{failed}/{total} sessions could not bind; the test continued with {ok}.', { failed: failed.length, total: this.t.sessions, ok: this.sessions.length, reason: failed[0] }); this.lastTick = this.t0; this.allow = 0; this.secT = this.t0;
    this.tick = setInterval(() => this._pump(), 2);
    this.secTimer = setInterval(() => this._second(), 1000);
  }

  _buildTemplates(t) {
    const a = analyze(t.text || 'Load test', t.encoding || 'auto');
    if (a.error) throw err(a.error);
    const dsts = String(t.dst || '').split(/[\s,;]+/).filter(Boolean);
    if (!dsts.length) throw err('Recipient is empty');
    const enc = a.enc;
    const PDU = smpp.PDU;
    // Long text goes as a single submit_sm with message_payload (in a load test, one PDU = one message)
    const encode = require('./smpp-core').__encodeText;
    // End-to-end measurement: #T<13-digit epoch ms><7-digit counter> is appended; the vendor side picks it up
    const ZERO = '#T' + '0'.repeat(20);
    const text = (t.text || 'Load test') + (t.e2e ? ' ' + ZERO : '');
    const msg = encode(text, enc);
    this.e2eCounter = 0;
    this.templates = dsts.map(dst => {
      const params = {
        source_addr_ton: Number(t.srcTon || 0), source_addr_npi: Number(t.srcNpi || 0), source_addr: t.src || '',
        dest_addr_ton: Number(t.dstTon || 1), dest_addr_npi: Number(t.dstNpi || 1), destination_addr: dst,
        registered_delivery: t.dlr ? 1 : 0, data_coding: a.dcs, esm_class: 0,
      };
      if (msg.length <= (enc === 'gsm7' ? 160 : 140)) params.short_message = msg;
      else { params.short_message = Buffer.alloc(0); params.message_payload = msg; }
      const pdu = new PDU('submit_sm', params); pdu.sequence_number = 1;
      const buf = pdu.toBuffer();
      // Find the offsets of the X characters in the recipient so they can be randomised per message
      const xs = [];
      if (dst.includes('X') || dst.includes('x')) {
        const at = buf.indexOf(Buffer.from(dst + '\0', 'latin1'), 16);
        if (at > 0) for (let i = 0; i < dst.length; i++) if (dst[i] === 'X' || dst[i] === 'x') xs.push(at + i);
      }
      let tagOff = -1;
      if (t.e2e) {
        tagOff = buf.lastIndexOf(encode(ZERO, enc));
        if (tagOff > 0) tagOff += enc === 'ucs2' ? 4 : 2; // first digit after '#T'
      }
      return { buf, xs, tagOff, ucs2: enc === 'ucs2' };
    });
    this.tIdx = 0;
  }

  _openSession(i) {
    const cfg = this.cfg;
    return new Promise((resolve, reject) => {
      const s = smpp.connect({
        host: String(cfg.host).trim(), port: Number(cfg.port) || 2775, tls: !!cfg.tls,
        rejectUnauthorized: !!cfg.verifyCert, connectTimeout: (Number(cfg.connectTimeout) || 10) * 1000,
        auto_enquire_link_period: (Number(cfg.enquireLink) || 30) * 1000,
      });
      const st = { s, i, inflight: 0, bound: false, sent: new Map(), out: [], flushQ: false };
      this.allSessions.push(s);
      let settled = false;
      // Don't wait forever if the platform never answers the bind (typically when its bind limit is reached)
      const bindLimit = (Number(cfg.connectTimeout) || 10) * 1000 + 10000;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { s.close(); } catch {} reject(err('Session {n}: no bind response within {s} s (the platform bind limit may be reached)', { n: i + 1, s: bindLimit / 1000 })); } }, bindLimit);
      s.on('error', e => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err('Session {n}: {msg}', { n: i + 1, msg: e.message })); }
        else this.emit('log', msg('Session {n} error: {msg}', { n: i + 1, msg: e.message }));
      });
      s.on('close', () => { const was = st.bound; st.bound = false; if (this.running && !this.stopping && was) this._event('session', 'Session {n} disconnected', { n: i + 1 }); });
      s.on('enquire_link', p => s.send(p.response()));
      s.on('deliver_sm', p => this._onDeliver(st, p));
      s.on(cfg.tls ? 'secureConnect' : 'connect', () => {
        const fn = { trx: 'bind_transceiver', tx: 'bind_transmitter', rx: 'bind_transceiver' }[cfg.bindMode || 'trx'];
        s[fn]({
          system_id: cfg.systemId || '', password: cfg.password || '', system_type: cfg.systemType || '',
          interface_version: Number(cfg.interfaceVersion || 0x34), addr_ton: Number(cfg.addrTon || 0), addr_npi: Number(cfg.addrNpi || 0),
          address_range: cfg.addressRange || '',
        }, r => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (this.aborted) { s.close(); return reject(err('Stopped')); }
          if (r.command_status === 0) { st.bound = true; this.sessions.push(st); resolve(); }
          else { s.close(); reject(err('Session {n} bind rejected: {status}', { n: i + 1, status: sname(r.command_status) })); }
        });
      });
    });
  }

  _emptySec() { return { sent: 0, ok: 0, err: 0, thr: 0, dlr: 0, lat: new Hist(), dlrLat: new Hist() }; }

  // Token bucket: accrue permits every 2 ms and send while the window has room
  _pump() {
    if (this.stopping) return;
    const t = now(); const el = t - this.lastTick; this.lastTick = t;
    const elapsed = t - this.t0;
    const rampF = this.t.ramp ? Math.min(1, Math.max(0.02, elapsed / (this.t.ramp * 1000))) : 1;
    if (this.rateFactor < 1) this.rateFactor = Math.min(1, this.rateFactor + el / 3000); // back to full speed within 3 s
    const target = this._target(elapsed);
    const rate = target * rampF * this.rateFactor;
    this.allow = Math.min(this.allow + rate * el / 1000, Math.max(1, rate * 0.02));

    const doneNew = (this.t.total && this.G.sent - this.G.retries >= this.t.total) || (this.t.duration && elapsed >= this.t.duration * 1000);
    if (doneNew && !this.retryQ) return this._finishSending();

    const n = this.sessions.length; let blocked = false;
    while (this.allow >= 1) {
      let st = null;
      for (let k = 0; k < n; k++) { const c = this.sessions[(this.rr + k) % n]; if (c.bound && c.inflight < this.t.window) { st = c; this.rr = (this.rr + k + 1) % n; break; } }
      if (!st) { blocked = true; break; }
      if (this.retryQ) { this.retryQ--; this.G.retries++; }
      else if (doneNew) break;
      else if (this.t.total && this.G.sent - this.G.retries >= this.t.total) break;
      this._send(st); this.allow--;
    }
    if (blocked) this.G.windowFullMs += el;
    for (const st of this.sessions) this._flush(st);
  }

  // Current target TPS (per step in a step test)
  // quiet = true: just compute (used for per-second stats), don't advance the step or log an event
  _target(elapsedMs, quiet) {
    if (!this.t.steps) return this.t.tps;
    const i = Math.min(this.t.steps.length - 1, Math.floor(elapsedMs / 1000 / this.t.stepDur));
    if (quiet) return this.t.steps.at(i);
    if (i !== this.curStep) { this.curStep = i; this._event('step', 'Step {i}/{n}: {tps} TPS', { i: i + 1, n: this.t.steps.length, tps: this.t.steps.at(i) }); }
    return this.t.steps.at(i);
  }

  // Timeline event stored in the report; key/p let the UI translate the text
  _event(type, key, p) {
    const t = this.t0 ? (now() - this.t0) / 1000 : 0;
    const m = msg(key, p);
    this.events.push({ t: Math.round(t * 10) / 10, type, ...m });
    if (this.events.length > 2000) this.events.splice(1000, 1);
    this.emit('log', m);
  }

  _send(st) {
    const tp = this.templates[this.tIdx]; this.tIdx = (this.tIdx + 1) % this.templates.length;
    const b = Buffer.from(tp.buf);
    for (const o of tp.xs) b[o] = 48 + ((Math.random() * 10) | 0);
    if (tp.tagOff > 0) {
      const digits = String(Date.now()).padStart(13, '0') + String(this.e2eCounter++ % 1e7).padStart(7, '0');
      if (tp.ucs2) for (let i = 0; i < 20; i++) b[tp.tagOff + i * 2 + 1] = digits.charCodeAt(i);
      else b.write(digits, tp.tagOff, 'latin1');
    }
    let seq = ++st.s.sequence; if (seq > 0x7ffffff0) { st.s.sequence = 1; seq = 1; }
    b.writeUInt32BE(seq, 12);
    const t0 = now();
    st.inflight++; st.sent.set(seq, t0);
    st.s._callbacks[seq] = pdu => this._onResp(st, seq, t0, pdu);
    st.out.push(b);
    this.G.sent++; this.S.sent++;
  }

  _flush(st) {
    if (!st.out.length) return;
    if (st.s.socket && !st.s.closed) st.s.socket.write(st.out.length === 1 ? st.out[0] : Buffer.concat(st.out));
    st.out = [];
  }

  _onResp(st, seq, t0, pdu) {
    if (!st.sent.delete(seq)) return; // already counted as a timeout
    st.inflight--;
    const lat = now() - t0;
    this.S.lat.add(lat); this.latAll.add(lat);
    const cs = pdu.command_status;
    if (cs === 0) {
      this.G.ok++; this.S.ok++;
      if (this.t.dlr && pdu.message_id) {
        // The DLR may arrive before submit_sm_resp (happens on queue-based platforms)
        const early = this.earlyDlr.get(pdu.message_id);
        if (early !== undefined) { this.earlyDlr.delete(pdu.message_id); const l = Math.max(0, early - t0); this.S.dlrLat.add(l); this.dlrAll.add(l); this.G.dlrEarly = (this.G.dlrEarly || 0) + 1; return; }
        this.pendingDlr.set(pdu.message_id, t0);
        if (this.pendingDlr.size > 2000000) { const k = this.pendingDlr.keys().next().value; this.pendingDlr.delete(k); }
      }
    } else if (THROTTLE.has(cs)) {
      if (!this.flags.thr) { this.flags.thr = true; this._event('throttle', 'First throttle ({status})', { status: sname(cs) }); }
      this.G.throttled++; this.S.thr++;
      const tn = now(); if (!this.lastDec || tn - this.lastDec > 200) { this.lastDec = tn; this.rateFactor = Math.max(0.1, this.rateFactor * 0.85); }
      if (this.t.retryThrottle) this.retryQ++;
      else { this.G.err++; this.S.err++; const n = sname(cs); this.G.errs[n] = (this.G.errs[n] || 0) + 1; }
    } else {
      this.G.err++; this.S.err++; const n = sname(cs); this.G.errs[n] = (this.G.errs[n] || 0) + 1;
      if (!this.flags['e' + n]) { this.flags['e' + n] = true; this._event('error', 'First {status} error', { status: n }); }
    }
  }

  _onDeliver(st, pdu) {
    // Write deliver_sm_resp as raw bytes (fast path)
    const r = Buffer.alloc(17); r.writeUInt32BE(17, 0); r.writeUInt32BE(0x80000005, 4); r.writeUInt32BE(pdu.sequence_number, 12);
    st.out.push(r); if (!st.flushQ) { st.flushQ = true; setImmediate(() => { st.flushQ = false; this._flush(st); }); }
    const isDlr = (pdu.esm_class & 0x3c) === 0x04 || pdu.receipted_message_id;
    if (!isDlr) { this.emit('log', msg('MO received from {from}', { from: pdu.source_addr })); return; }
    let id = pdu.receipted_message_id, stat;
    const sm = pdu.short_message && pdu.short_message.message;
    const txt = Buffer.isBuffer(sm) ? sm.toString('latin1') : String(sm || '');
    const m1 = /stat:(\w+)/i.exec(txt); stat = m1 ? m1[1].toUpperCase() : (pdu.message_state === 2 ? 'DELIVRD' : 'STATE' + pdu.message_state);
    if (!id) { const m2 = /id:(\S+)/i.exec(txt); id = m2 && m2[1]; }
    this.G.dlr++; this.S.dlr++;
    this.G.dlrStats[stat] = (this.G.dlrStats[stat] || 0) + 1;
    stat === 'DELIVRD' ? this.G.dlrOk++ : this.G.dlrFail++;
    let t0 = id && this.pendingDlr.get(id);
    if (t0 === undefined && id && /^[0-9a-f]+$/i.test(id)) {
      // Some platforms format the id differently in the DLR (letter case, hex ↔ decimal)
      const alts = [id.toUpperCase(), id.toLowerCase()];
      if (/^\d+$/.test(id)) { const h = BigInt(id).toString(16); alts.push(h, h.toUpperCase()); }
      const alt = alts.find(a => this.pendingDlr.has(a));
      if (alt) { t0 = this.pendingDlr.get(alt); id = alt; }
    }
    if (t0 !== undefined) { this.pendingDlr.delete(id); const l = now() - t0; this.S.dlrLat.add(l); this.dlrAll.add(l); }
    else if (id) { this.earlyDlr.set(id, now()); if (this.earlyDlr.size > 500000) { const k = this.earlyDlr.keys().next().value; this.earlyDlr.delete(k); this.G.dlrUnmatched++; } }
    else this.G.dlrUnmatched++;
  }

  _second() {
    const t = now();
    // Response timeouts
    for (const st of this.sessions) for (const [seq, t0] of st.sent) {
      if (t - t0 < this.t.respTimeout) break; // Map insertion order = time order
      if (!this.flags.to) { this.flags.to = true; this._event('timeout', 'First response timeout'); }
      st.sent.delete(seq); delete st.s._callbacks[seq]; st.inflight--; this.G.timeouts++; this.G.err++; this.S.err++; this.S.to = (this.S.to || 0) + 1;
      this.G.errs['TIMEOUT'] = (this.G.errs['TIMEOUT'] || 0) + 1;
    }
    // Early DLRs whose submit_sm_resp never arrived within 30 s count as unmatched
    for (const [k, at] of this.earlyDlr) { if (t - at < 30000) break; this.earlyDlr.delete(k); this.G.dlrUnmatched++; }
    const dt = (t - this.secT) / 1000; this.secT = t;
    const S = this.S, l = S.lat.summary(), d = S.dlrLat.summary();
    const el = t - this.t0;
    const wf = Math.min(1, (this.G.windowFullMs - (this.lastWf || 0)) / (dt * 1000)); this.lastWf = this.G.windowFullMs;
    const row = {
      // Target at the middle of the second (TPS values are averages over that second)
      target: this.tick ? Math.round(this._target(Math.max(0, el - dt * 500), true) * (this.t.ramp ? Math.min(1, Math.max(0, el - dt * 500) / (this.t.ramp * 1000)) : 1)) : 0,
      step: this.t.steps && this.tick ? Math.min(this.t.steps.length, Math.floor(Math.max(0, el - dt * 500) / 1000 / this.t.stepDur) + 1) : null,
      bound: this.sessions.filter(s => s.bound).length, windowFull: Math.round(wf * 100) / 100, toTps: (S.to || 0) / dt,
      t: Math.round((t - this.t0) / 1000), sentTps: S.sent / dt, okTps: S.ok / dt, errTps: S.err / dt, thrTps: S.thr / dt, dlrTps: S.dlr / dt,
      inflight: this.sessions.reduce((a, s) => a + s.inflight, 0), rate: this.rateFactor,
      p50: l.p50, p95: l.p95, p99: l.p99, max: l.max, dlrP50: d.p50, dlrP95: d.p95,
    };
    this.series.push(row);
    this.S = this._emptySec();
    this.emit('tick', { row, totals: this._totals() });
    if (this.drainUntil && (t >= this.drainUntil || (row.inflight === 0 && (!this.t.dlr || this.G.dlr >= this.G.ok)))) this._finish();
  }

  _totals() {
    const secs = ((this.sendEnd || now()) - this.t0) / 1000;
    const bound = this.sessions.filter(s => s.bound).length;
    return { ...this.G, bound, secs, avgTps: this.G.sent / Math.max(secs, 0.001), lat: this.latAll.summary(), dlrLat: this.dlrAll.summary(), pendingDlr: this.pendingDlr.size };
  }

  _finishSending() {
    if (this.drainUntil) return;
    this._event('sendEnd', 'Sending finished, waiting for responses and DLRs');
    this.sendEnd = now();
    clearInterval(this.tick); this.tick = null;
    for (const st of this.sessions) this._flush(st);
    this.drainUntil = now() + Math.max(this.t.respTimeout, this.t.dlr ? this.t.dlrWait : 0);
    this.emit('phase', { phase: 'draining', ...msg(this.t.dlr ? 'Waiting for responses and DLRs…' : 'Waiting for responses…') });
  }

  _finish() {
    clearInterval(this.secTimer); this.secTimer = null;
    this.G.dlrUnmatched += this.earlyDlr.size; this.earlyDlr.clear();
    const totals = this._totals();
    this._closeAll();
    this.running = false; this.drainUntil = null; this.sendEnd = null;
    this._event('done', 'Test finished');
    this.emit('done', { totals, series: this.series, events: this.events, startedAt: this.startedAt, endedAt: Date.now(),
      test: { ...this.t, respTimeout: this.t.respTimeout / 1000, dlrWait: this.t.dlrWait / 1000 } });
    this.emit('phase', { phase: 'done', ...msg('Done') });
  }

  stop() {
    if (!this.running) return;
    if (this.binding) {
      // Stop during binding: close open connections and cancel the test
      this.aborted = true;
      for (const c of this.allSessions || []) { try { c.close(); } catch {} }
      this.sessions = []; this.running = false; this.binding = false;
      this.emit('phase', { phase: 'error', ...msg('Stopped while binding') }); return;
    }
    if (this.tick) this._finishSending();
    else this.drainUntil = now(); // second press: finish without waiting
  }

  _closeAll() {
    this.stopping = true;
    for (const st of this.sessions || []) { try { st.bound ? st.s.unbind(() => st.s.close()) : st.s.close(); setTimeout(() => { try { st.s.close(); } catch {} }, 1500); } catch {} }
    this.sessions = [];
  }
}

module.exports = { LoadEngine, Hist };

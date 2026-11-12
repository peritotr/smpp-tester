// Mock SMSC (vendor) written on raw sockets so it can sustain high TPS.
// Runs in its own process (mock-worker.js) so it does not skew client-side measurements.
//
// One event loop serves both directions, so the submit path is protected from DLR load explicitly:
//  - responses (submit_sm_resp, bind/enquire_link responses) and DLRs go through separate output queues per
//    connection; responses are always written first, and DLRs only while the socket is not backed up;
//  - DLR work runs on a timer with a time budget per tick and O(log n) heaps, never full scans of the queues;
//  - all journal file work (appending, compaction) runs in a worker thread.
const net = require('net');
const http = require('http');
const EventEmitter = require('events');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const { Hist } = require('./hist');
const { decodeSm } = require('./sms-decode');
const crypto = require('crypto');
const path = require('path');
const journal = require('./dlr-journal');
const fs = require('fs');
const zlib = require('zlib');
const { MinHeap, delaySampler, backoff, parseCodes, hex } = require('./dlr-sched');
const KEEP = 1000; // incoming messages kept for the "Vendor messages" list
const TAG = /#T(\d{13})(\d{7})/;
// Numbers and prefixes compared as digits only, without a leading 00 or +: "+90 532…", "0090532…" and "90532…" match
const normNum = v => String(v || '').replace(/\D/g, '').replace(/^00/, '');
const routingOpts = r => r ? {
  prefixes: [...new Set((r.prefixes || []).map(normNum).filter(Boolean))].sort((a, b) => b.length - a.length),
  expect: new Set((r.expect || []).map(normNum).filter(Boolean)),
  backup: new Set((r.backup || []).map(normNum).filter(Boolean)),   // prefixes this vendor takes over when their vendor is down
  // What the clients sent: the text before the marker and its data_coding, to check the platform left them alone
  text: r.text == null ? null : String(r.text), dcs: r.dcs == null ? null : Number(r.dcs),
  evidence: r.evidence || null, name: r.name || '',
} : null;
const csvq = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const iso = ms => new Date(ms).toISOString();
const fill = (s, p) => p ? s.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : s;
const msg = (key, p) => ({ key, p, text: fill(key, p) });

const CMD = {
  bind_receiver: 0x01, bind_transmitter: 0x02, submit_sm: 0x04, deliver_sm: 0x05,
  unbind: 0x06, bind_transceiver: 0x09, enquire_link: 0x15, generic_nack: 0x80000000,
};
const RESP = 0x80000000;
const ST = { OK: 0, RBINDFAIL: 0x0d, RTHROTTLED: 0x58, RSUBMITFAIL: 0x45, RINVCMDID: 0x03 };
const TICK_MS = 10, BUDGET_MS = 4;            // DLR work: every 10 ms, at most 4 ms of it
const DLR_SOCKET_BYTES = 256 * 1024;          // DLRs wait while this much is still queued for a socket
// deliver_sm_resp errors that mean "never": counted as permanent failures, not retried
const PERMANENT_DEFAULT = '0x01,0x02,0x03,0x0A,0x0B,0x0C';

function cstr(buf, off) {
  let e = off; while (e < buf.length && buf[e] !== 0) e++;
  return [buf.toString('latin1', off, e), e + 1];
}
function header(cmd, status, seq, bodyLen) {
  const b = Buffer.allocUnsafe(16 + bodyLen);
  b.writeUInt32BE(16 + bodyLen, 0); b.writeUInt32BE(cmd >>> 0, 4);
  b.writeUInt32BE(status >>> 0, 8); b.writeUInt32BE(seq >>> 0, 12);
  return b;
}
function respWithCstr(cmd, status, seq, s) {
  const sb = Buffer.from(s + '\0', 'latin1');
  const b = header(cmd | RESP, status, seq, sb.length); sb.copy(b, 16); return b;
}
function emptyResp(cmd, status, seq) { return header(cmd | RESP, status, seq, 0); }
const ymdhm = ts => new Date(ts).toISOString().replace(/[-T:]/g, '').slice(2, 12);

// message_id: <start-time prefix>-<counter>, unique across restarts and across vendor processes.
// The prefix is the start time in ms (hex) plus 16 random bits, and it is renewed on every start, so a restart can
// never hand out an id the gateway has already seen. The counter never wraps (up to 2^53). About 20 characters,
// well inside SMPP 3.4's 65-byte message_id. The dash keeps gateways from treating the id as a hex or decimal number.
let lastPrefixMs = 0;
function idPrefix() {
  const ms = Math.max(Date.now(), lastPrefixMs + 1); lastPrefixMs = ms;
  return ms.toString(16).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}

const num = (v, d) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? d : n; };

class MockSmsc extends EventEmitter {
  constructor() {
    super();
    this.server = null; this.conns = new Set(); this.idc = 0; this.idPrefix = idPrefix();
    this.stats = { rx: 0, throttled: 0, dlrSent: 0, binds: 0 };
    this.seq = 1; this.o = { dlrRedelivery: false, dlrDelaySample: () => 0 }; this._dlrInit();
    this.resetE2e(); this.clearMsgs(); this.resetMetrics();
  }

  nextId() {
    const n = this.idc++;
    if (this.o && this.o.idReuse) return (0x100000 + n % this.o.idReuse).toString(16).toUpperCase(); // deliberate repeats
    return this.idPrefix + '-' + n.toString(16).toUpperCase();
  }

  // Last KEEP submit_sm kept raw (cheap at high TPS); decoded only when the list is asked for
  clearMsgs() { this.msgs = new Array(KEEP); this.msgHead = 0; this.msgTotal = 0; this.encCount = {}; }

  // Routing test: new prefixes for a vendor that stays up between tests
  // Routing test failover: take this vendor down (drop every bind, refuse new connections) and bring it back.
  // Counters and the evidence file carry on, so the report covers the whole test.
  suspend() {
    if (this.suspended || !this.server) return; this.suspended = true;
    this.server.close(); this.server = null;
    for (const c of this.conns) try { c.sock.destroy(); } catch {}
    this.emit('log', msg('Vendor down: all binds dropped, port {port} closed', { port: this.o.port }));
  }
  resume() {
    if (!this.suspended) return; this.suspended = false;
    this.server = net.createServer(sock => this._onConn(sock));
    this.server.on('error', e => this.emit('log', { text: 'Server error: ' + e.message }));
    this.server.listen(this.o.port, this.o.host, () => this.emit('log', msg('Vendor up again on port {port}', { port: this.o.port })));
  }
  setRouting(r) { this._evClose(); this.o.routing = routingOpts(r); this._rtReset(); this._evOpen(); }
  _rtReset() { this.rt = new Map(); this.rtMis = 0; this.rtFo = 0; this.rtSamples = []; this.rc = { marked: 0, unmarked: 0, broken: 0, textChanged: 0, dcsChanged: 0 }; this.rcSamples = []; }

  // Routing test evidence: one CSV row per message this vendor received, gzipped in the background. The file is a
  // series of gzip members (valid gzip; Node's gunzip reads it whole).
  _evOpen() {
    const R = this.o.routing; if (!R || !R.evidence) return;
    try { fs.mkdirSync(path.dirname(R.evidence), { recursive: true }); fs.writeFileSync(R.evidence, zlib.gzipSync('vendor,client,prefix,destination,source,vendor_message_id,marker,submitted_utc,received_utc,e2e_ms,data_coding,marker_ok,text_ok,data_coding_ok,duplicate\n')); }
    catch (e) { this.emit('log', { text: 'Evidence file not written: ' + e.message }); return; }
    this.ev = { file: R.evidence, buf: [], rows: 0, chain: Promise.resolve() };
    this.evTimer = setInterval(() => this._evFlush(), 1000);
  }
  _evFlush() {
    const ev = this.ev; if (!ev || !ev.buf.length) return ev ? ev.chain : Promise.resolve();
    const chunk = ev.buf.join(''); ev.buf = [];
    ev.chain = ev.chain.then(() => new Promise(res => zlib.gzip(chunk, (e, gz) => { if (e) return res(); fs.appendFile(ev.file, gz, () => res()); })));
    return ev.chain;
  }
  // Wait for everything written so far, then stop writing (the report links the file)
  async evidenceClose() { const ev = this.ev; if (!ev) return null; clearInterval(this.evTimer); await this._evFlush(); this.ev = null; return { file: ev.file, rows: ev.rows }; }
  _evClose() { const ev = this.ev; if (!ev) return; clearInterval(this.evTimer); if (ev.buf.length) try { fs.appendFileSync(ev.file, zlib.gzipSync(ev.buf.join(''))); } catch {} this.ev = null; }
  resetE2e() { this.e2e = { n: 0, dup: 0, hist: new Hist(), sec: new Hist(), seen: new Set() }; this._rtReset(); }

  start(opts = {}) {
    if (this.server) return;
    const red = (opts.dlr && opts.dlr.redelivery) || {};
    const port = Number(opts.port) || 2775;
    this.o = {
      port, host: opts.bindHost || '127.0.0.1',
      // DLR delay after submit (ms): fixed, or drawn from a distribution (uniform: ± spread, normal: σ = spread, exponential)
      dlrDelay: Math.max(0, num(opts.dlrDelay, 1500)),
      dlrDelayMode: ['fixed', 'uniform', 'normal', 'exponential'].includes(opts.dlrDelayMode) ? opts.dlrDelayMode : 'fixed',
      dlrDelaySpread: Math.max(0, num(opts.dlrDelaySpread, 0)),
      failRate: Math.max(0, Math.min(1, Number(opts.failRate || 0))),
      maxTps: Math.max(0, Number(opts.maxTps || 0)),          // 0 = unlimited
      respDelay: Math.max(0, Number(opts.respDelay || 0)),
      capacity: Math.max(0, Number(opts.capacity || 0)),       // 0 = unlimited; above it responses wait in a queue
      maxBinds: Math.max(0, Number(opts.maxBinds || 0)),       // 0 = unlimited; extra binds get no answer
      systemId: opts.systemId || '', password: opts.password || '',
      // Test scenario only: hand out the same short ids again every N submits (0 = off, the default)
      idReuse: Math.max(0, Math.floor(Number(opts.idReuse || 0))),
      // DLR redelivery (dlr.redelivery.*): undeliverable DLRs are kept per system_id, survive a restart (journal in
      // stateDir) and go out when that system_id binds again; the backlog then drains at dlrRedeliveryTps
      dlrRedelivery: (red.enabled ?? opts.dlrRedelivery) !== false,
      dlrRedeliveryTps: Math.max(1, num(red.tps ?? opts.dlrRedeliveryTps, 500)),
      dlrRetentionMs: Math.max(0.0001, num(red.retentionHours ?? opts.dlrRetentionHours, 72)) * 3600e3, // max age
      // DLR flow: window (unconfirmed deliver_sm per connection) and optional rate limits (0 = unlimited)
      dlrWindow: Math.max(1, num(opts.dlrWindow, 1000)),
      dlrMaxTps: Math.max(0, num(opts.dlrMaxTps, 0)),
      dlrMaxTpsPerBind: Math.max(0, num(opts.dlrMaxTpsPerBind, 0)),
      dlrRespTimeoutMs: Math.max(0.1, num(opts.dlrRespTimeout, 30)) * 1000,
      // Retries after an error or no answer: exponential back-off with jitter between these bounds
      dlrRetryMinMs: Math.max(10, num(opts.dlrRetryMinMs, 1000)),
      dlrRetryMaxMs: Math.max(10, num(opts.dlrRetryMaxMs, 30000)),
      dlrMaxAttempts: Math.max(0, Math.floor(num(opts.dlrMaxAttempts, 0))),     // 0 = no limit (max age still applies)
      dlrPermanentErrors: parseCodes(opts.dlrPermanentErrors, PERMANENT_DEFAULT),
      maxPendingDlr: Math.max(1, num(opts.maxPendingDlr, 5000000)),
      stateDir: opts.stateDir || '',
      // Metrics: HTTP endpoint (0 = off) and a one-line summary every metricsIntervalMs on stdout
      metricsPort: opts.metricsPort === 0 || opts.metricsPort === '0' ? 0 : Math.max(0, num(opts.metricsPort, port + 1000)),
      metricsHost: opts.metricsHost || '127.0.0.1',
      metricsLog: !!opts.metricsLog,
      metricsIntervalMs: Math.max(1000, num(opts.metricsIntervalMs, 5000)),
      // Routing test: the prefixes in play (longest match wins) and the ones this vendor should receive.
      // Messages are counted per client (from the end-to-end marker) × prefix; a prefix not expected here is a misroute.
      routing: routingOpts(opts.routing),
    };
    this.o.dlrDelaySample = delaySampler(this.o.dlrDelayMode, this.o.dlrDelay, this.o.dlrDelaySpread);
    this.idPrefix = idPrefix(); this.idc = 0; // fresh, never-seen ids after every (re)start
    this.stopping = false;
    this.resetMetrics();
    this._dlrInit();
    this.server = net.createServer(sock => this._onConn(sock));
    this.server.on('error', e => {
      const m = e.code === 'EADDRINUSE' ? msg('Port {port} is already in use', { port: this.o.port })
        : e.code === 'EACCES' ? msg('No permission for port {port} (choose a port above 1024)', { port: this.o.port })
        : { text: e.message };
      if (!this.listening) { this.emit('listenError', m); this.stop(); } else this.emit('log', { ...m, text: 'Server error: ' + m.text });
    });
    this.server.listen(this.o.port, this.o.host, () => {
      this.listening = true; this.emit('listening');
      this.emit('log', this.o.maxTps ? msg('Vendor listening on {host}:{port} (limit {tps} TPS)', { host: this.o.host, port: this.o.port, tps: this.o.maxTps }) : msg('Vendor listening on {host}:{port}', { host: this.o.host, port: this.o.port }));
    });
    this._startMetricsHttp();
    this.secStart = Date.now(); this.secCount = 0;
    this.timer = setInterval(() => this._tick(), TICK_MS);
    this.respQ = []; this.respHead = 0; this.nextFree = 0;
    if (this.o.capacity) this.capTimer = setInterval(() => this._flushResp(), 2);
    this.statTimer = setInterval(() => this._secondStats(), 1000);
    this._evOpen();
    this.metricsTimer = setInterval(() => this._metricsWindow(), this.o.metricsIntervalMs);
  }

  _secondStats() {
    const e = this.e2e, D = this.D, M = this.M, bySid = {};
    let retryWaiting = 0;
    for (const S of D.sids.values()) { if (S.pending) bySid[S.sid] = S.pending; retryWaiting += S.retry.size; }
    const r = this.sec.resp.summary(); this.sec.resp = new Hist();
    this.emit('stats', { ...this.stats, msgTotal: this.msgTotal, conns: [...this.conns].filter(c => c.bound).length,
      dlrPending: D.pending, dlrPendingBySid: bySid, dlrRetryWaiting: retryWaiting,
      dlrRedelivered: M.redelivered, dlrExpired: M.expired, dlrDropped: M.dropped, dlrRetried: M.retried,
      dlrRejected: Object.values(M.rejectedByCode).reduce((a, b) => a + b, 0), dlrPermanentFailed: M.permanentFailed,
      submitRespP99: r.p99 ?? null,
      respQueue: (this.respQ || []).length - (this.respHead || 0),
      e2e: { n: e.n, dup: e.dup, sec: e.sec.summary(), total: e.hist.summary() },
      routing: this.o.routing ? { misroute: this.rtMis, failover: this.rtFo, samples: this.rtSamples, content: { ...this.rc, samples: this.rcSamples }, evidenceRows: this.ev ? this.ev.rows : null, cells: [...this.rt.values()].map(x => ({ client: x.client, prefix: x.prefix, n: x.n, dup: x.dup, mis: x.mis, fo: x.fo, lat: x.lat.summary() })) } : undefined });
    e.sec = new Hist();
    this.stats.rx = 0; this.stats.throttled = 0; this.stats.dlrSent = 0;
  }

  _onConn(sock) {
    sock.setNoDelay(true);
    const c = { sock, bound: false, rx: false, buf: Buffer.alloc(0), hi: [], hiT: [], lo: [], loBytes: 0, inflight: new Map(), tok: 0, tokAt: 0, rxT: 0 };
    this.conns.add(c);
    sock.on('data', d => { c.rxT = performance.now(); c.buf = c.buf.length ? Buffer.concat([c.buf, d]) : d; this._parse(c); });
    sock.on('error', () => {});
    sock.on('close', () => { this.conns.delete(c); this._connClosed(c); });
  }

  // Two output queues per connection. hi: responses (t0 = when the request arrived, for the submit_sm_resp latency
  // metric; -1 = not measured). lo: DLRs and MOs, written after the responses and only while the socket keeps up.
  _write(c, b, t0 = -1) { c.hi.push(b); c.hiT.push(t0); this._schedFlush(c); }
  _writeLo(c, b) { c.lo.push(b); c.loBytes += b.length; this._schedFlush(c); }
  _schedFlush(c) { if (!c.flushPending) { c.flushPending = true; setImmediate(() => this._flush(c)); } }
  _flush(c) {
    c.flushPending = false;
    if (c.sock.destroyed) { c.hi = []; c.hiT = []; c.lo = []; c.loBytes = 0; return; }
    if (c.hi.length) {
      c.sock.write(c.hi.length === 1 ? c.hi[0] : Buffer.concat(c.hi));
      const now = performance.now();
      for (const t of c.hiT) if (t >= 0) { const l = now - t; this.M.resp.add(l); this.win.resp.add(l); this.sec.resp.add(l); }
      c.hi = []; c.hiT = [];
    }
    if (c.lo.length) {
      if (c.sock.writableLength < DLR_SOCKET_BYTES) { c.sock.write(c.lo.length === 1 ? c.lo[0] : Buffer.concat(c.lo)); c.lo = []; c.loBytes = 0; }
      else if (!c.waitDrain) { c.waitDrain = true; c.sock.once('drain', () => { c.waitDrain = false; this._schedFlush(c); }); }
    }
  }

  _parse(c) {
    let off = 0; const buf = c.buf;
    while (buf.length - off >= 16) {
      const len = buf.readUInt32BE(off);
      if (len < 16 || len > 70000) { c.sock.destroy(); return; }
      if (buf.length - off < len) break;
      this._handle(c, buf.readUInt32BE(off + 4), buf.readUInt32BE(off + 12), buf.subarray(off + 16, off + len), buf.readUInt32BE(off + 8));
      off += len;
    }
    c.buf = off === buf.length ? Buffer.alloc(0) : buf.subarray(off);
  }

  _handle(c, cmd, seq, body, status) {
    switch (cmd) {
      case CMD.bind_transceiver: case CMD.bind_receiver: case CMD.bind_transmitter: {
        const [sid, p1] = cstr(body, 0); const [pw] = cstr(body, p1);
        // For testing: ignore binds beyond the limit (some SMSCs behave like this)
        if (this.o.maxBinds && [...this.conns].filter(x => x.bound).length >= this.o.maxBinds) return;
        const ok = !this.o.systemId || (sid === this.o.systemId && pw === this.o.password);
        this._write(c, respWithCstr(cmd, ok ? ST.OK : ST.RBINDFAIL, seq, 'MOCKSMSC'));
        const ip = String(c.sock.remoteAddress || '').replace(/^::ffff:/, '');
        if (ok) { c.bound = true; c.rx = cmd !== CMD.bind_transmitter; c.sid = sid; this.stats.binds++; if (this.o.routing) this.emit('log', msg('Bound: system_id {sid} from {ip}', { sid, ip })); }
        else {
          setTimeout(() => c.sock.end(), 50);
          // A wrong login is the usual reason a platform cannot connect: say so, at most every 5 s
          const now = Date.now(); if (!this.lastBindFail || now - this.lastBindFail > 5000) { this.lastBindFail = now; this.emit('log', msg('Bind rejected: system_id "{sid}" from {ip} (wrong system_id or password)', { sid, ip })); }
        }
        return;
      }
      case CMD.enquire_link: return this._write(c, emptyResp(cmd, 0, seq));
      case CMD.unbind: this._write(c, emptyResp(cmd, 0, seq)); setTimeout(() => c.sock.end(), 20); return;
      case CMD.submit_sm: return this._submit(c, seq, body);
      case (CMD.deliver_sm | RESP) >>> 0: return this._dlrResp(c, seq, status); // >>> 0: the header is read unsigned
      case (CMD.enquire_link | RESP) >>> 0: case CMD.generic_nack: return;
      default:
        if (cmd & RESP) return;
        return this._write(c, header(CMD.generic_nack, ST.RINVCMDID, seq, 0));
    }
  }

  _submit(c, seq, body) {
    const t0 = c.rxT;
    if (!c.bound) return this._write(c, respWithCstr(CMD.submit_sm, 0x04, seq, ''));
    this.stats.rx++; this.M.submitted++; this.win.submitted++;
    const now = Date.now();
    if (this.o.maxTps) {
      if (now - this.secStart >= 1000) { this.secStart = now; this.secCount = 0; }
      if (++this.secCount > this.o.maxTps) { this.stats.throttled++; this.M.throttled++; return this._write(c, respWithCstr(CMD.submit_sm, ST.RTHROTTLED, seq, ''), t0); }
    }
    const id = this.nextId();
    const resp = respWithCstr(CMD.submit_sm, ST.OK, seq, id);
    if (this.o.capacity) {
      // Fixed processing rate: above capacity the queue and latency grow, like a real system
      this.nextFree = Math.max(now, this.nextFree) + 1000 / this.o.capacity;
      this.respQ.push({ due: this.nextFree + this.o.respDelay, c, resp, t0 });
    } else if (this.o.respDelay) setTimeout(() => this._write(c, resp, t0), this.o.respDelay); else this._write(c, resp, t0);

    // Skip ahead to registered_delivery
    let p = 0, s;
    [, p] = cstr(body, p);                 // service_type
    const srcTon = body[p], srcNpi = body[p + 1]; p += 2;
    [s, p] = cstr(body, p); const src = s;
    const dstTon = body[p], dstNpi = body[p + 1]; p += 2;
    [s, p] = cstr(body, p); const dst = s;
    const esm = body[p]; p += 3;            // esm, protocol, priority
    [, p] = cstr(body, p); [, p] = cstr(body, p); // schedule, validity
    const reg = body[p] & 0x03;
    const { dcs, sm } = this._sm(body, p);
    const e2 = this._e2e(dcs, sm, now);
    if (this.o.routing) this._route(c, dst, src, id, dcs, esm, sm, e2, now);
    // Keep a copy for the "Vendor messages" list: what arrived, from which account, in which encoding
    this.msgs[this.msgHead] = { t: now, sid: c.sid || '', src, srcTon, dst, dstTon, esm, dcs, reg, id, sm: Buffer.from(sm) };
    this.msgHead = (this.msgHead + 1) % KEEP; this.msgTotal++;
    this.encCount[dcs] = (this.encCount[dcs] || 0) + 1;
    if (reg) this._dlrCreate(c.sid || '', id, src, srcTon, srcNpi, dst, dstTon, dstNpi, now);
  }

  // data_coding and the message bytes (short_message, or the message_payload TLV when short_message is empty)
  _sm(body, p) {
    let q = p + 1;                         // replace_if_present
    q++; const dcs = body[q++]; q++;       // data_coding, sm_default_msg_id
    const len = body[q++]; let sm = body.subarray(q, q + len); q += len;
    if (!len) {
      while (q + 4 <= body.length) { const tag = body.readUInt16BE(q), l = body.readUInt16BE(q + 2); if (tag === 0x0424) { sm = body.subarray(q + 4, q + 4 + l); break; } q += 4 + l; }
    }
    return { dcs: dcs || 0, sm };
  }

  // Newest first, decoded, filtered by q (number, account, message id or text; case-insensitive)
  listMsgs(q = '', limit = 500) {
    const out = [], needle = String(q || '').trim().toLowerCase();
    for (let k = 1; k <= KEEP && out.length < limit; k++) {
      const m = this.msgs[(this.msgHead - k + KEEP) % KEEP]; if (!m) break;
      const d = decodeSm(m.dcs, m.esm, m.sm);
      const row = { t: m.t, sid: m.sid, src: m.src, srcTon: m.srcTon, dst: m.dst, dstTon: m.dstTon, dcs: m.dcs, enc: d.enc, encLabel: d.encLabel,
        parts: d.parts, text: d.text, bytes: d.bytes, hex: d.hex, udh: !!d.udh, reg: m.reg, id: m.id };
      if (needle && ![row.src, row.dst, row.sid, row.id, row.text].some(v => String(v).toLowerCase().includes(needle))) continue;
      out.push(row);
    }
    return { list: out, total: this.msgTotal, kept: Math.min(this.msgTotal, KEEP), enc: { ...this.encCount } };
  }

  // Pick up the #T<13-digit epoch ms><7-digit counter> marker added by the client → end-to-end latency, duplicates
  _e2e(dcs, sm, now) {
    if (!sm.length) return;
    let txt;
    if ((dcs & 0x0f) === 8) { const le = Buffer.allocUnsafe(sm.length & ~1); for (let i = 0; i + 1 < sm.length; i += 2) { le[i] = sm[i + 1]; le[i + 1] = sm[i]; } txt = le.toString('utf16le'); }
    else txt = sm.toString('latin1');
    const mt = TAG.exec(txt); if (!mt) return;
    const e = this.e2e, key = mt[1] + mt[2], client = mt[2].charCodeAt(0) - 48;
    if (e.seen.has(key)) { e.dup++; return { client, dup: true }; }
    e.seen.add(key); if (e.seen.size > 3000000) e.seen.clear();
    e.n++; const lat = Math.max(0, now - Number(mt[1])); e.hist.add(lat); e.sec.add(lat);
    return { client, lat };
  }

  // Routing test: count the message under client × prefix; a prefix this vendor should not get is a misroute
  _route(c, dst, src, id, dcs, esm, sm, e2, now) {
    const R = this.o.routing, d = normNum(dst);
    const prefix = R.prefixes.find(p => d.startsWith(p)) || 'other';
    const client = e2 ? e2.client : 0, k = client + '|' + prefix;
    let cell = this.rt.get(k);
    if (!cell) this.rt.set(k, cell = { client, prefix, n: 0, dup: 0, mis: 0, fo: 0, lat: new Hist() });
    // Content check: marker intact? text before it and data_coding as sent?
    const txt = decodeSm(dcs, esm, sm).text || '', rc = this.rc;
    const mt = TAG.exec(txt), markerOk = !!mt, broken = !mt && txt.includes('#T');
    const at = mt ? mt.index : broken ? txt.indexOf('#T') : txt.length, body = txt.slice(0, at).replace(/ $/, '');
    const textOk = R.text == null || body === R.text, dcsOk = R.dcs == null || dcs === R.dcs;
    if (!(e2 && e2.dup)) {
      if (markerOk) rc.marked++; else if (broken) rc.broken++; else rc.unmarked++;
      if (!textOk) rc.textChanged++;
      if (!dcsOk) rc.dcsChanged++;
      if ((!markerOk || !textOk || !dcsOk) && this.rcSamples.length < 20)
        this.rcSamples.push({ t: now, client, dst, kind: !markerOk ? (broken ? 'broken' : 'unmarked') : !textOk ? 'text' : 'dcs', dcs, expectDcs: R.dcs, text: txt.slice(0, 200), expectText: R.text });
    }
    if (this.ev) {
      this.ev.rows++;
      this.ev.buf.push([R.name, client || '', prefix, dst, src, id, mt ? mt[0].slice(2) : '', mt ? iso(Number(mt[1])) : '', iso(now), e2 && !e2.dup ? Math.round(e2.lat) : '', dcs,
        markerOk ? 1 : 0, textOk ? 1 : 0, dcsOk ? 1 : 0, e2 && e2.dup ? 1 : 0].map(csvq).join(',') + '\n');
    }
    if (e2 && e2.dup) { cell.dup++; return; }
    cell.n++; if (e2) cell.lat.add(e2.lat);
    if (R.expect.size && !R.expect.has(prefix) && R.backup.has(prefix)) { cell.fo++; this.rtFo++; }
    else if (R.expect.size && !R.expect.has(prefix)) {
      cell.mis++; this.rtMis++;
      if (this.rtSamples.length < 20) this.rtSamples.push({ t: now, dst, client, sid: c.sid || '' });
    }
  }

  _flushResp() {
    const now = Date.now(), q = this.respQ; let h = this.respHead;
    while (h < q.length && q[h].due <= now) { const r = q[h++]; if (!r.c.sock.destroyed) this._write(r.c, r.resp, r.t0); }
    if (h > 50000 || h === q.length) { this.respQ = q.slice(h); h = 0; }
    this.respHead = h;
  }

  // ---------- DLRs ----------
  // A DLR is decided once, when the message is submitted (id, stat, submit and done date), and never changes: a
  // redelivered DLR is byte-for-byte the first attempt. The PDU is built from those fields each time it is sent, so a
  // pending DLR costs a few hundred bytes of memory.
  _dlrPdu(r, seq) {
    if (r.body) { const h = header(CMD.deliver_sm, 0, seq, r.body.length); r.body.copy(h, 16); return h; } // restored from 1.6.0
    const txt = `id:${r.id} sub:001 dlvrd:${r.fail ? '000' : '001'} submit date:${ymdhm(r.created)} done date:${ymdhm(r.due)} stat:${r.fail ? 'UNDELIV' : 'DELIVRD'} err:${r.fail ? '001' : '000'} text:`;
    const len = 1 + 2 + r.dst.length + 1 + 2 + r.src.length + 1 + 10 + txt.length + 4 + r.id.length + 1 + 5;
    const b = header(CMD.deliver_sm, 0, seq, len); let o = 16;
    b[o++] = 0;                                                         // service_type
    b[o++] = r.dstTon; b[o++] = r.dstNpi; o += b.write(r.dst, o, 'latin1'); b[o++] = 0;
    b[o++] = r.srcTon; b[o++] = r.srcNpi; o += b.write(r.src, o, 'latin1'); b[o++] = 0;
    b[o++] = 0x04; for (let i = 0; i < 8; i++) b[o++] = 0; b[o++] = txt.length; // esm_class 0x04 (receipt) .. sm_length
    o += b.write(txt, o, 'latin1');
    b.writeUInt16BE(0x001e, o); b.writeUInt16BE(r.id.length + 1, o + 2); o += 4;   // receipted_message_id
    o += b.write(r.id, o, 'latin1'); b[o++] = 0;
    b[o++] = 0x04; b[o++] = 0x27; b[o++] = 0; b[o++] = 1; b[o++] = r.fail ? 5 : 2; // message_state
    return b;
  }

  _dlrInit() {
    if (this.journal) this.journal.close();
    this.journal = null;
    this.D = { delay: new MinHeap('due'), sids: new Map(), pending: 0, n: 0, tok: 0, tokAt: 0, nextCheck: 0 };
    if (!this.o.dlrRedelivery || !this.o.stateDir) return;
    // Pending DLRs from the last run come back first, oldest first, and go out when their system_id binds
    const file = path.join(this.o.stateDir, `dlr-queue-${this.o.port}.log`);
    const now = Date.now(); let keep = [], expired = 0;
    try { for (const r of journal.load(file)) (now - r.created > this.o.dlrRetentionMs ? expired++ : keep.push(r)); }
    catch (e) { this.emit('log', { text: 'DLR queue file unreadable, starting empty: ' + e.message }); keep = []; }
    journal.rewrite(file, keep);
    for (const r of keep) {
      Object.assign(r, { held: true, fails: 0, nextAt: 0, attempts: 0, c: null, gone: false });
      this.D.pending++; this._sid(r.sid).pending++;
      if (r.due > now) this.D.delay.push(r); else this._sid(r.sid).q.push(r);
    }
    this.D.n = keep.length ? keep[keep.length - 1].n + 1 : 0;
    this.M.expired += expired;
    this.journal = new journal.JournalWriter(file, keep.length);
    if (keep.length || expired) this.emit('log', msg('Restored {n} pending DLRs from the last run ({exp} expired)', { n: keep.length, exp: expired }));
  }

  _sid(sid) {
    let S = this.D.sids.get(sid);
    if (!S) this.D.sids.set(sid, S = { sid, q: [], qh: 0, retry: new MinHeap('nextAt'), pending: 0, tokens: 0, last: Date.now(), down: false });
    return S;
  }

  _dlrCreate(sid, id, src, srcTon, srcNpi, dst, dstTon, dstNpi, now) {
    const D = this.D;
    if (D.pending >= this.o.maxPendingDlr) return this._count('dropped', 'overflow');
    const n = D.n++;
    const r = { k: this.idPrefix + '.' + n.toString(36), sid, created: now, due: now + this.o.dlrDelaySample(), n, id, src, srcTon, srcNpi, dst, dstTon, dstNpi,
      fail: this.o.failRate > 0 && Math.random() < this.o.failRate, held: false, fails: 0, nextAt: 0, attempts: 0, c: null, gone: false };
    D.pending++; this._sid(sid).pending++;
    if (this.journal) this.journal.add(r);
    D.delay.push(r);
  }

  _count(what, reason) {
    const M = this.M; M[what]++; this.win[what] = (this.win[what] || 0) + 1;
    if (reason) M.dropReasons[reason] = (M.dropReasons[reason] || 0) + 1;
  }

  // Off the queue for good: confirmed, failed permanently, expired or dropped
  _dlrGone(r, why, reason) {
    if (r.gone) return;
    r.gone = true; this.D.pending--; this._sid(r.sid).pending--;
    if (this.journal) this.journal.remove(r.k);
    if (why === 'ok' || why === 'redelivered') { this.M.confirmed++; this.win.confirmed++; if (why === 'redelivered') this.M.redelivered++; }
    else this._count(why, reason);
  }

  // Not confirmed: a transient error or no deliver_sm_resp in time. Retried after an exponential back-off with jitter
  // (dlrRetryMinMs … dlrRetryMaxMs), until it is confirmed, fails permanently, reaches dlrMaxAttempts or its max age.
  _dlrFail(r, now) {
    if (!this.o.dlrRedelivery) return this._dlrGone(r, 'dropped', 'redeliveryOff');
    if (this.o.dlrMaxAttempts && r.attempts >= this.o.dlrMaxAttempts) return this._dlrGone(r, 'dropped', 'maxAttempts');
    if (now - r.created > this.o.dlrRetentionMs) return this._dlrGone(r, 'expired');
    r.fails++; r.nextAt = now + backoff(r.fails, this.o.dlrRetryMinMs, this.o.dlrRetryMaxMs);
    this.M.retried++;
    this._sid(r.sid).retry.push(r);
  }

  _dlrResp(c, seq, status) {
    const r = c.inflight.get(seq); if (!r) return; // e.g. the response to an MO
    c.inflight.delete(seq); r.c = null;
    if (status === 0) return this._dlrGone(r, r.held || r.attempts > 1 ? 'redelivered' : 'ok');
    const k = hex(status); this.M.rejectedByCode[k] = (this.M.rejectedByCode[k] || 0) + 1; this.win.rejected++;
    if (this.o.dlrPermanentErrors.has(status)) return this._dlrGone(r, 'permanentFailed');
    this._dlrFail(r, Date.now());
  }

  // The connection dropped: whatever it had not confirmed goes back to be sent again first (no back-off: the client
  // did not refuse it), oldest first
  _connClosed(c) {
    if (this.stopping || !c.inflight.size) return;
    for (const r of c.inflight.values()) {
      r.c = null;
      if (!this.o.dlrRedelivery) { this._dlrGone(r, 'dropped', 'redeliveryOff'); continue; }
      r.held = true; r.nextAt = r.n / 1e12; // sorts by creation, all due now
      this._sid(r.sid).retry.push(r);
    }
    c.inflight.clear();
  }

  _dlrSend(c, r, now) {
    const seq = this.seq++; if (this.seq > 0x7ffffff0) this.seq = 1;
    r.c = c; r.sentAt = now; r.attempts++;
    c.inflight.set(seq, r);
    this._writeLo(c, this._dlrPdu(r, seq)); this.stats.dlrSent++; this.M.dlrSent++; this.win.dlrSent++;
  }

  // Token buckets: total and per bind (0 = unlimited), with a small burst so 10 ms ticks stay smooth
  _refill(o, rate, now) {
    if (!rate) return;
    o.tok = Math.min(Math.max(1, rate * 0.05), o.tok + rate * (now - (o.tokAt || now)) / 1000); o.tokAt = now;
  }

  // Sends what is due for one system_id: retries whose back-off has passed first (they are the oldest), then the
  // queue in order. The reconnect backlog (held) drains at dlrRedeliveryTps; error retries are not rate-limited by it
  // and never block fresh DLRs. Window, socket back-pressure, rate limits and the tick's time budget apply to all.
  _drain(S, now, deadline) {
    if (S.qh >= S.q.length && !S.retry.size) return true;
    const conns = this.rxBySid.get(S.sid);
    if (!conns || !conns.length) {
      if (!this.o.dlrRedelivery) { // nobody to send to and redelivery off: dropped (counted)
        for (let i = S.qh; i < S.q.length; i++) this._dlrGone(S.q[i], 'dropped', 'redeliveryOff');
        for (const r of S.retry.a) this._dlrGone(r, 'dropped', 'redeliveryOff');
        S.q = []; S.qh = 0; S.retry = new MinHeap('nextAt'); return true;
      }
      if (!S.down) { S.down = true; for (let i = S.qh; i < S.q.length; i++) S.q[i].held = true; }
      return true;
    }
    if (S.down) {
      S.down = false; S.tokens = 0; S.last = now;
      const n = S.q.length - S.qh + S.retry.size;
      if (n) this.emit('log', msg('Started delivering {n} pending DLRs to {sid}', { n, sid: S.sid || '—' }));
    }
    const rate = this.o.dlrRedeliveryTps;
    S.tokens = Math.min(Math.max(1, rate / 10), S.tokens + rate * (now - S.last) / 1000); S.last = now;
    const W = this.o.dlrWindow, D = this.D, total = this.o.dlrMaxTps, perBind = this.o.dlrMaxTpsPerBind;
    let i = 0, finished = true;
    for (;;) {
      if ((++i & 31) === 0 && performance.now() > deadline) { finished = false; break; }
      if (total && D.tok < 1) break;
      let c = null;
      for (const x of conns) {
        if (x.inflight.size >= W || x.loBytes + x.sock.writableLength >= DLR_SOCKET_BYTES || (perBind && x.tok < 1)) continue;
        if (!c || x.inflight.size < c.inflight.size) c = x;
      }
      if (!c) break;
      let r;
      const top = S.retry.peek();
      if (top && top.nextAt <= now) r = S.retry.pop();
      else if (S.qh < S.q.length) {
        r = S.q[S.qh];
        if (r.held) { if (S.tokens < 1) break; S.tokens--; }
        S.qh++;
      } else break;
      if (r.gone) continue;
      if (now - r.created > this.o.dlrRetentionMs) { this._dlrGone(r, 'expired'); continue; }
      if (total) D.tok--; if (perBind) c.tok--;
      this._dlrSend(c, r, now);
    }
    if (S.qh > 50000 || S.qh === S.q.length) { S.q = S.qh === S.q.length ? [] : S.q.slice(S.qh); S.qh = 0; }
    return finished;
  }

  _dlrHousekeeping(now) {
    const D = this.D, ret = this.o.dlrRetentionMs, to = this.o.dlrRespTimeoutMs;
    // deliver_sm sent but no deliver_sm_resp in time: retried like a transient error
    for (const c of this.conns) for (const [seq, r] of c.inflight) {
      if (now - r.sentAt < to) break;
      c.inflight.delete(seq); r.c = null; this.M.timeouts++; this._dlrFail(r, now);
    }
    // Older than the max age: dropped and counted as expired (queue heads; retries are checked when they come due)
    for (const S of D.sids.values()) {
      while (S.qh < S.q.length && now - S.q[S.qh].created > ret) this._dlrGone(S.q[S.qh++], 'expired');
      if (S.down && S.retry.size && now - S.retry.peek().created > ret) S.retry.removeWhere(r => now - r.created > ret).forEach(r => this._dlrGone(r, 'expired'));
    }
  }

  _tick() {
    const now = Date.now(), D = this.D, deadline = performance.now() + BUDGET_MS;
    // DLRs whose delay has passed move to their system_id's queue
    for (let i = 0; D.delay.size && D.delay.peek().due <= now; i++) {
      if ((i & 255) === 255 && performance.now() > deadline) break;
      const r = D.delay.pop(); if (r.gone) continue;
      const S = this._sid(r.sid); if (S.down) r.held = true; S.q.push(r);
    }
    // Receivers per system_id, once per tick
    this.rxBySid = new Map();
    for (const c of this.conns) {
      if (!c.bound || !c.rx || c.sock.destroyed) continue;
      let l = this.rxBySid.get(c.sid); if (!l) this.rxBySid.set(c.sid, l = []); l.push(c);
      this._refill(c, this.o.dlrMaxTpsPerBind, now);
    }
    this._refill(D, this.o.dlrMaxTps, now);
    // Round-robin start so one busy system_id cannot starve the others when the budget runs out
    const sids = [...D.sids.values()]; const start = sids.length ? (this.rr = ((this.rr || 0) + 1) % sids.length) : 0;
    for (let k = 0; k < sids.length; k++) if (!this._drain(sids[(start + k) % sids.length], now, deadline)) break;
    if (now >= D.nextCheck) { D.nextCheck = now + 1000; this._dlrHousekeeping(now); }
    if (this.journal) this.journal.flush();
  }

  // ---------- Metrics ----------
  // Counters since the last reset (resettable over HTTP), plus a window for rates and the periodic log line
  resetMetrics() {
    const prev = this.M;
    this.M = { since: Date.now(), submitted: 0, throttled: 0, dlrSent: 0, confirmed: 0, redelivered: 0, retried: 0, timeouts: 0,
      rejectedByCode: {}, permanentFailed: 0, dropped: 0, dropReasons: {}, expired: 0, resp: new Hist() };
    this.win = this._newWin(); this.sec = { resp: new Hist() };
    this.cpu = { at: performance.now(), usage: process.cpuUsage() };
    if (!this.loopDelay) { try { this.loopDelay = monitorEventLoopDelay({ resolution: 10 }); this.loopDelay.enable(); } catch {} }
    else this.loopDelay.reset();
    return prev;
  }
  _newWin() { return { at: performance.now(), submitted: 0, dlrSent: 0, confirmed: 0, rejected: 0, resp: new Hist() }; }

  // Gauges: what is waiting right now
  _depth() {
    let ready = 0, retry = 0, inflight = 0;
    for (const S of this.D.sids.values()) { ready += S.q.length - S.qh; retry += S.retry.size; }
    for (const c of this.conns) inflight += c.inflight.size;
    return { pending: this.D.pending, notYetDue: this.D.delay.size, ready, retryWaiting: retry, inflight };
  }

  metrics() {
    const M = this.M, w = this.win, secs = Math.max(0.001, (performance.now() - w.at) / 1000);
    const pct = h => { const s = h.summary(); return s.n ? { p50: +s.p50.toFixed(2), p95: +s.p95.toFixed(2), p99: +s.p99.toFixed(2), max: +s.max.toFixed(2), n: s.n } : { n: 0 }; };
    const nowP = performance.now(), cu = process.cpuUsage(this.cpu.usage), mem = process.memoryUsage();
    const cpuPct = (cu.user + cu.system) / 1000 / Math.max(1, nowP - this.cpu.at) * 100;
    return {
      since: new Date(M.since).toISOString(), seconds: Math.round((Date.now() - M.since) / 1000),
      binds: [...this.conns].filter(c => c.bound).length,
      submitResp: pct(M.resp),                                    // ms, request read → response written, since reset
      submitted: M.submitted, throttled: M.throttled,
      rates: { windowSeconds: +secs.toFixed(1), submitTps: Math.round(w.submitted / secs), dlrSentTps: Math.round(w.dlrSent / secs), dlrConfirmedTps: Math.round(w.confirmed / secs), dlrRejectedTps: Math.round(w.rejected / secs), submitResp: pct(w.resp) },
      dlr: { ...this._depth(), sent: M.dlrSent, confirmed: M.confirmed, redelivered: M.redelivered, retried: M.retried, timeouts: M.timeouts,
        rejectedByCode: { ...M.rejectedByCode }, permanentFailed: M.permanentFailed, dropped: M.dropped, dropReasons: { ...M.dropReasons }, expired: M.expired },
      process: { cpuPct: +cpuPct.toFixed(1), heapMB: Math.round(mem.heapUsed / 1048576), rssMB: Math.round(mem.rss / 1048576),
        eventLoopDelayP99Ms: this.loopDelay ? +(this.loopDelay.percentile(99) / 1e6).toFixed(2) : null },
    };
  }

  // Every metricsIntervalMs: one summary line on stdout (docker logs), then a new window for the rates
  _metricsWindow() {
    const m = this.metrics(), r = m.rates, d = m.dlr, p = r.submitResp;
    if (this.o.metricsLog) {
      const rej = Object.entries(d.rejectedByCode).map(([k, n]) => `${k}:${n}`).join(',') || '0';
      process.stdout.write(`[metrics] submit ${r.submitTps}/s resp p50 ${p.p50 ?? '-'} p95 ${p.p95 ?? '-'} p99 ${p.p99 ?? '-'} ms | dlr sent ${r.dlrSentTps}/s ok ${r.dlrConfirmedTps}/s rejected ${r.dlrRejectedTps}/s | pending ${d.pending} (due later ${d.notYetDue}, ready ${d.ready}, retry ${d.retryWaiting}, in flight ${d.inflight}) | rejected by code ${rej} | dropped ${d.dropped} permanent ${d.permanentFailed} expired ${d.expired} | cpu ${m.process.cpuPct}% heap ${m.process.heapMB} MB loop p99 ${m.process.eventLoopDelayP99Ms} ms\n`);
    }
    this.win = this._newWin(); this.cpu = { at: performance.now(), usage: process.cpuUsage() };
  }

  // GET /metrics → JSON · POST /metrics/reset → the counters before the reset, then zeroed (gauges stay)
  _startMetricsHttp() {
    if (!this.o.metricsPort) return;
    this.metricsServer = http.createServer((req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 1)); };
      const url = (req.url || '').split('?')[0];
      if (url === '/metrics' && req.method === 'GET') return send(200, this.metrics());
      if (url === '/metrics/reset' && req.method === 'POST') { const before = this.metrics(); this.resetMetrics(); return send(200, { ok: true, before }); }
      send(404, { endpoints: ['GET /metrics', 'POST /metrics/reset'] });
    });
    this.metricsServer.on('error', e => this.emit('log', { text: `Metrics endpoint not started on ${this.o.metricsHost}:${this.o.metricsPort}: ${e.message}` }));
    this.metricsServer.listen(this.o.metricsPort, this.o.metricsHost, () => this.emit('log', { text: `Metrics on http://${this.o.metricsHost}:${this.o.metricsPort}/metrics` }));
  }

  sendMo(text, from, to) {
    let n = 0;
    for (const c of this.conns) {
      if (!c.bound || !c.rx || c.sock.destroyed) continue;
      const isGsm = /^[\x20-\x7e\r\n]*$/.test(text || '');
      let msg;
      if (isGsm) msg = Buffer.from(text || 'Test MO', 'latin1');
      else { const le = Buffer.from(text, 'utf16le'); msg = Buffer.alloc(le.length); for (let i = 0; i < le.length; i += 2) { msg[i] = le[i + 1]; msg[i + 1] = le[i]; } }
      const bodyB = Buffer.concat([
        Buffer.from([0, 1, 1]), Buffer.from((from || '905551112233') + '\0', 'latin1'),
        Buffer.from([5, 0]), Buffer.from((to || 'TEST') + '\0', 'latin1'),
        Buffer.from([0, 0, 0, 0, 0, 0, 0, isGsm ? 0 : 8, 0, Math.min(msg.length, 254)]), msg.subarray(0, 254),
      ]);
      const hb = header(CMD.deliver_sm, 0, this.seq++, bodyB.length); bodyB.copy(hb, 16);
      this._writeLo(c, hb); n++;
    }
    return n;
  }

  stop() {
    this._evClose();
    clearInterval(this.timer); clearInterval(this.statTimer); clearInterval(this.capTimer); clearInterval(this.metricsTimer);
    this.respQ = []; this.respHead = 0;
    // Pending DLRs are in the journal; whatever was in flight stays there too and is sent again after a restart
    this.stopping = true;
    if (this.journal) { this.journal.close(); this.journal = null; }
    if (this.metricsServer) { this.metricsServer.close(); this.metricsServer = null; }
    for (const c of this.conns) c.sock.destroy();
    this.conns.clear();
    this.listening = false;
    if (this.server) { this.server.close(); this.server = null; this.emit('log', msg('Vendor stopped')); }
  }
}

module.exports = { MockSmsc };

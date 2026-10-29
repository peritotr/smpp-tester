// Mock SMSC (vendor) written on raw sockets so it can sustain high TPS.
// Runs in its own process (mock-worker.js) so it does not skew client-side measurements.
const net = require('net');
const EventEmitter = require('events');
const { Hist } = require('./hist');
const { decodeSm } = require('./sms-decode');
const crypto = require('crypto');
const KEEP = 1000; // incoming messages kept for the "Vendor messages" list
const TAG = /#T(\d{13})(\d{7})/;
const fill = (s, p) => p ? s.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : s;
const msg = (key, p) => ({ key, p, text: fill(key, p) });

const CMD = {
  bind_receiver: 0x01, bind_transmitter: 0x02, submit_sm: 0x04, deliver_sm: 0x05,
  unbind: 0x06, bind_transceiver: 0x09, enquire_link: 0x15, generic_nack: 0x80000000,
};
const RESP = 0x80000000;
const ST = { OK: 0, RBINDFAIL: 0x0d, RTHROTTLED: 0x58, RSUBMITFAIL: 0x45, RINVCMDID: 0x03 };

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

// message_id: <start-time prefix>-<counter>, unique across restarts and across vendor processes.
// The prefix is the start time in ms (hex) plus 16 random bits, and it is renewed on every start, so a restart can
// never hand out an id the gateway has already seen. The counter never wraps (up to 2^53). About 20 characters,
// well inside SMPP 3.4's 65-byte message_id. The dash keeps gateways from treating the id as a hex or decimal number.
let lastPrefixMs = 0;
function idPrefix() {
  const ms = Math.max(Date.now(), lastPrefixMs + 1); lastPrefixMs = ms;
  return ms.toString(16).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}

class MockSmsc extends EventEmitter {
  constructor() {
    super();
    this.server = null; this.conns = new Set(); this.idc = 0; this.idPrefix = idPrefix();
    this.stats = { rx: 0, throttled: 0, dlrSent: 0, binds: 0 };
    this.dlrQueue = []; this.seq = 1;
    this.resetE2e(); this.clearMsgs();
  }

  nextId() {
    const n = this.idc++;
    if (this.o && this.o.idReuse) return (0x100000 + n % this.o.idReuse).toString(16).toUpperCase(); // deliberate repeats
    return this.idPrefix + '-' + n.toString(16).toUpperCase();
  }

  // Last KEEP submit_sm kept raw (cheap at high TPS); decoded only when the list is asked for
  clearMsgs() { this.msgs = new Array(KEEP); this.msgHead = 0; this.msgTotal = 0; this.encCount = {}; }

  resetE2e() { this.e2e = { n: 0, dup: 0, hist: new Hist(), sec: new Hist(), seen: new Set() }; }

  start(opts = {}) {
    if (this.server) return;
    this.o = {
      port: Number(opts.port) || 2775, host: opts.bindHost || '127.0.0.1',
      dlrDelay: Math.max(0, Number(opts.dlrDelay ?? 1500)),
      failRate: Math.max(0, Math.min(1, Number(opts.failRate || 0))),
      maxTps: Math.max(0, Number(opts.maxTps || 0)),          // 0 = unlimited
      respDelay: Math.max(0, Number(opts.respDelay || 0)),
      capacity: Math.max(0, Number(opts.capacity || 0)),       // 0 = unlimited; above it responses wait in a queue
      maxBinds: Math.max(0, Number(opts.maxBinds || 0)),       // 0 = unlimited; extra binds get no answer
      systemId: opts.systemId || '', password: opts.password || '',
      // Test scenario only: hand out the same short ids again every N submits (0 = off, the default)
      idReuse: Math.max(0, Math.floor(Number(opts.idReuse || 0))),
    };
    this.idPrefix = idPrefix(); this.idc = 0; // fresh, never-seen ids after every (re)start
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
    this.secStart = Date.now(); this.secCount = 0;
    this.timer = setInterval(() => this._tick(), 20);
    this.respQ = []; this.respHead = 0; this.nextFree = 0;
    if (this.o.capacity) this.capTimer = setInterval(() => this._flushResp(), 2);
    this.statTimer = setInterval(() => {
      const e = this.e2e;
      this.emit('stats', { ...this.stats, msgTotal: this.msgTotal, conns: [...this.conns].filter(c => c.bound).length, dlrPending: this.dlrQueue.length - (this.dlrHead || 0), respQueue: (this.respQ || []).length - (this.respHead || 0),
        e2e: { n: e.n, dup: e.dup, sec: e.sec.summary(), total: e.hist.summary() } });
      e.sec = new Hist();
      this.stats.rx = 0; this.stats.throttled = 0; this.stats.dlrSent = 0;
    }, 1000);
  }

  _onConn(sock) {
    sock.setNoDelay(true);
    const c = { sock, bound: false, rx: false, buf: Buffer.alloc(0), out: [] };
    this.conns.add(c);
    sock.on('data', d => { c.buf = c.buf.length ? Buffer.concat([c.buf, d]) : d; this._parse(c); });
    sock.on('error', () => {});
    sock.on('close', () => this.conns.delete(c));
  }

  _write(c, b) {
    c.out.push(b);
    if (!c.flushPending) { c.flushPending = true; setImmediate(() => { c.flushPending = false; if (c.out.length && !c.sock.destroyed) { c.sock.write(c.out.length === 1 ? c.out[0] : Buffer.concat(c.out)); } c.out = []; }); }
  }

  _parse(c) {
    let off = 0; const buf = c.buf;
    while (buf.length - off >= 16) {
      const len = buf.readUInt32BE(off);
      if (len < 16 || len > 70000) { c.sock.destroy(); return; }
      if (buf.length - off < len) break;
      this._handle(c, buf.readUInt32BE(off + 4), buf.readUInt32BE(off + 12), buf.subarray(off + 16, off + len));
      off += len;
    }
    c.buf = off === buf.length ? Buffer.alloc(0) : buf.subarray(off);
  }

  _handle(c, cmd, seq, body) {
    switch (cmd) {
      case CMD.bind_transceiver: case CMD.bind_receiver: case CMD.bind_transmitter: {
        const [sid, p1] = cstr(body, 0); const [pw] = cstr(body, p1);
        // For testing: ignore binds beyond the limit (some SMSCs behave like this)
        if (this.o.maxBinds && [...this.conns].filter(x => x.bound).length >= this.o.maxBinds) return;
        const ok = !this.o.systemId || (sid === this.o.systemId && pw === this.o.password);
        this._write(c, respWithCstr(cmd, ok ? ST.OK : ST.RBINDFAIL, seq, 'MOCKSMSC'));
        if (ok) { c.bound = true; c.rx = cmd !== CMD.bind_transmitter; c.sid = sid; this.stats.binds++; }
        else setTimeout(() => c.sock.end(), 50);
        return;
      }
      case CMD.enquire_link: return this._write(c, emptyResp(cmd, 0, seq));
      case CMD.unbind: this._write(c, emptyResp(cmd, 0, seq)); setTimeout(() => c.sock.end(), 20); return;
      case CMD.submit_sm: return this._submit(c, seq, body);
      case CMD.deliver_sm | RESP: case CMD.enquire_link | RESP: case CMD.generic_nack: return;
      default:
        if (cmd & RESP) return;
        return this._write(c, header(CMD.generic_nack, ST.RINVCMDID, seq, 0));
    }
  }

  _submit(c, seq, body) {
    if (!c.bound) return this._write(c, respWithCstr(CMD.submit_sm, 0x04, seq, ''));
    this.stats.rx++;
    const now = Date.now();
    if (this.o.maxTps) {
      if (now - this.secStart >= 1000) { this.secStart = now; this.secCount = 0; }
      if (++this.secCount > this.o.maxTps) { this.stats.throttled++; return this._write(c, respWithCstr(CMD.submit_sm, ST.RTHROTTLED, seq, '')); }
    }
    const id = this.nextId();
    const resp = respWithCstr(CMD.submit_sm, ST.OK, seq, id);
    if (this.o.capacity) {
      // Fixed processing rate: above capacity the queue and latency grow, like a real system
      this.nextFree = Math.max(now, this.nextFree) + 1000 / this.o.capacity;
      this.respQ.push({ due: this.nextFree + this.o.respDelay, c, resp });
    } else if (this.o.respDelay) setTimeout(() => this._write(c, resp), this.o.respDelay); else this._write(c, resp);

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
    this._e2e(dcs, sm, now);
    // Keep a copy for the "Vendor messages" list: what arrived, from which account, in which encoding
    this.msgs[this.msgHead] = { t: now, sid: c.sid || '', src, srcTon, dst, dstTon, esm, dcs, reg, id, sm: Buffer.from(sm) };
    this.msgHead = (this.msgHead + 1) % KEEP; this.msgTotal++;
    this.encCount[dcs] = (this.encCount[dcs] || 0) + 1;
    if (reg && c.rx) this.dlrQueue.push({ due: now + this.o.dlrDelay, c, id, src, srcTon, srcNpi, dst, dstTon, dstNpi });
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
    const e = this.e2e, key = mt[1] + mt[2];
    if (e.seen.has(key)) { e.dup++; return; }
    e.seen.add(key); if (e.seen.size > 3000000) e.seen.clear();
    e.n++; const lat = Math.max(0, now - Number(mt[1])); e.hist.add(lat); e.sec.add(lat);
  }

  _flushResp() {
    const now = Date.now(), q = this.respQ; let h = this.respHead;
    while (h < q.length && q[h].due <= now) { const r = q[h++]; if (!r.c.sock.destroyed) this._write(r.c, r.resp); }
    if (h > 50000 || h === q.length) { this.respQ = q.slice(h); h = 0; }
    this.respHead = h;
  }

  _dlrPdu(d) {
    const fail = Math.random() < this.o.failRate;
    const stat = fail ? 'UNDELIV' : 'DELIVRD';
    const ds = new Date().toISOString().replace(/[-T:]/g, '').slice(2, 12);
    const txt = Buffer.from(`id:${d.id} sub:001 dlvrd:${fail ? '000' : '001'} submit date:${ds} done date:${ds} stat:${stat} err:${fail ? '001' : '000'} text:`, 'latin1');
    const parts = [
      Buffer.from([0]),                                                  // service_type
      Buffer.from([d.dstTon, d.dstNpi]), Buffer.from(d.dst + '\0', 'latin1'),
      Buffer.from([d.srcTon, d.srcNpi]), Buffer.from(d.src + '\0', 'latin1'),
      Buffer.from([0x04, 0, 0, 0, 0, 0, 0, 0, 0, txt.length]),           // esm..sm_length
      txt,
    ];
    const rid = Buffer.from(d.id + '\0', 'latin1');
    const t1 = Buffer.alloc(4); t1.writeUInt16BE(0x001e, 0); t1.writeUInt16BE(rid.length, 2);
    const t2 = Buffer.from([0x04, 0x27, 0x00, 0x01, fail ? 5 : 2]);
    const bodyB = Buffer.concat([...parts, t1, rid, t2]);
    const h = header(CMD.deliver_sm, 0, this.seq++, bodyB.length); bodyB.copy(h, 16);
    if (this.seq > 0x7ffffff0) this.seq = 1;
    return h;
  }

  _tick() {
    const now = Date.now();
    let h = this.dlrHead || 0; const q = this.dlrQueue;
    while (h < q.length && q[h].due <= now) {
      const d = q[h++];
      if (!d.c.sock.destroyed) { this._write(d.c, this._dlrPdu(d)); this.stats.dlrSent++; }
    }
    if (h > 50000 || h === q.length) { this.dlrQueue = q.slice(h); h = 0; }
    this.dlrHead = h;
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
      this._write(c, hb); n++;
    }
    return n;
  }

  stop() {
    clearInterval(this.timer); clearInterval(this.statTimer); clearInterval(this.capTimer); this.respQ = []; this.respHead = 0;
    for (const c of this.conns) c.sock.destroy();
    this.conns.clear(); this.dlrQueue = []; this.dlrHead = 0;
    this.listening = false;
    if (this.server) { this.server.close(); this.server = null; this.emit('log', msg('Vendor stopped')); }
  }
}

module.exports = { MockSmsc };

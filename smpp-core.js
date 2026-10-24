// Interactive SMPP client core. Independent of Electron, so it can be tested headless.
const EventEmitter = require('events');
const smpp = require('smpp');
const defs = require('smpp/lib/defs');

const CMD_STATUS = {};
for (const [k, v] of Object.entries(defs.errors)) CMD_STATUS[v] = k;
const statusName = (s) => CMD_STATUS[s] || ('0x' + Number(s).toString(16).padStart(8, '0'));

// ---------- Encoding and splitting ----------
const GSM = defs.gsmCoder.GSM;
function isGsm(text) { return GSM.charRegex.test(text); }
function gsmEncode(text) { return defs.gsmCoder.encode(text); }       // 1 byte per septet, including ESC
function latin1Ok(text) { return /^[\x00-\xff]*$/.test(text); }

function chooseEncoding(text, pref) {
  if (pref && pref !== 'auto') return pref;
  if (isGsm(text)) return 'gsm7';
  return 'ucs2';
}
const DCS = { gsm7: 0x00, latin1: 0x03, ucs2: 0x08 };

function encodeText(text, enc) {
  if (enc === 'gsm7') return gsmEncode(text);
  if (enc === 'latin1') return Buffer.from(text, 'latin1');
  // UCS2 big-endian
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
  return be;
}

// Splits text on character boundaries (never inside a GSM escape pair or a UTF-16 surrogate pair).
function splitText(text, enc, maxBytes) {
  const chars = Array.from(text); // surrogate-safe
  const parts = [];
  let cur = '', curLen = 0;
  for (const ch of chars) {
    const l = encodeText(ch, enc).length;
    if (curLen + l > maxBytes) { parts.push(cur); cur = ''; curLen = 0; }
    cur += ch; curLen += l;
  }
  if (cur || parts.length === 0) parts.push(cur);
  return parts;
}

function analyze(text, encPref) {
  const enc = chooseEncoding(text, encPref);
  if (enc === 'gsm7' && !isGsm(text)) return { enc, error: 'Text does not fit the GSM 03.38 alphabet' };
  if (enc === 'latin1' && !latin1Ok(text)) return { enc, error: 'Text is not Latin-1' };
  const bytes = encodeText(text, enc).length;
  const single = enc === 'ucs2' ? 140 : (enc === 'gsm7' ? 160 : 140);
  const multi = enc === 'ucs2' ? 134 : (enc === 'gsm7' ? 153 : 134);
  const parts = bytes <= single ? 1 : splitText(text, enc, multi).length;
  const unit = enc === 'ucs2' ? Math.floor(bytes / 2) : bytes;
  return { enc, bytes, units: unit, parts, dcs: DCS[enc] };
}

function parseDlrText(s) {
  const out = {};
  const re = /(id|sub|dlvrd|submit date|done date|stat|err|text):\s?(.*?)(?=\s(?:sub|dlvrd|submit date|done date|stat|err|text):|$)/gi;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase().replace(' ', '_')] = m[2].trim();
  return out;
}

function pduSummary(pdu) {
  const skip = new Set(['command', 'command_length', 'command_id', 'command_status', 'sequence_number']);
  const o = {};
  for (const [k, v] of Object.entries(pdu)) {
    if (skip.has(k) || typeof v === 'function') continue;
    if (k === 'password') { o[k] = '***'; continue; }
    if (Buffer.isBuffer(v)) o[k] = '0x' + v.toString('hex');
    else if (v && typeof v === 'object' && v.message !== undefined) {
      o[k] = Buffer.isBuffer(v.message) ? '0x' + v.message.toString('hex') : v.message;
      if (v.udh) o[k + '_udh'] = v.udh.map(b => Buffer.from(b).toString('hex'));
    } else o[k] = v;
  }
  return o;
}

let refCounter = Math.floor(Math.random() * 255);

class SmppClient extends EventEmitter {
  constructor() {
    super();
    this.session = null;
    this.state = 'disconnected';
    this.messages = new Map(); // message_id -> record
  }

  // info: English text; infoKey/infoP let the UI translate it
  _state(s, info, infoKey, infoP) { this.state = s; this.emit('state', { state: s, info, infoKey, infoP }); }
  _log(dir, command, data, status) { this.emit('log', { ts: Date.now(), dir, command, status, data }); }

  connect(cfg) {
    if (this.session) this.disconnect();
    const host = String(cfg.host || '').trim();
    const port = Number(cfg.port) || 2775;
    if (!host) throw new Error('Host is empty');
    this._state('connecting', `${host}:${port}${cfg.tls ? ' (TLS)' : ''}`);
    const session = smpp.connect({
      host, port, tls: !!cfg.tls,
      rejectUnauthorized: !!cfg.verifyCert,
      connectTimeout: (Number(cfg.connectTimeout) || 10) * 1000,
      auto_enquire_link_period: (Number(cfg.enquireLink) || 30) * 1000,
    });
    this.session = session;

    session.on('send', pdu => this._log('out', pdu.command, pduSummary(pdu), pdu.isResponse() ? statusName(pdu.command_status) : undefined));
    session.on('pdu', pdu => {
      this._log('in', pdu.command, pduSummary(pdu), pdu.isResponse() ? statusName(pdu.command_status) : undefined);
      if (pdu.command === 'deliver_sm') this._onDeliver(pdu);
      else if (pdu.command === 'enquire_link') session.send(pdu.response());
      else if (pdu.command === 'unbind') { session.send(pdu.response()); session.close(); }
      else if (pdu.command === 'data_sm') session.send(pdu.response());
    });
    session.on('error', e => { this._log('sys', 'error', { message: e.message, code: e.code }); this._state('error', e.message); });
    session.on('close', () => { if (this.session === session) { this.session = null; this._state('disconnected'); } });

    session.on(cfg.tls ? 'secureConnect' : 'connect', () => {
      this._state('binding');
      const mode = cfg.bindMode || 'trx';
      const fn = { trx: 'bind_transceiver', tx: 'bind_transmitter', rx: 'bind_receiver' }[mode];
      const params = {
        system_id: cfg.systemId || '', password: cfg.password || '',
        system_type: cfg.systemType || '',
        interface_version: Number(cfg.interfaceVersion || 0x34),
        addr_ton: Number(cfg.addrTon || 0), addr_npi: Number(cfg.addrNpi || 0),
        address_range: cfg.addressRange || '',
      };
      session[fn](params, resp => {
        if (resp.command_status === 0) this._state('bound', mode.toUpperCase() + (resp.system_id ? ' · ' + resp.system_id : ''));
        else { const st = statusName(resp.command_status); this._state('error', `Bind rejected: ${st}`, 'Bind rejected: {status}', { status: st }); session.close(); }
      });
    });
  }

  disconnect() {
    const s = this.session;
    if (!s) return;
    if (this.state === 'bound') {
      let done = false;
      const t = setTimeout(() => { if (!done) s.destroy ? s.destroy() : s.close(); }, 2000);
      s.unbind(() => { done = true; clearTimeout(t); s.close(); });
    } else s.close();
  }

  _onDeliver(pdu) {
    this.session.send(pdu.response());
    const raw = pdu.short_message && pdu.short_message.message;
    let text = Buffer.isBuffer(raw) ? raw.toString('latin1') : (raw || '');
    if (!text && pdu.message_payload) {
      const mp = pdu.message_payload.message || pdu.message_payload;
      text = Buffer.isBuffer(mp) ? mp.toString('latin1') : String(mp);
    }
    const isDlr = (pdu.esm_class & 0x3c) === 0x04 || (pdu.esm_class & 0x3c) === 0x08 || /id:\S+.*stat:/i.test(text);
    if (isDlr) {
      const f = parseDlrText(text);
      const id = pdu.receipted_message_id || f.id;
      const stat = f.stat || (pdu.message_state != null ? String(pdu.message_state) : '?');
      const rec = this._findMsg(id);
      if (rec) {
        rec.dlrs = rec.dlrs || {};
        rec.dlrs[id] = stat;
        const vals = Object.values(rec.dlrs);
        const allSame = vals.every(v => v === vals[0]);
        rec.dlr = rec.parts > 1 ? `${vals.length}/${rec.parts} ${allSame ? vals[0] : vals.join(',')}` : stat;
        rec.err = f.err; rec.dlrAt = Date.now(); rec.dlrLatency = rec.dlrAt - rec.sentAt;
        this.emit('message', rec);
      }
      this.emit('dlr', { id, stat, err: f.err, text, matched: !!rec, from: pdu.source_addr, to: pdu.destination_addr });
    } else {
      this.emit('mo', { from: pdu.source_addr, to: pdu.destination_addr, text, dcs: pdu.data_coding, at: Date.now() });
    }
  }

  _findMsg(id) {
    if (!id) return null;
    if (this.messages.has(id)) return this.messages.get(id);
    // Some SMSCs convert the id between hex and decimal in the DLR
    const alts = [];
    if (/^[0-9a-f]+$/i.test(id)) alts.push(parseInt(id, 16).toString(), id.toLowerCase(), id.toUpperCase());
    if (/^\d+$/.test(id)) alts.push(BigInt(id).toString(16), BigInt(id).toString(16).toUpperCase());
    for (const a of alts) if (this.messages.has(a)) return this.messages.get(a);
    for (const [k, r] of this.messages) if (k.replace(/^0+/, '') === String(id).replace(/^0+/, '')) return r;
    return null;
  }

  // Sends one message (concatenated if needed); returns a Promise.
  submitOne(m, seqNo) {
    return new Promise((resolve) => {
      if (!this.session || this.state !== 'bound') return resolve({ ok: false, error: 'Not bound' });
      const a = analyze(m.text, m.encoding);
      if (a.error) return resolve({ ok: false, error: a.error });
      const base = {
        service_type: m.serviceType || '',
        source_addr_ton: Number(m.srcTon), source_addr_npi: Number(m.srcNpi), source_addr: m.src || '',
        dest_addr_ton: Number(m.dstTon), dest_addr_npi: Number(m.dstNpi), destination_addr: m.dst || '',
        registered_delivery: Number(m.dlr) ? 1 : 0,
        data_coding: a.dcs,
        esm_class: 0,
        priority_flag: Number(m.priority || 0),
      };
      if (m.validity) base.validity_period = m.validity;
      const enc = a.enc;
      const single = enc === 'gsm7' ? 160 : 140;
      const multi = enc === 'gsm7' ? 153 : 134;
      const full = encodeText(m.text, enc);
      let pdus = [];
      const mode = m.split || 'udh';
      if (full.length <= single || mode === 'none') {
        pdus.push({ ...base, short_message: full });
      } else if (mode === 'payload') {
        pdus.push({ ...base, short_message: Buffer.alloc(0), message_payload: full });
      } else {
        const parts = splitText(m.text, enc, multi);
        const ref = (refCounter = (refCounter + 1) & 0xff);
        parts.forEach((p, i) => {
          const udh = Buffer.from([0x05, 0x00, 0x03, ref, parts.length, i + 1]);
          pdus.push({ ...base, esm_class: 0x40, short_message: Buffer.concat([udh, encodeText(p, enc)]) });
        });
      }
      const rec = { uid: (this._uid = (this._uid || 0) + 1), seq: seqNo, src: m.src, dst: m.dst, text: m.text, enc, parts: pdus.length, ids: [], status: 'pending', sentAt: Date.now(), dlr: null };
      this.emit('message', rec);
      let left = pdus.length, failed = null;
      pdus.forEach(p => {
        const t0 = Date.now();
        this.session.submit_sm(p, resp => {
          rec.latency = Date.now() - t0;
          if (resp.command_status === 0) {
            rec.ids.push(resp.message_id);
            this.messages.set(resp.message_id, rec);
          } else failed = statusName(resp.command_status);
          if (--left === 0) {
            rec.status = failed ? 'failed' : 'accepted';
            rec.error = failed;
            this.emit('message', rec);
            resolve({ ok: !failed, rec });
          }
        }, null, () => {
          failed = 'Socket write error';
          if (--left === 0) { rec.status = 'failed'; rec.error = failed; this.emit('message', rec); resolve({ ok: false, rec }); }
        });
      });
    });
  }

  // Batch send: `count` messages at `tps` rate
  async submitBatch(m) {
    const count = Math.max(1, Math.min(100000, Number(m.count) || 1));
    const tps = Math.max(1, Number(m.tps) || 10);
    this._stop = false;
    const interval = 1000 / tps;
    const start = Date.now();
    const pending = [];
    let ok = 0, fail = 0;
    for (let i = 0; i < count && !this._stop; i++) {
      const target = start + i * interval;
      const wait = target - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      const text = count > 1 ? m.text.replace(/\{n\}/g, String(i + 1)) : m.text;
      pending.push(this.submitOne({ ...m, text }, i + 1).then(r => { r.ok ? ok++ : fail++; this.emit('progress', { done: ok + fail, total: count, ok, fail }); }));
    }
    await Promise.all(pending);
    const secs = (Date.now() - start) / 1000;
    return { ok, fail, secs, rate: (ok + fail) / Math.max(secs, 0.001) };
  }
  stopBatch() { this._stop = true; }

  sendEnquire() { if (this.session) this.session.enquire_link(); }
}

module.exports = { SmppClient, analyze, parseDlrText, statusName, __encodeText: encodeText };

// SMPP Tester — web server edition.
// Serves the same UI to a browser; the load engine and the mock vendor run in separate Node processes.
//
// Environment variables:
//   PORT          Web UI port (default 8080)
//   HOST          Address the web UI listens on (default 0.0.0.0)
//   UI_PASSWORD   UI login password (REQUIRED, at least 8 characters)
//   DATA_DIR      Folder for profiles, reports and the secret key (default ./data)
//   PUBLIC_IP     IP shown as the vendor address (optional; otherwise taken from the network interfaces)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { fork } = require('child_process');
const { WebSocketServer } = require('ws');
const { SmppClient, analyze } = require('./smpp-core');
const { ReportStore, assembleReport } = require('./reports');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.UI_PASSWORD || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UI_DIR = path.join(__dirname, 'ui');

if (!PASSWORD || PASSWORD.length < 8) {
  console.error('ERROR: the UI_PASSWORD environment variable must be at least 8 characters.');
  process.exit(1);
}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); }
catch (e) { console.error(`ERROR: cannot write to ${DATA_DIR} (${e.code}). Fix its ownership: sudo chown -R 1000:1000 <data folder>`); process.exit(1); }
const reports = new ReportStore(path.join(DATA_DIR, 'reports'));

// ---------- Secret key (session cookie signing + profile encryption) ----------
const keyFile = path.join(DATA_DIR, 'secret.key');
let SECRET;
try { SECRET = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'); } catch {}
if (!SECRET || SECRET.length !== 32) { SECRET = crypto.randomBytes(32); fs.writeFileSync(keyFile, SECRET.toString('hex'), { mode: 0o600 }); }

function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(b64) {
  const b = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', SECRET, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---------- Session cookie ----------
const COOKIE = 'smpptester';
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() { const exp = Date.now() + 30 * 864e5; const v = `${exp}`; return `${v}.${sign(v + PASSWORD)}`; }
function validToken(t) {
  if (!t) return false;
  const [v, s] = t.split('.');
  if (!v || !s || Number(v) < Date.now()) return false;
  const exp = sign(v + PASSWORD);
  return s.length === exp.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp));
}
function cookieOf(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
// Brute-force protection: 10 failed attempts per IP per 10 minutes
const fails = new Map();
function tooMany(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 10 * 60e3; }
function noteFail(ip) { const f = fails.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - f.t > 10 * 60e3) { f.n = 0; f.t = Date.now(); } f.n++; fails.set(ip, f); }

// Login page in English or Turkish depending on the browser's Accept-Language
const LOGIN_TXT = {
  en: { title: 'Log in', lead: 'Enter the password to continue.', ph: 'Password', btn: 'Log in', bad: 'Wrong password.', many: 'Too many failed attempts. Try again in 10 minutes.' },
  tr: { title: 'Giriş', lead: 'Devam etmek için şifreyi gir.', ph: 'Şifre', btn: 'Giriş', bad: 'Şifre hatalı.', many: 'Çok fazla hatalı deneme. 10 dakika sonra tekrar dene.' },
};
const langOf = req => /^tr\b/i.test(req.headers['accept-language'] || '') ? 'tr' : 'en';
const LOGIN_HTML = (lang, errKey) => { const L = LOGIN_TXT[lang]; const err = errKey ? L[errKey] : ''; return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMPP Tester — ${L.title}</title><style>
:root{--bg:#f4f5f8;--panel:#fff;--line:#e2e5ec;--text:#1b1e26;--muted:#6a7183;--accent:#3d8bfd;--err:#ef5a5a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#161920;--line:#262b36;--text:#e6e8ee;--muted:#8a91a3}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
form{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:28px;width:300px;max-width:calc(100vw - 32px);box-sizing:border-box}
h1{font-size:17px;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px;font-size:12.5px}
input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);font:inherit}
button{width:100%;margin-top:12px;padding:9px;border:0;border-radius:7px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.e{color:var(--err);font-size:12.5px;margin-top:10px}</style></head><body>
<form method="post" action="/login"><h1>SMPP Tester</h1><p>${L.lead}</p>
<input type="password" name="password" autofocus autocomplete="current-password" placeholder="${L.ph}">
<button type="submit">${L.btn}</button>${err ? `<div class="e">${err}</div>` : ''}</form></body></html>`; };

// ---------- Shared state ----------
const clients = new Set();
function broadcast(ch, data) {
  const msg = JSON.stringify({ ev: ch, data });
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}
const state = { smpp: { state: 'disconnected' }, mock: { on: false, opts: null }, load: { phase: 'idle', text: '' } };

// Interactive client
const client = new SmppClient();
let logBuf = [];
setInterval(() => { if (logBuf.length) { broadcast('smpp:log', logBuf); logBuf = []; } }, 100);
client.on('log', e => { logBuf.push(e); if (logBuf.length > 2000) logBuf.shift(); });
client.on('state', s => { state.smpp = s; broadcast('smpp:state', s); });
for (const ev of ['message', 'dlr', 'mo', 'progress']) client.on(ev, d => broadcast('smpp:' + ev, d));

// Load engine process
let loadProc = null, loadSeries = [], loadTotals = null, loadReq = null, lastReportId = null;
function getLoad() {
  if (loadProc) return loadProc;
  const p = loadProc = fork(path.join(__dirname, 'load-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  p.on('message', m => {
    if (m.type === 'phase') state.load = { ...state.load, phase: m.phase, text: m.text, key: m.key, p: m.p };
    else if (m.type === 'tick') {
      if (mockE2e && m.row && loadReq && loadReq.test && loadReq.test.e2e) { m.row.e2eN = mockE2e.n; m.row.e2eP50 = mockE2e.sec.p50; m.row.e2eP95 = mockE2e.sec.p95; m.row.e2eP99 = mockE2e.sec.p99; }
      loadSeries.push(m.row); if (loadSeries.length > 86400) loadSeries.shift(); loadTotals = m.totals; }
    else if (m.type === 'done') {
      loadTotals = m.totals;
      try {
        const useE2e = loadReq && loadReq.test && loadReq.test.e2e;
        const rep = assembleReport({ done: m, req: loadReq, series: loadSeries, vendorOpts: state.mock.on ? state.mock.opts : null, vendorE2e: useE2e ? mockE2e : null, app: 'smpp-tester-web' });
        const entry = reports.save(rep); lastReportId = entry.id;
        state.load = { ...state.load, reportId: entry.id };
        broadcast('report:saved', entry);
      } catch (e) { console.error('Could not save the report:', e.message); }
    }
    broadcast('load:' + m.type, m);
  });
  p.on('exit', () => { if (loadProc === p) loadProc = null; if (state.load.phase !== 'done' && state.load.phase !== 'idle') { state.load = { phase: 'error', text: 'The load engine process exited', key: 'The load engine process exited' }; broadcast('load:phase', state.load); } });
  return p;
}

// Vendor process
let mockProc = null, moWaiters = [], mockE2e = null, msgWaiters = new Map(), msgRid = 0;
function startMock(opts) {
  opts = { ...opts, stateDir: DATA_DIR }; // pending DLRs survive a restart (data/dlr-queue-<port>.log)
  return new Promise(resolve => {
    if (mockProc) mockProc.kill();
    const p = mockProc = fork(path.join(__dirname, 'mock-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    p.on('message', m => {
      if (m.type === 'log') broadcast('mock:log', m.msg || m.text);
      else if (m.type === 'stats') { mockE2e = m.stats.e2e && m.stats.e2e.n ? m.stats.e2e : null; broadcast('mock:stats', m.stats); }
      else if (m.type === 'started') { p.started = true; state.mock = { on: true, opts: { ...opts, password: undefined } }; saveVendor(opts); broadcast('app:sync', publicState()); resolve({ ok: true }); }
      else if (m.type === 'error') { broadcast('mock:log', 'Error: ' + m.text); if (!p.started) { p.kill(); if (mockProc === p) mockProc = null; } resolve({ ok: false, error: m.msg || m.text }); }
      else if (m.type === 'mo') { const w = moWaiters.shift(); w && w(m.n); }
      else if (m.type === 'msgs') { const w = msgWaiters.get(m.rid); if (w) { msgWaiters.delete(m.rid); w(m.data); } }
    });
    p.on('exit', () => { if (mockProc === p) { mockProc = null; if (state.mock.on) { state.mock = { on: false, opts: null }; broadcast('app:sync', publicState()); } } });
    p.send({ type: 'start', opts });
  });
}
// Vendor settings are persisted so the vendor comes back with them after a server/container restart
const vendorFile = path.join(DATA_DIR, 'vendor.json');
function saveVendor(opts) {
  try { fs.writeFileSync(vendorFile, JSON.stringify({ ...opts, password: opts.password ? encrypt(String(opts.password)) : '' }), { mode: 0o600 }); } catch {}
}
function clearVendor() { try { fs.unlinkSync(vendorFile); } catch {} }
function restoreVendor() {
  let o; try { o = JSON.parse(fs.readFileSync(vendorFile, 'utf8')); } catch { return; }
  try { o.password = o.password ? decrypt(o.password) : ''; } catch { o.password = ''; }
  startMock(o).then(r => console.log(r.ok ? `Vendor restored with its last settings (${o.bindHost}:${o.port})` : `Could not start the vendor: ${r.error && r.error.text || r.error}`));
}

function publicState(full) { return { smpp: state.smpp, mock: state.mock, load: full ? { ...state.load, series: loadSeries, totals: loadTotals } : state.load, server: true }; }

// ---------- Profiles ----------
const profilesFile = path.join(DATA_DIR, 'profiles.json');
function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(profilesFile, 'utf8')).map(p => {
      if (p.passwordEnc) { try { p.password = decrypt(p.passwordEnc); } catch { p.password = ''; } }
      delete p.passwordEnc; return p;
    });
  } catch { return []; }
}
function saveProfiles(list) {
  const out = (Array.isArray(list) ? list : []).slice(0, 500).map(p => {
    const q = { ...p };
    if (q.password) { q.passwordEnc = encrypt(String(q.password)); }
    delete q.password; return q;
  });
  fs.writeFileSync(profilesFile, JSON.stringify(out, null, 2), { mode: 0o600 });
  return true;
}

function ips() {
  const list = Object.entries(os.networkInterfaces()).flatMap(([name, l]) =>
    (l || []).filter(i => i.family === 'IPv4' && !i.internal).map(i => ({ name, address: i.address })));
  if (process.env.PUBLIC_IP) list.unshift({ name: 'public IP', address: process.env.PUBLIC_IP });
  return list;
}

// ---------- RPC ----------
const handlers = {
  'smpp:connect': cfg => { try { client.connect(cfg); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
  'smpp:disconnect': () => { client.disconnect(); return { ok: true }; },
  'smpp:enquire': () => { client.sendEnquire(); return { ok: true }; },
  'smpp:submit': m => client.submitBatch(m),
  'smpp:stop': () => { client.stopBatch(); return { ok: true }; },
  'smpp:analyze': (t, enc) => analyze(String(t ?? ''), enc),
  'load:start': (cfg, test) => {
    if (['binding', 'running', 'draining'].includes(state.load.phase)) return { ok: false, error: 'A test is already running' };
    state.load = { phase: 'binding', text: 'Starting…', key: 'Starting…', test: { tps: test && test.tps, e2e: !!(test && test.e2e) } }; broadcast('load:phase', state.load);
    loadSeries = []; loadTotals = null; loadReq = { cfg: { ...cfg, password: undefined }, test }; mockE2e = null;
    getLoad().send({ type: 'start', cfg, test }); return { ok: true };
  },
  'load:stop': () => { if (loadProc) loadProc.send({ type: 'stop' }); return { ok: true }; },
  'load:kill': () => { if (loadProc) loadProc.kill(); return { ok: true }; },
  'mock:start': o => startMock(o || {}),
  'mock:stop': () => {
    clearVendor();
    if (mockProc) { const p = mockProc; mockProc = null; p.kill(); state.mock = { on: false, opts: null }; broadcast('mock:log', { key: 'Vendor stopped', text: 'Vendor stopped' }); broadcast('app:sync', publicState()); }
    return { ok: true };
  },
  'mock:reset': () => { if (mockProc) mockProc.send({ type: 'reset' }); return true; },
  // Messages that reached the vendor, decoded (newest first)
  'mock:msgs': q => new Promise(resolve => {
    if (!mockProc) return resolve(null);
    const rid = ++msgRid; msgWaiters.set(rid, resolve); mockProc.send({ type: 'msgs', rid, q: typeof q === 'string' ? q.slice(0, 200) : '' });
    setTimeout(() => { if (msgWaiters.delete(rid)) resolve(null); }, 3000);
  }),
  'mock:msgsClear': () => { if (mockProc) mockProc.send({ type: 'msgsClear' }); return true; },
  'mock:mo': (text, from, to) => new Promise(resolve => {
    if (!mockProc) return resolve(0);
    moWaiters.push(resolve); mockProc.send({ type: 'mo', text, from, to });
    setTimeout(() => { const i = moWaiters.indexOf(resolve); if (i >= 0) { moWaiters.splice(i, 1); resolve(0); } }, 2000);
  }),
  'sys:ips': () => ips(),
  'profiles:load': () => loadProfiles(),
  'profiles:save': list => saveProfiles(list),
  'app:state': () => publicState(),
  'reports:list': () => reports.list(),
  'reports:get': id => reports.get(id),
  'reports:delete': id => reports.remove(id),
  'reports:rename': (id, name) => reports.rename(id, name),
};

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const isHttps = req => req.headers['x-forwarded-proto'] === 'https';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress;
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (url.pathname === '/login') {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': MIME['.html'], ...SEC_HEADERS }); return res.end(LOGIN_HTML(langOf(req))); }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        if (tooMany(ip)) { res.writeHead(429, { 'Content-Type': MIME['.html'], ...SEC_HEADERS }); return res.end(LOGIN_HTML(langOf(req), 'many')); }
        const pw = new URLSearchParams(body).get('password') || '';
        const a = crypto.createHash('sha256').update(pw).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest();
        if (!crypto.timingSafeEqual(a, b)) { noteFail(ip); res.writeHead(401, { 'Content-Type': MIME['.html'], ...SEC_HEADERS }); return res.end(LOGIN_HTML(langOf(req), 'bad')); }
        fails.delete(ip);
        res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${isHttps(req) ? '; Secure' : ''}`, ...SEC_HEADERS });
        res.end();
      });
      return;
    }
  }
  if (url.pathname === '/logout') {
    res.writeHead(303, { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0`, ...SEC_HEADERS }); return res.end();
  }

  if (!validToken(cookieOf(req))) {
    if (url.pathname === '/' || url.pathname.endsWith('.html')) { res.writeHead(303, { Location: '/login' }); return res.end(); }
    res.writeHead(401, SEC_HEADERS); return res.end();
  }

  let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...SEC_HEADERS });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });
server.on('upgrade', (req, sock, head) => {
  const origin = req.headers.origin, hostHdr = req.headers.host;
  if (!validToken(cookieOf(req)) || (origin && hostHdr && new URL(origin).host !== hostHdr)) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ ev: 'app:sync', data: publicState(true) }));
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const h = handlers[m.ch];
    let result, error;
    try { result = h ? await h(...(m.args || [])) : undefined; if (!h) error = 'Unknown command'; } catch (e) { error = e.message; }
    if (ws.readyState === 1) ws.send(JSON.stringify({ id: m.id, result, error }));
  });
  ws.on('close', () => clients.delete(ws));
});
setInterval(() => { for (const ws of clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);

server.listen(PORT, HOST, () => { console.log(`SMPP Tester web UI on http://${HOST}:${PORT}`); restoreVendor(); });

function shutdown() {
  console.log('Shutting down…');
  try { client.disconnect(); } catch {}
  if (mockProc) mockProc.kill();
  if (loadProc) loadProc.kill();
  server.close(); setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

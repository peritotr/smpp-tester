// SMPP Tester — desktop (Electron) edition: main process.
const { app, BrowserWindow, ipcMain, dialog, safeStorage, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SmppClient, analyze } = require('./smpp-core');
const { ReportStore, assembleReport } = require('./reports');
let reports = null;
const getReports = () => reports || (reports = new ReportStore(path.join(app.getPath('userData'), 'reports')));

let win;
const client = new SmppClient();
const profilesFile = () => path.join(app.getPath('userData'), 'profiles.json');

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

// Forward interactive client events to the UI (logs can be very chatty, so batch them every 50 ms)
let logBuf = [];
setInterval(() => { if (logBuf.length) { send('smpp:log', logBuf); logBuf = []; } }, 50);
client.on('log', e => { logBuf.push(e); if (logBuf.length > 2000) logBuf.shift(); });
for (const ev of ['state', 'message', 'dlr', 'mo', 'progress']) client.on(ev, d => send('smpp:' + ev, d));

// ---------- Separate processes: load engine and mock vendor (each gets its own CPU core) ----------
function spawn(file, onMsg) {
  const p = utilityProcess.fork(path.join(__dirname, file), [], { serviceName: file.replace('.js', ''), stdio: 'ignore' });
  p.on('message', onMsg);
  return p;
}

let loadProc = null, loadSeries = [], loadReq = null, mockE2e = null, mockOpts = null;
function getLoad() {
  if (loadProc) return loadProc;
  loadProc = spawn('load-worker.js', m => {
    const e2e = loadReq && loadReq.test && loadReq.test.e2e;
    if (m.type === 'tick' && m.row) {
      if (e2e && mockE2e) { m.row.e2eN = mockE2e.n; m.row.e2eP50 = mockE2e.sec.p50; m.row.e2eP95 = mockE2e.sec.p95; m.row.e2eP99 = mockE2e.sec.p99; }
      loadSeries.push(m.row); if (loadSeries.length > 86400) loadSeries.shift();
    }
    send('load:' + m.type, m);
    if (m.type === 'done') {
      try {
        const entry = getReports().save(assembleReport({ done: m, req: loadReq, series: loadSeries, vendorOpts: mockProc ? mockOpts : null, vendorE2e: e2e ? mockE2e : null, app: 'smpp-tester-desktop' }));
        send('report:saved', entry);
      } catch (e) { send('load:log', { text: 'Could not save the report: ' + e.message }); }
    }
  });
  loadProc.on('exit', () => { loadProc = null; send('load:phase', { phase: 'error', text: 'The load engine process exited', key: 'The load engine process exited' }); });
  return loadProc;
}

let mockProc = null, moWaiters = [], msgWaiters = new Map(), msgRid = 0;
function startMock(opts) {
  return new Promise(resolve => {
    if (mockProc) mockProc.kill();
    const p = mockProc = spawn('mock-worker.js', m => {
      if (m.type === 'log') send('mock:log', m.msg || m.text);
      else if (m.type === 'stats') { mockE2e = m.stats.e2e && m.stats.e2e.n ? m.stats.e2e : null; send('mock:stats', m.stats); }
      else if (m.type === 'started') { p.started = true; mockOpts = { ...opts, password: undefined }; resolve({ ok: true }); }
      else if (m.type === 'error') { send('mock:log', 'Error: ' + m.text); if (!p.started) { p.kill(); if (mockProc === p) mockProc = null; } resolve({ ok: false, error: m.msg || m.text }); }
      else if (m.type === 'mo') { const w = moWaiters.shift(); w && w(m.n); }
      else if (m.type === 'msgs') { const w = msgWaiters.get(m.rid); if (w) { msgWaiters.delete(m.rid); w(m.data); } }
    });
    p.on('exit', () => { if (mockProc === p) mockProc = null; });
    p.on('spawn', () => p.postMessage({ type: 'start', opts }));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 1040, minHeight: 660,
    title: 'SMPP Tester',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

ipcMain.handle('smpp:connect', (_, cfg) => { try { client.connect(cfg); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('smpp:disconnect', () => { client.disconnect(); return { ok: true }; });
ipcMain.handle('smpp:enquire', () => { client.sendEnquire(); return { ok: true }; });
ipcMain.handle('smpp:submit', (_, m) => client.submitBatch(m));
ipcMain.handle('smpp:stop', () => { client.stopBatch(); return { ok: true }; });
ipcMain.handle('smpp:analyze', (_, t, enc) => analyze(t, enc));

ipcMain.handle('load:start', (_, cfg, test) => {
  loadSeries = []; mockE2e = null; loadReq = { cfg: { ...cfg, password: undefined }, test };
  getLoad().postMessage({ type: 'start', cfg, test }); return { ok: true };
});
ipcMain.handle('reports:list', () => getReports().list());
ipcMain.handle('reports:get', (_, id) => getReports().get(id));
ipcMain.handle('reports:delete', (_, id) => getReports().remove(id));
ipcMain.handle('reports:rename', (_, id, name) => getReports().rename(id, name));
ipcMain.handle('report:open', (_, id) => {
  const w = new BrowserWindow({ width: 1180, height: 900, title: 'Test report', backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  w.loadFile(path.join(__dirname, 'ui', 'report.html'), { query: { id: String(id) } });
  return true;
});
ipcMain.handle('report:pdf', async (e, name) => {
  const wc = e.sender, win2 = BrowserWindow.fromWebContents(wc);
  const r = await dialog.showSaveDialog(win2, { defaultPath: name || 'smpp-test-report.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return false;
  const pdf = await wc.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
  fs.writeFileSync(r.filePath, pdf); return r.filePath;
});
ipcMain.handle('load:stop', () => { if (loadProc) loadProc.postMessage({ type: 'stop' }); return { ok: true }; });
ipcMain.handle('load:kill', () => { if (loadProc) loadProc.kill(); return { ok: true }; });

ipcMain.handle('mock:start', (_, o) => startMock(o));
ipcMain.handle('mock:stop', () => { if (mockProc) { mockProc.kill(); mockProc = null; send('mock:log', { key: 'Vendor stopped', text: 'Vendor stopped' }); } return { ok: true }; });
ipcMain.handle('mock:reset', () => { if (mockProc) mockProc.postMessage({ type: 'reset' }); return true; });
// Messages that reached the vendor, decoded (newest first)
ipcMain.handle('mock:msgs', (_, q) => new Promise(resolve => {
  if (!mockProc) return resolve(null);
  const rid = ++msgRid; msgWaiters.set(rid, resolve); mockProc.postMessage({ type: 'msgs', rid, q });
  setTimeout(() => { if (msgWaiters.delete(rid)) resolve(null); }, 3000);
}));
ipcMain.handle('mock:msgsClear', () => { if (mockProc) mockProc.postMessage({ type: 'msgsClear' }); return true; });
ipcMain.handle('sys:ips', () => Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
  (list || []).filter(i => i.family === 'IPv4' && !i.internal).map(i => ({ name, address: i.address }))));
ipcMain.handle('mock:mo', (_, text, from, to) => new Promise(resolve => {
  if (!mockProc) return resolve(0);
  moWaiters.push(resolve); mockProc.postMessage({ type: 'mo', text, from, to });
  setTimeout(() => { const i = moWaiters.indexOf(resolve); if (i >= 0) { moWaiters.splice(i, 1); resolve(0); } }, 2000);
}));

// Profiles live in userData/profiles.json; passwords are encrypted with the OS keychain (safeStorage).
const canEnc = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
ipcMain.handle('profiles:load', () => {
  try {
    return JSON.parse(fs.readFileSync(profilesFile(), 'utf8')).map(p => {
      if (p.passwordEnc && canEnc()) { try { p.password = safeStorage.decryptString(Buffer.from(p.passwordEnc, 'base64')); } catch { p.password = ''; } }
      delete p.passwordEnc; return p;
    });
  } catch { return []; }
});
ipcMain.handle('profiles:save', (_, list) => {
  const out = list.map(p => {
    const q = { ...p };
    if (q.password && canEnc()) { q.passwordEnc = safeStorage.encryptString(q.password).toString('base64'); delete q.password; }
    return q;
  });
  fs.writeFileSync(profilesFile(), JSON.stringify(out, null, 2)); return true;
});

ipcMain.handle('file:save', async (_, text, name) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, text); return r.filePath;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  client.disconnect();
  if (mockProc) mockProc.kill();
  if (loadProc) loadProc.kill();
  app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

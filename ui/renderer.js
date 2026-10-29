// Single-test view, connection form, built-in vendor controls.
// window.api is provided by preload.js (desktop) or web-api.js (browser).
const $ = id => document.getElementById(id);
const t = (s, p) => I18N.t(s, p);
const tm = o => I18N.msg(o);
const CONN_FIELDS = ['host','port','bindMode','tls','verifyCert','systemId','password','systemType','interfaceVersion','enquireLink','addrTon','addrNpi','addressRange','connectTimeout'];
const MSG_FIELDS = ['src','srcTon','srcNpi','dst','dstTon','dstNpi','encoding','split','dlr','count','tps'];
const val = id => { const e = $(id); return e.type === 'checkbox' ? e.checked : e.value; };
const setVal = (id, v) => { const e = $(id); if (v === undefined) return; if (e.type === 'checkbox') e.checked = !!v; else e.value = v; };
const time = ts => new Date(ts).toLocaleTimeString(I18N.locale, { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let state = 'disconnected', stateInfo = null, profiles = [], sending = false;

// ---------- Language ----------
setVal('lang', I18N.lang);
$('lang').onchange = () => I18N.setLang(val('lang'));
I18N.apply();

// ---------- Persisted form (last used values) ----------
function saveForm() {
  const o = {}; [...CONN_FIELDS, ...MSG_FIELDS, 'text'].forEach(f => o[f] = f === 'password' ? undefined : val(f));
  try { localStorage.setItem('form', JSON.stringify(o)); } catch {}
}
function loadForm() {
  try { const o = JSON.parse(localStorage.getItem('form') || '{}'); for (const k in o) setVal(k, o[k]); } catch {}
}
document.addEventListener('change', saveForm);

// ---------- Profiles ----------
async function refreshProfiles(sel) {
  profiles = await api.loadProfiles();
  $('profile').innerHTML = `<option value="">${esc(t('— Profile —'))}</option>` + profiles.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  if (sel != null) $('profile').value = sel;
}
$('profile').onchange = () => {
  const p = profiles[$('profile').value]; if (!p) return;
  CONN_FIELDS.forEach(f => setVal(f, p[f])); updateTls(); saveForm();
};
$('saveProfile').onclick = () => {
  const cur = profiles[$('profile').value];
  $('nameRow').style.display = '';
  setVal('profileName', cur ? cur.name : `${val('systemId') || 'profile'}@${val('host')}`);
  $('profileName').select();
};
$('nameCancel').onclick = () => { $('nameRow').style.display = 'none'; };
$('profileName').onkeydown = e => { if (e.key === 'Enter') $('nameOk').click(); if (e.key === 'Escape') $('nameCancel').click(); };
$('nameOk').onclick = async () => {
  const name = val('profileName').trim();
  if (!name) return;
  $('nameRow').style.display = 'none';
  const p = { name }; CONN_FIELDS.forEach(f => p[f] = val(f));
  const idx = profiles.findIndex(x => x.name === name);
  if (idx >= 0) profiles[idx] = p; else profiles.push(p);
  await api.saveProfiles(profiles);
  await refreshProfiles(profiles.findIndex(x => x.name === name));
};
$('delProfile').onclick = async () => {
  const i = $('profile').value; if (i === '') return;
  if (!confirm(t('Delete "{name}"?', { name: profiles[i].name }))) return;
  profiles.splice(i, 1); await api.saveProfiles(profiles); await refreshProfiles();
};
function updateTls() { $('verifyWrap').style.display = val('tls') ? '' : 'none'; if (val('tls') && val('port') === '2775') setVal('port', 3550); }
$('tls').onchange = updateTls;

// ---------- Connection ----------
$('connect').onclick = async () => {
  const cfg = {}; CONN_FIELDS.forEach(f => cfg[f] = val(f));
  const r = await api.connect(cfg);
  if (!r.ok) alert(tm(r.error));
};
$('disconnect').onclick = () => api.disconnect();
$('enquire').onclick = () => api.enquire();

const STATE_TXT = { disconnected: 'disconnected', connecting: 'connecting…', binding: 'binding…', bound: 'bound', error: 'error' };
function renderState() {
  const info = stateInfo ? tm(stateInfo) : '';
  $('stateDot').className = 'dot ' + state;
  $('stateText').textContent = t(STATE_TXT[state]) + (info ? ' · ' + info : '');
  $('stateText').title = info;
}
api.on('smpp:state', s => {
  state = s.state; stateInfo = s.info ? (s.infoKey ? { key: s.infoKey, p: s.infoP, text: s.info } : s.info) : null;
  renderState(); updateButtons();
  addSys(`${t('State')}: ${t(STATE_TXT[s.state])}${stateInfo ? ' — ' + tm(stateInfo) : ''}`);
});
function updateButtons() {
  const busy = ['connecting', 'binding', 'bound'].includes(state);
  $('connect').disabled = busy;
  $('disconnect').disabled = !busy;
  $('enquire').disabled = state !== 'bound';
  $('send').disabled = state !== 'bound' || sending || val('bindMode') === 'rx';
  $('stop').disabled = !sending;
}

// ---------- Character / part counter ----------
let anTimer;
async function updateCounter() {
  const a = await api.analyze($('text').value, val('encoding'));
  const c = $('counter');
  if (a.error) { c.textContent = tm(a.error); c.classList.add('warn'); return; }
  c.classList.remove('warn');
  const unit = a.enc === 'ucs2' ? t('chars') : (a.enc === 'gsm7' ? t('septets') : t('bytes'));
  c.textContent = `${a.enc.toUpperCase()} · ${a.units} ${unit} · ${t('{n} part(s)', { n: a.parts })} · DCS 0x${a.dcs.toString(16).padStart(2, '0')}`;
}
$('text').oninput = () => { clearTimeout(anTimer); anTimer = setTimeout(updateCounter, 80); };
$('encoding').onchange = updateCounter;

// ---------- Sending ----------
$('send').onclick = async () => {
  if (!val('dst').trim()) { $('dst').focus(); return; }
  const m = { text: $('text').value }; MSG_FIELDS.forEach(f => m[f] = val(f));
  m.dlr = m.dlr ? 1 : 0;
  sending = true; updateButtons();
  $('progress').textContent = '';
  const r = await api.submit(m);
  sending = false; updateButtons();
  if (Number(m.count) > 1) $('progress').textContent = t('Done: {ok} OK, {fail} failed · {secs} s · {rate} msg/s', { ok: r.ok, fail: r.fail, secs: r.secs.toFixed(1), rate: r.rate.toFixed(1) });
};
$('stop').onclick = () => api.stop();
api.on('smpp:progress', p => { $('progress').textContent = `${p.done}/${p.total} · ✓${p.ok} ✗${p.fail}`; });

// ---------- Sent messages table ----------
const rows = new Map();
let stats = { sent: 0, acc: 0, rej: 0, dlrOk: 0, dlrFail: 0 };
api.on('smpp:message', rec => {
  let tr = rows.get(rec.uid);
  if (!tr) {
    tr = document.createElement('tr'); rows.set(rec.uid, tr);
    $('msgBody').prepend(tr); stats.sent++;
    if (rows.size > 3000) { const k = rows.keys().next().value; rows.get(k).remove(); rows.delete(k); }
  }
  const prev = tr.dataset;
  if (rec.status !== 'pending' && prev.status !== rec.status) { rec.status === 'accepted' ? stats.acc++ : stats.rej++; }
  if (rec.dlr && !prev.dlrCounted && (!rec.dlrs || Object.keys(rec.dlrs).length >= rec.parts)) {
    prev.dlrCounted = 1; /DELIVRD|^2$/.test(rec.dlr) ? stats.dlrOk++ : stats.dlrFail++;
  }
  prev.status = rec.status;
  const st = rec.status === 'pending' ? `<span class="warn">${t('pending')}</span>` : rec.status === 'accepted' ? '<span class="ok">ESME_ROK</span>' : `<span class="err">${esc(tm(rec.error))}</span>`;
  const dlrCls = !rec.dlr ? '' : /DELIVRD|^2$/.test(rec.dlr) ? 'ok' : /ACCEPTD|ENROUTE/.test(rec.dlr) ? 'warn' : 'err';
  tr.innerHTML = `<td>${rec.seq}</td><td>${time(rec.sentAt)}</td><td>${esc(rec.dst)}</td><td class="txt" title="${esc(rec.text)}">${esc(rec.text)}</td><td>${rec.enc}</td><td>${rec.parts}</td><td>${st}</td><td title="${esc(rec.ids.join(', '))}">${esc(rec.ids.join(', '))}</td><td>${rec.latency ?? ''}</td><td class="${dlrCls}">${esc(rec.dlr || (rec.status === 'accepted' && val('dlr') ? '…' : ''))}${rec.err && rec.err !== '000' ? ' <span class="muted">err:' + esc(rec.err) + '</span>' : ''}</td><td>${rec.dlrLatency ?? ''}</td>`;
  $('cMsgs').textContent = rows.size;
  renderStats();
});
function renderStats() {
  $('stats').textContent = t('Sent {sent} · Accepted {acc} · Rejected {rej} · DLR ✓{ok} ✗{fail}', { sent: stats.sent, acc: stats.acc, rej: stats.rej, ok: stats.dlrOk, fail: stats.dlrFail });
}

// ---------- Inbox ----------
let inCount = 0;
function addIn(type, from, to, content, cls) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${time(Date.now())}</td><td class="${cls || ''}">${type}</td><td>${esc(from)}</td><td>${esc(to)}</td><td class="txt" style="max-width:600px" title="${esc(content)}">${esc(content)}</td>`;
  $('inBody').prepend(tr); $('cIn').textContent = ++inCount;
}
api.on('smpp:dlr', d => addIn('DLR', d.from, d.to, `${d.stat}${d.matched ? '' : ' (' + t('unmatched id {id}', { id: d.id }) + ')'} — ${d.text}`, /DELIVRD/.test(d.stat) ? 'ok' : 'err'));
api.on('smpp:mo', m => addIn('MO', m.from, m.to, m.text, 'warn'));

// ---------- PDU log ----------
const logLines = []; let logCount = 0;
function logEl(e) {
  const div = document.createElement('div'); div.className = 'le';
  if (e.command === 'enquire_link' || e.command === 'enquire_link_resp') div.dataset.enq = 1;
  const arrow = e.dir === 'out' ? '→' : e.dir === 'in' ? '←' : '•';
  div.innerHTML = `<span class="t">${time(e.ts)}</span><span class="d ${e.dir}">${arrow}</span><span class="c">${esc(e.command)}</span>${e.status ? `<span class="${e.status === 'ESME_ROK' ? 'ok' : 'err'}">${esc(e.status)}</span>` : ''}${e.data ? `<pre>${esc(JSON.stringify(e.data, null, 2))}</pre>` : ''}`;
  if (div.dataset.enq && val('hideEnquire')) div.style.display = 'none';
  return div;
}
function pushLog(e) {
  logLines.push(e); if (logLines.length > 5000) logLines.shift();
  const list = $('logList');
  list.prepend(logEl(e));
  while (list.childElementCount > 2000) list.lastChild.remove();
  $('cLog').textContent = ++logCount;
}
function addSys(msg) { pushLog({ ts: Date.now(), dir: 'sys', command: msg }); }
api.on('smpp:log', batch => batch.forEach(pushLog));
api.on('mock:log', l => pushLog({ ts: Date.now(), dir: 'sys', command: '[vendor] ' + tm(l) }));
$('logList').onclick = e => { const le = e.target.closest('.le'); if (le) le.classList.toggle('open'); };
$('hideEnquire').onchange = () => document.querySelectorAll('.le[data-enq]').forEach(d => d.style.display = val('hideEnquire') ? 'none' : '');

$('exportLog').onclick = () => api.exportLog(logLines.map(e => `${new Date(e.ts).toISOString()} ${e.dir.toUpperCase().padEnd(3)} ${e.command}${e.status ? ' ' + e.status : ''}${e.data ? '\n' + JSON.stringify(e.data, null, 2) : ''}`).join('\n'));
$('clear').onclick = () => {
  const tab = document.querySelector('.tabs .on').dataset.tab;
  if (tab === 'msgs') { $('msgBody').innerHTML = ''; rows.clear(); stats = { sent: 0, acc: 0, rej: 0, dlrOk: 0, dlrFail: 0 }; $('cMsgs').textContent = 0; renderStats(); }
  if (tab === 'inbox') { $('inBody').innerHTML = ''; inCount = 0; $('cIn').textContent = 0; }
  if (tab === 'log') { $('logList').innerHTML = ''; logLines.length = 0; logCount = 0; $('cLog').textContent = 0; }
};

// ---------- Tabs ----------
document.querySelectorAll('.tabs button[data-tab]').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + b.dataset.tab));
  $('hideEnq').style.visibility = b.dataset.tab === 'log' ? '' : 'hidden';
});

// ---------- Built-in vendor (mock SMSC) ----------
let mockOn = false, lastMockStats = null;
window.mockState = { on: false, e2e: null };
const MOCK_FIELDS = ['mockListen','mockPort','mockDelay','mockSystemId','mockFail','mockMaxTps','mockRespDelay','mockCapacity','mockIdReuse'];
try { const o = JSON.parse(localStorage.getItem('mockForm') || '{}'); for (const k in o) setVal(k, o[k]); } catch {}
const saveMockForm = () => { const o = {}; MOCK_FIELDS.forEach(f => o[f] = val(f)); try { localStorage.setItem('mockForm', JSON.stringify(o)); } catch {} };
MOCK_FIELDS.forEach(f => $(f).addEventListener('change', saveMockForm));

async function showMockAddr() {
  if (!mockOn) { $('mockAddr').textContent = ''; return; }
  const port = val('mockPort');
  if (val('mockListen') === '0.0.0.0') {
    const ips = await api.ips();
    $('mockAddr').innerHTML = esc(t('Add this as a vendor on your platform:')) + '<br>' + (ips.length ? ips.map(i => `<b>${esc(i.address)}:${esc(port)}</b> <span class="muted">(${esc(t(i.name))})</span>`).join('<br>') : esc(t('No IP found'))) +
      (val('mockSystemId') ? `<br>system_id <b>${esc(val('mockSystemId'))}</b>` : `<br><span class="muted">${esc(t('system_id/password: any'))}</span>`);
  } else $('mockAddr').innerHTML = `<b>127.0.0.1:${esc(port)}</b> <span class="muted">— ${esc(t('this machine only'))}</span>`;
}
$('mockToggle').onclick = async () => {
  if (mockOn) { await api.mockStop(); mockOn = false; $('mockStats').textContent = ''; }
  else {
    const r = await api.mockStart({
      port: val('mockPort'), bindHost: val('mockListen'), dlrDelay: Number(val('mockDelay')), failRate: Number(val('mockFail')) / 100,
      maxTps: Number(val('mockMaxTps')), respDelay: Number(val('mockRespDelay')), capacity: Number(val('mockCapacity')), systemId: val('mockSystemId').trim(), password: val('mockPassword'),
      idReuse: Number(val('mockIdReuse')) || 0,
    });
    if (!r.ok) return alert(tm(r.error));
    mockOn = true;
    if (!val('host')) { setVal('host', '127.0.0.1'); setVal('port', val('mockPort')); setVal('tls', false); updateTls(); }
  }
  setMockUi(mockOn);
};
function setMockUi(on) {
  mockOn = on; window.mockState.on = on;
  if (!on) $('mockStats').textContent = '';
  MOCK_FIELDS.concat('mockPassword').forEach(f => $(f).disabled = on);
  $('mockToggle').textContent = on ? t('Stop') : t('Start');
  $('mockToggle').classList.toggle('primary', on);
  showMockAddr();
}
// Web version: shared server state (after a page reload or a change from another browser)
api.on('app:sync', st => {
  if (st.mock) {
    if (st.mock.on && st.mock.opts) {
      const o = st.mock.opts;
      setVal('mockListen', o.bindHost); setVal('mockPort', o.port); setVal('mockDelay', o.dlrDelay); setVal('mockSystemId', o.systemId || '');
      setVal('mockFail', Math.round((o.failRate || 0) * 100)); setVal('mockMaxTps', o.maxTps || 0); setVal('mockRespDelay', o.respDelay || 0); setVal('mockCapacity', o.capacity || 0); setVal('mockIdReuse', o.idReuse || 0);
    }
    if (st.mock.on !== mockOn) setMockUi(st.mock.on);
  }
  if (st.smpp && st.smpp.state !== state) {
    state = st.smpp.state; stateInfo = st.smpp.info ? (st.smpp.infoKey ? { key: st.smpp.infoKey, p: st.smpp.infoP, text: st.smpp.info } : st.smpp.info) : null;
    renderState(); updateButtons();
  }
  if (window.onLoadSync && st.load) window.onLoadSync(st.load);
});
let logoutLink = null;
if (api.web) {
  logoutLink = document.createElement('a'); logoutLink.href = '/logout'; logoutLink.className = 'logout';
  document.querySelector('.brand').insertBefore(logoutLink, $('lang'));
  document.body.classList.add('web');
}
$('moSend').onclick = async () => { const n = await api.mockMo(val('moText'), '447700900001', val('src')); if (!n) alert(t('The vendor is not running or has no transceiver/receiver session bound.')); };

function renderMockStats() {
  const m = lastMockStats; if (!mockOn || !m) return;
  $('mockStats').textContent = t('Bound {conns} · received {rx}/s · throttled {thr}/s · DLR {dlr}/s · pending DLR {pend}', { conns: m.conns, rx: m.rx, thr: m.throttled, dlr: m.dlrSent, pend: m.dlrPending })
    + (m.respQueue ? ' · ' + t('queue {n}', { n: m.respQueue }) : '');
}
api.on('mock:stats', m => {
  if (!mockOn) return;
  lastMockStats = m; renderMockStats();
  window.mockState.e2e = m.e2e;
  if (window.onVendorStats) window.onVendorStats(m);
});

// Re-render dynamic text when the language changes
I18N.onChange(() => {
  renderState(); renderStats(); updateCounter(); renderMockStats(); showMockAddr();
  $('mockToggle').textContent = mockOn ? t('Stop') : t('Start');
  if (logoutLink) logoutLink.textContent = t('Log out');
  refreshProfiles($('profile').value || null);
});

// ---------- Startup ----------
// The custom drag strip is only needed for the macOS hidden-inset title bar
if (!api.web && !/Mac/i.test(navigator.platform)) document.body.classList.add('nomac');
if (logoutLink) logoutLink.textContent = t('Log out');
loadForm(); updateTls(); refreshProfiles(); updateButtons(); updateCounter(); renderStats(); renderState();
$('hideEnq').style.visibility = 'hidden';
$('bindMode').addEventListener('change', updateButtons);
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('send').disabled) $('send').click(); });

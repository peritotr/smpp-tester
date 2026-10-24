// Load test view (uses $, val, setVal, esc, t, tm and CONN_FIELDS from renderer.js)
const LOAD_FIELDS = ['lSrc','lSrcTon','lSrcNpi','lDst','lDstTon','lDstNpi','lText','lEncoding','lSessions','lWindow','lTps','lMode','lAmount','lRamp','lRespTimeout','lDlrWait','lDlr','lRetry','lE2e','lName','lStepStart','lStepInc','lStepDur','cP95','cP99','cE2e','cErr','cLoss','cMinTps'];
const fmt = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString(I18N.locale);
const fms = n => n == null || isNaN(n) ? '—' : (n < 10 ? n.toFixed(1) : Math.round(n).toString());

let series = [], lastResult = null, loadRunning = false, testStartedAt = null, lastTotals = null, e2eOn = false, lastReportId = null, lastVerdict = null;
let phaseMsg = null; // last status line shown next to the buttons (re-translated on language change)

// ---------- Mode switch ----------
document.querySelectorAll('.modes button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.modes button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + b.dataset.mode));
  try { localStorage.setItem('mode', b.dataset.mode); } catch {}
  if (b.dataset.mode === 'load') redraw();
});

// ---------- Persisted form ----------
function saveLoadForm() { const o = {}; LOAD_FIELDS.forEach(f => o[f] = val(f)); try { localStorage.setItem('loadForm', JSON.stringify(o)); } catch {} }
try { const o = JSON.parse(localStorage.getItem('loadForm') || '{}'); for (const k in o) setVal(k, o[k]); } catch {}
document.getElementById('view-load').addEventListener('change', saveLoadForm);
const updAmountLbl = () => { $('lAmountLbl').textContent = val('lMode') === 'total' ? t('Count') : t('Duration (s)'); $('view-load').classList.toggle('steps', val('lMode') === 'steps'); updStepInfo(); };
function updStepInfo() {
  if (val('lMode') !== 'steps' || loadRunning) return;
  const a = Number(val('lStepStart')) || 1, inc = Number(val('lStepInc')) || 1, max = Number(val('lTps')) || a, d = Number(val('lStepDur')) || 60;
  const n = Math.max(1, Math.ceil((max - a) / inc) + 1);
  setPhase({ key: '{n} steps · {from} → {to} TPS · ~{min} min total', p: { n, from: fmt(a), to: fmt(max), min: Math.round(n * d / 60) } });
}
['lStepStart','lStepInc','lStepDur','lTps'].forEach(id => $(id).addEventListener('input', updStepInfo));
$('lMode').addEventListener('change', updAmountLbl);

// ---------- Start / stop ----------
$('lStart').onclick = async () => {
  if (!val('host').trim()) { alert(t('Enter the server details on the left first.')); $('host').focus(); return; }
  if (Number(val('lSessions')) * Number(val('lWindow')) < Number(val('lTps')) * 0.05) {
    if (!confirm(t('Sessions × window looks low for the target TPS; if responses are slow the target may not be reached. Start anyway?'))) return;
  }
  e2eOn = val('lE2e');
  if (e2eOn && !window.mockState.on) {
    if (!confirm(t('End-to-end measurement needs the vendor on the left to be running and your platform to route messages to it. The vendor is stopped. Start anyway?'))) return;
  }
  if (e2eOn) await api.mockReset();
  $('e2ePanel').style.display = e2eOn ? '' : 'none';
  ['eRx','eMiss','eDup'].forEach(id => $(id).textContent = '0'); $('eLat').textContent = '—';
  lastTotals = null;
  const cfg = {}; CONN_FIELDS.forEach(f => cfg[f] = val(f));
  const test = {
    sessions: val('lSessions'), window: val('lWindow'), tps: val('lTps'),
    total: val('lMode') === 'total' ? val('lAmount') : 0, duration: val('lMode') === 'duration' ? val('lAmount') : 0,
    steps: val('lMode') === 'steps' ? { start: val('lStepStart'), inc: val('lStepInc'), dur: val('lStepDur') } : null,
    name: val('lName').trim(),
    criteria: {
      p95Max: Number(val('cP95')) || null, p99Max: Number(val('cP99')) || null, e2eP95Max: e2eOn ? (Number(val('cE2e')) || null) : null,
      errMaxPct: val('cErr') === '' ? null : Number(val('cErr')), lossMaxPct: e2eOn && val('cLoss') !== '' ? Number(val('cLoss')) : null,
      minTps: Number(val('cMinTps')) || Number(val('lTps')),
    },
    ramp: val('lRamp'), respTimeout: val('lRespTimeout'), dlrWait: val('lDlrWait'), dlr: val('lDlr'), retryThrottle: val('lRetry'),
    src: val('lSrc'), srcTon: val('lSrcTon'), srcNpi: val('lSrcNpi'), dst: val('lDst'), dstTon: val('lDstTon'), dstNpi: val('lDstNpi'),
    text: val('lText'), encoding: val('lEncoding'), e2e: e2eOn,
  };
  series = []; lastResult = { cfg: { host: cfg.host, port: cfg.port, systemId: cfg.systemId }, test }; testStartedAt = new Date();
  resetKpis(); redraw();
  setRunning(true); setPhase('Starting…');
  await api.loadStart(cfg, test);
};
$('lStop').onclick = () => { api.loadStop(); setPhase('Stopping… (press again to finish without waiting)'); };

function setRunning(r) {
  if (r) $('lReport').style.display = 'none';
  loadRunning = r;
  $('lStart').disabled = r; $('lStop').disabled = !r; $('lCsv').disabled = r || !series.length;
  document.querySelectorAll('#view-load .compose input, #view-load .compose select').forEach(e => e.disabled = r);
}
function setPhase(msg, cls) { phaseMsg = { msg, cls }; renderPhase(); }
function renderPhase() {
  if (!phaseMsg) return;
  const { msg, cls } = phaseMsg;
  $('lPhase').textContent = msg && msg.prefix ? t(msg.prefix) + ': ' + tm(msg.body) : tm(msg);
  $('lPhase').className = cls || 'muted';
}

api.on('load:phase', m => {
  if (m.phase === 'error') { setRunning(false); setPhase({ prefix: 'Error', body: m }, 'err'); }
  else if (m.phase === 'done') { setRunning(false); setPhase('Test finished', 'ok'); }
  else setPhase(m);
});
api.on('load:log', m => { const n = $('lNotes'); n.textContent = tm(m) + '\n' + n.textContent; });

api.on('load:tick', m => {
  const ve = window.mockState.e2e;
  if (e2eOn && ve && m.row.e2eN == null) { m.row.e2eN = ve.n; m.row.e2eP50 = ve.sec.p50; m.row.e2eP95 = ve.sec.p95; m.row.e2eP99 = ve.sec.p99; }
  lastTotals = m.totals;
  series.push(m.row);
  $('kSentTps').textContent = fmt(m.row.sentTps);
  $('kOkTps').textContent = fmt(m.row.okTps);
  renderTotals(m.totals, m.row);
  redraw();
});
api.on('load:done', m => {
  lastResult = lastResult || {}; lastResult.totals = m.totals; lastTotals = m.totals; series = series.length ? series : m.series;
  renderTotals(m.totals);
  $('kSentTps').textContent = '—'; $('kOkTps').textContent = '—';
  $('lCsv').disabled = false;
  redraw();
});

function resetKpis() {
  ['kSentTps','kOkTps','kAvgTps','kLat','kDlrLat'].forEach(id => $(id).textContent = '—');
  ['kSent','kOk','kErr','kThr','kTo','kInfl','kDlr'].forEach(id => $(id).textContent = '0');
  $('tErrs').innerHTML = '<tr><td class="muted">—</td></tr>'; $('tDlr').innerHTML = '<tr><td class="muted">—</td></tr>';
}
function renderTotals(T, r) {
  if (!T) return;
  $('kAvgTps').textContent = fmt(T.avgTps);
  $('kSent').textContent = fmt(T.sent);
  $('kOk').textContent = fmt(T.ok);
  $('kErr').textContent = fmt(T.err);
  $('kThr').textContent = fmt(T.throttled) + (T.retries ? ' ' + t('({n} retried)', { n: fmt(T.retries) }) : '');
  $('kTo').textContent = fmt(T.timeouts);
  $('kInfl').textContent = r ? fmt(r.inflight) : '0';
  $('kDlr').textContent = `${fmt(T.dlrOk)} / ${fmt(T.dlrFail)}` + (T.dlrUnmatched ? ' · ' + t('{n} unmatched', { n: fmt(T.dlrUnmatched) }) : '') + (T.pendingDlr ? ' · ' + t('{n} pending', { n: fmt(T.pendingDlr) }) : '');
  const l = T.lat || {};
  $('kLat').textContent = l.n ? `${fms(l.p50)} / ${fms(l.p95)} / ${fms(l.p99)}` : '—';
  const d = T.dlrLat || {};
  $('kDlrLat').textContent = d.n ? `${fms(d.p50)} / ${fms(d.p95)} ms` : '—';
  const errs = Object.entries(T.errs || {}).sort((a, b) => b[1] - a[1]);
  $('tErrs').innerHTML = errs.length ? errs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${fmt(v)}</td></tr>`).join('') : `<tr><td class="muted">${t('No errors')}</td></tr>`;
  const ds = Object.entries(T.dlrStats || {}).sort((a, b) => b[1] - a[1]);
  $('tDlr').innerHTML = ds.length ? ds.map(([k, v]) => `<tr><td class="${k === 'DELIVRD' ? 'ok' : 'err'}">${esc(k)}</td><td class="r">${fmt(v)}</td></tr>`).join('') : '<tr><td class="muted">—</td></tr>';
}

// ---------- Charts (plain canvas, no dependencies) ----------
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const TPS_LINES = [
  { k: 'target', label: 'Target', c: '--muted', dash: true },
  { k: 'sentTps', label: 'Sent', c: '--accent' },
  { k: 'okTps', label: 'Accepted', c: '--ok' },
  { k: 'dlrTps', label: 'DLR', c: '--violet' },
  { k: 'thrTps', label: 'Throttle', c: '--warn' },
  { k: 'errTps', label: 'Errors', c: '--err' },
];
const LAT_LINES = [
  { k: 'p50', label: 'p50', c: '--ok' },
  { k: 'p95', label: 'p95', c: '--warn' },
  { k: 'p99', label: 'p99', c: '--err' },
  { k: 'e2eP95', label: 'End-to-end p95', c: '--violet' },
];
function legend(el, lines) { el.innerHTML = lines.map(l => `<i style="background:${css(l.c)}"></i>${esc(t(l.label))}`).join(''); }
function legends() { legend($('lgTps'), TPS_LINES); legend($('lgLat'), LAT_LINES); }

function drawChart(cv, lines, target) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  const L = 52, R = 10, T = 8, B = 22, w = W - L - R, h = H - T - B;
  let max = target || 0;
  for (const r of series) for (const l of lines) if (r[l.k] > max) max = r[l.k];
  if (!max) max = 1;
  const raw = max * 1.08 / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const stepN = [1, 2, 2.5, 5, 10].find(m => m * mag >= raw) * mag; max = stepN * 4;
  const n = Math.max(series.length, 10);
  const x = i => L + (n <= 1 ? 0 : i / (n - 1) * w), y = v => T + h - v / max * h;
  g.font = '10.5px -apple-system, sans-serif'; g.fillStyle = css('--muted'); g.strokeStyle = css('--line'); g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4, yy = Math.round(y(v)) + .5;
    g.beginPath(); g.moveTo(L, yy); g.lineTo(L + w, yy); g.stroke();
    g.textAlign = 'right'; g.fillText(v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : (v < 10 && v % 1 ? v.toFixed(1) : Math.round(v)), L - 6, yy + 3.5);
  }
  g.textAlign = 'center';
  const step = Math.max(1, Math.ceil(n / 8));
  const t0 = series.length ? series[0].t : 1;
  for (let i = 0; i < n; i += step) g.fillText((series[i]?.t ?? t0 + i) + 's', x(i), H - 6);
  if (target) { g.setLineDash([4, 4]); g.strokeStyle = css('--muted'); g.beginPath(); g.moveTo(L, y(target)); g.lineTo(L + w, y(target)); g.stroke(); g.setLineDash([]); }
  g.lineWidth = 2; g.lineJoin = 'round';
  for (const l of lines) {
    if (!series.some(r => r[l.k] > 0)) continue;
    g.strokeStyle = css(l.c); g.setLineDash(l.dash ? [5, 4] : []); g.lineWidth = l.dash ? 1.5 : 2; g.beginPath(); let started = false;
    series.forEach((r, i) => { const v = r[l.k]; if (v == null) { started = false; return; } started ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); started = true; });
    g.stroke(); g.setLineDash([]);
  }
}
function redraw() {
  if (!$('view-load').classList.contains('on')) return;
  drawChart($('cTps'), TPS_LINES, series.some(r => r.target != null) ? 0 : (loadRunning || series.length ? Number(val('lTps')) : 0));
  drawChart($('cLat'), LAT_LINES);
}
legends();
window.addEventListener('resize', redraw);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { legends(); redraw(); });

// ---------- CSV ----------
// Turkish Excel expects ';' separators and ',' decimals; English uses ',' and '.'
function csvFormat() { return I18N.lang === 'tr' ? { sep: ';', dec: ',' } : { sep: ',', dec: '.' }; }
$('lCsv').onclick = () => {
  if (!series.length) return;
  const { sep, dec } = csvFormat();
  const r = lastResult || {}, T = r.totals || {}, l = T.lat || {}, d = T.dlrLat || {}, te = r.test || {};
  const num = v => v == null || isNaN(v) ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(2)).replace('.', dec);
  const row = a => a.map(v => typeof v === 'number' ? num(v) : String(v ?? '').replace(new RegExp(sep, 'g'), ' ')).join(sep);
  const lines = [
    '# ' + t('SMPP Tester load test'),
    row(['# ' + t('Date'), testStartedAt ? testStartedAt.toISOString() : '']),
    row(['# ' + t('Server'), `${r.cfg?.host}:${r.cfg?.port}`, 'system_id', r.cfg?.systemId]),
    row(['# ' + t('Sessions'), te.sessions, 'Window', te.window, t('Target TPS'), te.tps, t('Duration (s)'), te.duration || '', t('Count'), te.total || '', 'Ramp-up', te.ramp]),
    row(['# ' + t('Sent'), T.sent, t('Accepted'), T.ok, t('Errors'), T.err, 'Throttle', T.throttled, t('Retries'), T.retries, t('Timeouts'), T.timeouts]),
    row(['# ' + t('Average TPS'), T.avgTps, t('Duration (s)'), T.secs]),
    row(['# ' + t('Response ms'), 'p50', l.p50, 'p95', l.p95, 'p99', l.p99, 'max', l.max]),
    row(['# DLR', T.dlr, 'DELIVRD', T.dlrOk, t('other'), T.dlrFail, t('unmatched'), T.dlrUnmatched, 'DLR ms p50', d.p50, 'p95', d.p95]),
    ...(r.e2e ? [row(['# ' + t('End-to-end'), t('reached vendor'), r.e2e.n, t('missing'), Math.max(0, (T.ok || 0) - r.e2e.n), t('duplicates'), r.e2e.dup, 'p50 ms', r.e2e.total?.p50, 'p95', r.e2e.total?.p95, 'p99', r.e2e.total?.p99])] : []),
    row(['# ' + t('Error codes'), Object.entries(T.errs || {}).map(([k, v]) => k + '=' + v).join(' ')]),
    '',
    ['second', 'sent_tps', 'accepted_tps', 'error_tps', 'throttle_tps', 'dlr_tps', 'inflight', 'rate_factor', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'dlr_p50_ms', 'dlr_p95_ms', 'e2e_total', 'e2e_p50_ms', 'e2e_p95_ms', 'e2e_p99_ms'].join(sep),
    ...series.map(s => row([s.t, s.sentTps, s.okTps, s.errTps, s.thrTps, s.dlrTps, s.inflight, s.rate, s.p50, s.p95, s.p99, s.max, s.dlrP50, s.dlrP95, s.e2eN, s.e2eP50, s.e2eP95, s.e2eP99])),
  ];
  api.saveFile('﻿' + lines.join('\n'), `smpp-load-test-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`);
};

// ---------- End-to-end (vendor statistics) ----------
window.onVendorStats = m => {
  if (!e2eOn || !m.e2e) return;
  const e = m.e2e, tt = e.total || {};
  $('eRx').textContent = fmt(e.n);
  const ok = lastTotals ? lastTotals.ok : 0, miss = Math.max(0, ok - e.n);
  $('eMiss').textContent = fmt(miss) + (lastTotals && !loadRunning && ok ? ` (${(miss / ok * 100).toFixed(2)}%)` : '');
  $('eMiss').className = !loadRunning && miss ? 'err' : '';
  $('eDup').textContent = fmt(e.dup); $('eDup').className = e.dup ? 'err' : '';
  $('eLat').textContent = tt.n ? `${fms(tt.p50)} / ${fms(tt.p95)} / ${fms(tt.p99)} ms` : '—';
  if (lastResult) lastResult.e2e = e;
};

// Web version: restore a running test after a page reload
window.onLoadSync = ld => {
  const active = ['binding', 'running', 'draining'].includes(ld.phase);
  if (active && !loadRunning) {
    setRunning(true); setPhase(ld.key || ld.text ? ld : 'Running'); document.querySelector('.modes [data-mode=load]').click();
    if (ld.test) { setVal('lE2e', !!ld.test.e2e); if (ld.test.tps) setVal('lTps', ld.test.tps); }
    e2eOn = val('lE2e'); $('e2ePanel').style.display = e2eOn ? '' : 'none';
    lastResult = lastResult || { test: {} };
  }
  if (ld.reportId && !active) { lastReportId = ld.reportId; showReportButton(); }
  // Pull the history kept on the server so charts and counters refill after a reload
  if (ld.series && ld.series.length && !series.length) {
    series = ld.series.slice();
    if (ld.totals) { lastTotals = ld.totals; renderTotals(ld.totals, series[series.length - 1]); if (!active) { lastResult = { ...(lastResult || {}), totals: ld.totals }; $('lCsv').disabled = false; } }
    $('e2ePanel').style.display = (ld.test && ld.test.e2e) ? '' : 'none';
    if (ld.test) { e2eOn = !!ld.test.e2e; if (ld.test.tps) setVal('lTps', ld.test.tps); }
    if (!active && ld.phase === 'done') setPhase('Last test finished', 'ok');
    redraw();
  }
};

// The report is saved when a test finishes
function showReportButton() {
  const b = $('lReport'); b.style.display = '';
  b.textContent = lastVerdict === 'pass' ? t('Open report · Passed') : lastVerdict === 'fail' ? t('Open report · Failed') : t('Open report');
  b.className = lastVerdict === 'fail' ? 'ghost err' : lastVerdict === 'pass' ? 'ghost ok' : 'ghost';
}
api.on('report:saved', e => {
  lastReportId = e.id; lastVerdict = e.verdict; showReportButton();
  if (window.refreshReports) window.refreshReports();
});
$('lReport').onclick = () => lastReportId && api.reportOpen(lastReportId);

I18N.onChange(() => {
  updAmountLbl(); renderPhase(); legends(); redraw();
  if (lastTotals) renderTotals(lastTotals, series[series.length - 1]);
  if ($('lReport').style.display !== 'none') showReportButton();
});

updAmountLbl();
// Restore the last used mode
try { const m = localStorage.getItem('mode'); if (m && m !== 'single') document.querySelector(`.modes [data-mode=${m}]`).click(); } catch {}

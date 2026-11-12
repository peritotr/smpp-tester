// Routing test view: several vendors and clients at once (uses $, val, setVal, esc, t, tm, profiles from renderer.js)
(() => {
  const MAX = 4;
  const fmtN = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString(I18N.locale);
  const VCOLS = [['name', 'w-m'], ['port', 'w-s', 'number'], ['systemId', 'w-m'], ['password', 'w-m', 'password'], ['prefixes', 'w-l'], ['respDelay', 'w-s', 'number'], ['dlrDelay', 'w-s', 'number'], ['failPct', 'w-s', 'number'], ['maxTps', 'w-s', 'number']];
  const CCOLS = [['name', 'w-m'], ['profile', 'w-m', 'profile'], ['host', 'w-m'], ['port', 'w-s', 'number'], ['systemId', 'w-m'], ['password', 'w-m', 'password'], ['dst', 'w-l'], ['sessions', 'w-s', 'number'], ['window', 'w-s', 'number'], ['tps', 'w-s', 'number']];
  const newV = i => ({ name: 'Vendor ' + String.fromCharCode(65 + i), port: 2781 + i, systemId: 'vend' + String.fromCharCode(65 + i), password: 'test', prefixes: '', respDelay: 0, dlrDelay: 1000, failPct: 0, maxTps: 0 });
  const newC = i => ({ name: 'Client ' + (i + 1), profile: '', host: val('host') || '', port: Number(val('port')) || 2775, systemId: '', password: '', dst: '', sessions: 4, window: 200, tps: 1000 });

  let F = null;
  try { F = JSON.parse(localStorage.getItem('routingForm') || 'null'); } catch {}
  if (!F || !Array.isArray(F.vendors)) F = {
    vendors: [{ ...newV(0), prefixes: '9053' }, { ...newV(1), prefixes: '9054' }],
    clients: [{ ...newC(0), dst: '9053XXXXXXXX:70, 9054XXXXXXXX:30' }, { ...newC(1), dst: '9053XXXXXXXX:30, 9054XXXXXXXX:70' }],
  };
  // Client passwords are not kept in the browser: they come from the selected profile or are typed in for this session
  const save = () => { try { localStorage.setItem('routingForm', JSON.stringify({ ...F, clients: F.clients.map(c => ({ ...c, password: '' })) })); } catch {} };
  for (const id of ['rtName', 'rtDuration', 'rtRamp', 'rtDlrWait', 'rtText', 'rtDlr']) { if (F[id] != null) setVal(id, F[id]); $(id).addEventListener('change', () => { F[id] = val(id); save(); }); }

  function cell(row, [k, cls, type], kind) {
    if (type === 'profile') return `<td><select class="${cls}" data-k="${k}"><option value="">—</option>${(typeof profiles !== 'undefined' ? profiles : []).map(p => `<option ${p.name === row.profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></td>`;
    return `<td><input class="${cls}" data-k="${k}" type="${type || 'text'}" value="${esc(row[k] ?? '')}" spellcheck="false"${type === 'number' ? ' min="0"' : ''}></td>`;
  }
  function table(kind) {
    const rows = kind === 'v' ? F.vendors : F.clients, cols = kind === 'v' ? VCOLS : CCOLS;
    $(kind === 'v' ? 'rtV' : 'rtC').innerHTML = rows.map((r, i) => `<tr data-i="${i}">${cols.map(c => cell(r, c, kind)).join('')}<td>${rows.length > 1 ? `<button class="ghost small" data-del="${i}" title="${esc(t('Remove'))}">✕</button>` : ''}</td></tr>`).join('');
    $(kind === 'v' ? 'rtAddV' : 'rtAddC').disabled = rows.length >= MAX || running;
    vHint();
  }
  function render() { table('v'); table('c'); setRunning(running); }
  async function vHint() {
    let ips = []; try { ips = await api.ips() || []; } catch {}
    const ip = (ips[0] && ips[0].address) || 'this server';
    $('rtVHint').textContent = t('Add them on your platform as vendors: {list}', { list: F.vendors.map(v => `${v.name} → ${ip}:${v.port} (${v.systemId || '—'})`).join(' · ') });
  }
  for (const kind of ['v', 'c']) {
    const tb = $(kind === 'v' ? 'rtV' : 'rtC'), rows = () => kind === 'v' ? F.vendors : F.clients;
    tb.addEventListener('input', e => {
      const k = e.target.dataset.k, i = Number(e.target.closest('tr').dataset.i); if (!k) return;
      rows()[i][k] = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
      if (kind === 'v') vHint();
      save();
    });
    tb.addEventListener('change', e => {
      if (e.target.dataset.k !== 'profile') return;
      const r = F.clients[Number(e.target.closest('tr').dataset.i)], p = (profiles || []).find(x => x.name === e.target.value);
      r.profile = e.target.value;
      if (p) { r.host = p.host || ''; r.port = Number(p.port) || 2775; r.systemId = p.systemId || ''; r.password = p.password || ''; if (!r.name || /^Client \d$/.test(r.name)) r.name = p.name; }
      save(); table('c');
    });
    tb.addEventListener('click', e => { const d = e.target.dataset.del; if (d == null) return; rows().splice(Number(d), 1); save(); table(kind); });
  }
  $('rtAddV').onclick = () => { if (F.vendors.length < MAX) { F.vendors.push(newV(F.vendors.length)); save(); table('v'); } };
  $('rtAddC').onclick = () => { if (F.clients.length < MAX) { F.clients.push(newC(F.clients.length)); save(); table('c'); } };

  // ---------- Run ----------
  let running = false, reportId = null, vUp = false;
  function setRunning(r) {
    running = r;
    $('rtStart').disabled = r; $('rtStop').disabled = !r;
    document.querySelectorAll('#view-routing .compose input, #view-routing .compose select, #rtV button, #rtC button').forEach(e => e.disabled = r);
    // While the vendors are up their settings are fixed (the platform is bound to them)
    if (vUp) document.querySelectorAll('#rtV input, #rtV button').forEach(e => e.disabled = true);
    if (!r) { $('rtAddV').disabled = vUp || F.vendors.length >= MAX; $('rtAddC').disabled = F.clients.length >= MAX; } else { $('rtAddV').disabled = $('rtAddC').disabled = true; }
    $('rtVendors').disabled = r;
    $('rtVendors').textContent = vUp ? t('Stop vendors') : t('Start vendors');
    $('rtVendors').classList.toggle('primary', !vUp && !r);
    if (r) $('rtReport').style.display = 'none';
  }
  function vendorsState(m) {
    vUp = !!(m && m.up);
    const L = (m && m.list) || [];
    $('rtVState').innerHTML = vUp ? L.map(v => `<span class="${v.conns ? 'ok' : 'warn'}">${esc(v.name)} ${v.conns ? '✓ ' + esc(t('bound')) : '○ ' + esc(t('waiting for bind'))}</span>`).join(' · ') : '';
    if (vUp && !running) $('rtLiveV').innerHTML = L.map(v => `<tr><td>${esc(v.name)}</td><td class="r ${v.conns ? 'ok' : 'warn'}">${v.conns}</td><td class="r">—</td><td class="r">—</td><td class="r">—</td><td class="r">—</td></tr>`).join('');
    setRunning(running);
  }
  $('rtVendors').onclick = async () => {
    $('rtVendors').disabled = true;
    const wasUp = vUp;
    const r = wasUp ? await api.routingVendorsStop() : await api.routingVendorsStart({ vendors: F.vendors.map(v => ({ ...v })), clients: F.clients.map(c => ({ dst: c.dst })) });
    $('rtVendors').disabled = false;
    if (!r || !r.ok) phase(r && r.key ? { key: r.key, p: r.p } : { text: t('Error: {msg}', { msg: r && r.error }) }, 'err');
    else phase(wasUp ? '' : t('Vendors are up: add them on your platform and wait until each shows "bound".'));
  };
  api.on('routing:vendors', vendorsState);
  const phase = (m, cls) => { $('rtPhase').textContent = m ? tm(m) : ''; $('rtPhase').className = cls || 'muted'; };
  const log = m => { const el = $('rtLog'); el.textContent = `${new Date().toLocaleTimeString(I18N.locale)}  ${m}\n` + el.textContent.slice(0, 20000); };

  $('rtStart').onclick = async () => {
    const miss = F.clients.find(c => !c.host || !c.dst);
    if (miss) { alert(t('{name}: enter the host and the prefix mix.', { name: miss.name })); return; }
    const spec = {
      name: val('rtName').trim(), duration: Number(val('rtDuration')) || 60, ramp: Number(val('rtRamp')) || 0, dlrWait: Number(val('rtDlrWait')) || 0,
      dlr: val('rtDlr'), text: val('rtText') || 'Routing test', respTimeout: 10, bindWait: 30,
      vendors: F.vendors.map(v => ({ ...v })), clients: F.clients.map(c => ({ ...c, bindMode: 'trx' })),
    };
    $('rtLog').textContent = ''; $('rtLiveC').innerHTML = $('rtLiveV').innerHTML = '';
    setRunning(true); phase('Starting…');
    const r = await api.routingStart(spec);
    if (!r || !r.ok) { setRunning(false); phase(r && r.key ? { key: r.key, p: r.p } : { text: t('Error: {msg}', { msg: r && r.error }) }, 'err'); }
  };
  $('rtStop').onclick = () => { api.routingStop(); phase('Stopping… (press again to finish without waiting)'); };
  $('rtReport').onclick = () => reportId && api.reportOpen(reportId);

  const PH = { idle: '—', waiting: 'Waiting for binds…', binding: 'Binding…', running: 'Sending', draining: 'Waiting for responses and DLRs…', done: 'Done', error: 'Error' };
  api.on('routing:phase', m => {
    if (m.phase === 'error') { setRunning(false); phase(m.key ? m : { text: m.text }, 'err'); }
    else if (m.phase === 'done') { setRunning(false); }
    else { if (!running) setRunning(true); phase(m); }
    if (m.key && m.phase !== 'done') log(tm(m));
  });
  api.on('routing:log', m => log(tm(m)));
  api.on('routing:clog', m => log(`${m.client}: ${tm(m.msg)}`));
  api.on('routing:vlog', m => log(`${m.vendor}: ${tm(m.msg)}`));
  api.on('routing:tick', m => {
    $('rtLiveC').innerHTML = m.clients.map(c => `<tr><td>${esc(c.name)}</td><td class="${c.phase === 'error' ? 'err' : ''}">${esc(t(PH[c.phase] || c.phase))}</td><td class="r">${fmtN(c.sentTps)}</td><td class="r">${fmtN(c.okTps)}</td>
      <td class="r">${c.p95 == null ? '—' : c.p95 < 10 ? c.p95.toFixed(1) : Math.round(c.p95)}</td><td class="r ${c.thrTps ? 'warn' : ''}">${fmtN(c.thrTps)}</td><td class="r ${c.errTps ? 'err' : ''}">${fmtN(c.errTps)}</td><td class="r">${fmtN(c.sent)}</td><td class="r">${fmtN(c.dlr)}</td></tr>`).join('');
    $('rtLiveV').innerHTML = m.vendors.map(v => `<tr><td>${esc(v.name)}</td><td class="r">${v.conns}</td><td class="r">${fmtN(v.rx)}</td><td class="r">${fmtN(v.n)}</td>
      <td class="r">${v.e2eP95 == null ? '—' : Math.round(v.e2eP95) + ' ms'}</td><td class="r ${v.misroute ? 'err' : 'ok'}">${fmtN(v.misroute)}</td></tr>`).join('');
  });
  api.on('routing:done', m => {
    setRunning(false); reportId = m.reportId;
    if (m.totals) {
      const T = m.totals, issues = [T.misroute && t('{n} misrouted', { n: fmtN(T.misroute) }), T.lost && t('{n} lost', { n: fmtN(T.lost) }), T.dup && t('{n} duplicates', { n: fmtN(T.dup) }), T.wrongDlr && t('{n} DLRs at the wrong client', { n: fmtN(T.wrongDlr) })].filter(Boolean);
      phase({ text: issues.length ? t('Finished with issues: {list}', { list: issues.join(', ') }) : t('Finished: every message reached the right vendor') }, issues.length ? 'err' : 'ok');
    } else phase('Test finished', 'ok');
    if (reportId) $('rtReport').style.display = '';
    if (window.refreshReports) window.refreshReports();
  });
  // Web version: the test keeps running on the server when the page reloads
  window.onRoutingSync = st => {
    if (st.vendors) vendorsState(st.vendors);
    if (['starting', 'running', 'finishing'].includes(st.phase)) { setRunning(true); phase(st); }
    if (st.reportId && st.phase === 'done') { reportId = st.reportId; $('rtReport').style.display = ''; }
  };
  document.querySelector('.modes [data-mode=routing]').addEventListener('click', () => table('c')); // profiles may have changed
  I18N.onChange(render);
  render();
})();

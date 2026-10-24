// Load test report page
(async () => {
  const $ = id => document.getElementById(id);
  const t = (s, p) => I18N.t(s, p);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const N = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString(I18N.locale);
  const MS = n => n == null || isNaN(n) ? '—' : (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString(I18N.locale));
  const mmss = s => { s = Math.max(0, Math.round(s || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const dt = ts => ts ? new Date(ts).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const yn = b => b ? t('Yes') : t('No');

  $('lang').value = I18N.lang;
  $('lang').onchange = () => I18N.setLang($('lang').value);
  I18N.apply();

  const id = new URLSearchParams(location.search).get('id');
  let rep = null;
  try { rep = await api.reportGet(id); } catch {}
  if (!rep) { $('report').innerHTML = `<section><h2>${esc(t('Report not found'))}</h2><p class="muted">${esc(t('It may have been deleted.'))}</p></section>`; return; }
  const T = rep.totals || {}, test = rep.test || {}, S = rep.series || [], ev = rep.events || [];
  const L = T.lat || {}, ve = rep.vendor && rep.vendor.e2e, steps = test.steps && test.steps.length;
  let a, title;
  const STEP_STATUS = { ok: 'Clean', latency: 'Latency up', saturated: 'Saturated', warning: 'Throttle / errors', none: '—' };
  const evText = e => e.key ? t(e.key, e.p) : e.text;

  function render() {
  a = SmppAnalysis.analyze(rep);
  title = rep.name || (steps ? t('Step load test') : t('Load test'));
  document.title = `${title} — ${dt(rep.createdAt)}`;

  // ---------- Headline ----------
  let lead;
  if (steps && a.knee) lead = a.knee.status === 'saturated'
    ? t('The platform ran without a latency increase <b>up to {good} TPS</b>; it saturated at the <b>{knee} TPS</b> step.', { good: N(a.lastGood ? a.lastGood.target : 0), knee: N(a.knee.target) })
    : t('The platform ran without a latency increase <b>up to {good} TPS</b>; latency rose at the <b>{knee} TPS</b> step.', { good: N(a.lastGood ? a.lastGood.target : 0), knee: N(a.knee.target) });
  else if (steps) lead = t('The platform ran without a latency increase or saturation <b>up to {max} TPS</b>, the highest load tested.', { max: N(test.steps.at(-1)) });
  else if (a.onset || a.saturation) lead = t('Target {target} TPS; the platform sustained at most <b>{cap} TPS</b>', { target: N(test.tps), cap: N(a.capacity && a.capacity.ok) })
    + (a.onset ? t(', and latency started rising at <b>~{tps} TPS</b>', { tps: N(a.onset.tps) }) : '') + '.';
  else lead = t('The platform sustained the target <b>{tps} TPS</b> without issues{dur}; p95 response {p95} ms.', { tps: N(test.tps), dur: a.steady ? t(' for {s} s', { s: N(a.steady.minutes * 60) }) : '', p95: MS(a.steady ? a.steady.p95 : L.p95) });

  const errPct = T.sent ? T.err / T.sent * 100 : 0;
  const loss = ve && T.ok ? Math.max(0, T.ok - ve.n) : null;
  const verdict = a.verdict === 'pass' ? `<div class="verdict pass">${esc(t('PASSED'))}</div>` : a.verdict === 'fail' ? `<div class="verdict fail">${esc(t('FAILED'))}</div>` : `<div class="verdict none">${esc(t('No criteria'))}</div>`;

  const kpis = [
    [t('Peak capacity'), N(a.capacity && a.capacity.ok), t('TPS · 10 s avg.')],
    [steps ? t('Latency onset step') : t('Latency onset load'), a.knee ? N(a.knee.target) : a.onset ? '~' + N(a.onset.tps) : t('none'), a.knee || a.onset ? 'TPS' : ''],
    [t('Sustained'), N(a.steady ? a.steady.ok : null), t('TPS · steady state')],
    [t('Response p50 / p95 / p99'), `${MS(L.p50)} / ${MS(L.p95)} / ${MS(L.p99)}`, 'ms'],
    [t('Baseline latency (p95)'), MS(a.baseline && a.baseline.p95), t('ms · at low load')],
    [t('End-to-end p95'), ve && ve.total ? MS(ve.total.p95) : '—', ve ? 'ms' : t('not measured')],
    [t('Error rate'), errPct.toFixed(errPct < 0.01 ? 3 : 2) + '%', `${N(T.err)} / ${N(T.sent)}`],
    [t('Lost / duplicate'), ve ? `${N(loss)} / ${N(ve.dup)}` : '—', ve ? t('messages') : t('not measured')],
  ];

  let html = `
  <section>
    <div class="head">
      <div><h1>${esc(title)}</h1>
        <div class="meta">${dt(rep.startedAt || rep.createdAt)} · ${N(T.secs)} s · ${esc(rep.cfg && rep.cfg.host)}:${esc(rep.cfg && rep.cfg.port)} · system_id ${esc(rep.cfg && rep.cfg.systemId || '—')}</div></div>
      ${verdict}
    </div>
    <p class="lead">${lead}</p>
    <div class="kpis">${kpis.map(k => `<div class="kpi"><span>${esc(k[0])}</span><b>${k[1]}</b><i>${esc(k[2])}</i></div>`).join('')}</div>
  </section>
  <section><h2>${esc(t('Findings'))}</h2><ul class="findings">${a.findings.map(f => `<li><span class="dot ${f.level}"></span><span>${esc(f.text)}</span></li>`).join('')}</ul></section>`;

  if (a.criteria.length) html += `<section><h2>${esc(t('Acceptance criteria'))}</h2><table><thead><tr><th>${esc(t('Criterion'))}</th><th>${esc(t('Limit'))}</th><th>${esc(t('Measured'))}</th><th>${esc(t('Result'))}</th></tr></thead><tbody>
    ${a.criteria.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.lim)}</td><td class="mono">${esc(c.val)}</td><td class="${c.ok ? 'ok' : 'err'}"><b>${esc(c.ok ? t('Passed') : t('Failed'))}</b></td></tr>`).join('')}</tbody></table></section>`;

  html += `
  <section><h2>${esc(t('Load: target vs. actual TPS'))}</h2><div class="legend" id="lg1"></div><div class="chart"><canvas id="c1"></canvas></div>
    <p class="note">${esc(t('Vertical lines: {steps}latency onset (yellow), saturation (red), session drops.', { steps: steps ? t('step changes (thin), ') : '' }))}</p></section>
  <section><h2>${esc(t('Response latency (submit_sm_resp)'))}</h2><div class="legend" id="lg2"></div><div class="chart"><canvas id="c2"></canvas></div>
    <p class="note">${esc(t('Dotted line: baseline p95 at low load ({ms} ms).', { ms: MS(a.baseline && a.baseline.p95) }))} ${test.criteria && test.criteria.p95Max ? esc(t('Dashed red: acceptance limit ({ms} ms).', { ms: test.criteria.p95Max })) : ''}</p></section>
  <section><h2>${esc(t('Latency vs. load'))}</h2><div class="legend" id="lg3"></div><div class="chart"><canvas id="c3"></canvas></div>
    <p class="note">${esc(t('Each dot is one second: accepted TPS on the x axis, p95 latency on the y axis. Where the curve bends is the load at which the platform starts adding latency'))}${a.onset ? ` (~${N(a.onset.tps)} TPS)` : ''}.</p></section>`;

  if (a.steps) html += `<section><h2>${esc(t('Steps'))}</h2><table><thead><tr><th>#</th><th class="n">${esc(t('Target TPS'))}</th><th class="n">${esc(t('Accepted TPS'))}</th><th class="n">p50 ms</th><th class="n">p95 ms</th><th class="n">p99 ms</th>${ve ? `<th class="n">${esc(t('End-to-end p95'))}</th>` : ''}<th class="n">Throttle</th><th class="n">${esc(t('Errors'))}</th><th>${esc(t('Status'))}</th></tr></thead><tbody>
    ${a.steps.map(s => `<tr class="st-${s.status}"><td>${s.step}</td><td class="n">${N(s.target)}</td><td class="n">${N(s.ok)}</td><td class="n">${MS(s.p50)}</td><td class="n">${MS(s.p95)}</td><td class="n">${MS(s.p99)}</td>${ve ? `<td class="n">${MS(s.e2e)}</td>` : ''}<td class="n">${N(s.thr)}</td><td class="n">${N(s.err)}</td>
      <td class="${s.status === 'ok' ? 'ok' : s.status === 'saturated' ? 'err' : 'warn'}">${esc(t(STEP_STATUS[s.status] || s.status))}</td></tr>`).join('')}</tbody></table>
    <p class="note">${esc(t('The first seconds of each step are excluded as settling time. A step counts as saturated when accepted TPS is below 95% of its target.'))}</p></section>`;

  const errRows = Object.entries(T.errs || {}).sort((x, y) => y[1] - x[1]);
  const dlrRows = Object.entries(T.dlrStats || {}).sort((x, y) => y[1] - x[1]);
  const D = T.dlrLat || {};
  const allEv = ev.map(e => ({ ...e, txt: evText(e) }))
    .concat(a.onset ? [{ t: a.onset.t, type: 'onset', txt: t('Latency started rising (p95 {ms} ms)', { ms: MS(a.onset.p95) }) }] : [], a.saturation ? [{ t: a.saturation.t, type: 'sat', txt: t('Accepted TPS fell below the target') }] : [])
    .map((e, i) => ({ ...e, i })).sort((x, y) => x.t - y.t || x.i - y.i).slice(0, 300);
  html += `<div class="grid2">
    <section><h2>${esc(t('Counters'))}</h2><table class="kv"><tbody>
      <tr><td>${esc(t('submit_sm sent'))}</td><td class="n">${N(T.sent)}</td></tr>
      <tr><td>${esc(t('Accepted (ESME_ROK)'))}</td><td class="n">${N(T.ok)}</td></tr>
      <tr><td>${esc(t('Throttle / retried'))}</td><td class="n">${N(T.throttled)} / ${N(T.retries)}</td></tr>
      <tr><td>${esc(t('Timeouts'))}</td><td class="n">${N(T.timeouts)}</td></tr>
      ${errRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n err">${N(v)}</td></tr>`).join('')}
      <tr><td>${esc(t('DLR (total)'))}</td><td class="n">${N(T.dlr)}</td></tr>
      ${dlrRows.map(([k, v]) => `<tr><td>&nbsp;&nbsp;${esc(k)}</td><td class="n ${k === 'DELIVRD' ? 'ok' : 'err'}">${N(v)}</td></tr>`).join('')}
      <tr><td>${esc(t('DLR latency p50 / p95'))}</td><td class="n">${MS(D.p50)} / ${MS(D.p95)} ms</td></tr>
      ${T.dlrUnmatched ? `<tr><td>${esc(t('Unmatched DLRs'))}</td><td class="n warn">${N(T.dlrUnmatched)}</td></tr>` : ''}
      ${ve ? `<tr><td>${esc(t('Reached vendor'))}</td><td class="n">${N(ve.n)}</td></tr><tr><td>${esc(t('End-to-end p50 / p95 / p99'))}</td><td class="n">${MS(ve.total && ve.total.p50)} / ${MS(ve.total && ve.total.p95)} / ${MS(ve.total && ve.total.p99)} ms</td></tr>` : ''}
    </tbody></table></section>
    <section><h2>${esc(t('Events'))}</h2><table><tbody>
      ${allEv.map(e => `<tr><td class="mono" style="width:60px">${mmss(e.t)}</td><td class="${['session', 'error', 'timeout', 'sat'].includes(e.type) ? 'err' : ['throttle', 'onset', 'bindfail'].includes(e.type) ? 'warn' : ''}">${esc(e.txt)}</td></tr>`).join('') || `<tr><td class="muted">${esc(t('No events'))}</td></tr>`}
    </tbody></table></section>
  </div>
  <section><h2>${esc(t('Test settings'))}</h2><div class="grid2"><table class="kv"><tbody>
      <tr><td>${esc(t('Test type'))}</td><td>${esc(steps ? t('Step: {from} → {to} TPS, {n} steps × {s} s', { from: N(test.steps[0]), to: N(test.steps.at(-1)), n: test.steps.length, s: test.stepDur }) : t('Constant: {tps} TPS, {amount}', { tps: N(test.tps), amount: test.total ? t('{n} messages', { n: N(test.total) }) : N(test.duration) + ' s' }))}</td></tr>
      <tr><td>${esc(t('Sessions × window'))}</td><td>${test.sessions} × ${test.window}</td></tr>
      <tr><td>Ramp-up</td><td>${test.ramp || 0} s</td></tr>
      <tr><td>${esc(t('Response limit / DLR wait'))}</td><td>${test.respTimeout} s / ${test.dlrWait} s</td></tr>
      <tr><td>${esc(t('Retry on throttle'))}</td><td>${yn(test.retryThrottle)}</td></tr>
    </tbody></table><table class="kv"><tbody>
      <tr><td>${esc(t('Server'))}</td><td>${esc(rep.cfg && rep.cfg.host)}:${esc(rep.cfg && rep.cfg.port)}${rep.cfg && rep.cfg.tls ? ' (TLS)' : ''}</td></tr>
      <tr><td>${esc(t('Sender → recipient'))}</td><td>${esc(test.src)} → ${esc(test.dst)}</td></tr>
      <tr><td>${esc(t('Message / encoding'))}</td><td>${esc(test.text)} · ${esc(test.encoding || 'auto')}</td></tr>
      <tr><td>${esc(t('DLR / end-to-end'))}</td><td>${yn(test.dlr)} / ${yn(test.e2e)}</td></tr>
      ${rep.vendor ? `<tr><td>Vendor</td><td>port ${esc(rep.vendor.opts.port)} · DLR ${esc(rep.vendor.opts.dlrDelay)} ms · ${esc(t('failures'))} ${Math.round((rep.vendor.opts.failRate || 0) * 100)}%${rep.vendor.opts.maxTps ? ' · ' + esc(t('limit')) + ' ' + N(rep.vendor.opts.maxTps) : ''}${rep.vendor.opts.capacity ? ' · ' + esc(t('capacity')) + ' ' + N(rep.vendor.opts.capacity) : ''}</td></tr>` : ''}
    </tbody></table></div>
    <p class="note">${esc(t('Latency onset: p95 exceeding 2× the low-load baseline (at least +20 ms){crit} for 3 consecutive seconds. Saturation: accepted TPS staying below 90% of the target for 3 seconds.', { crit: test.criteria && test.criteria.p95Max ? t(' or the acceptance limit') : '' }))}</p>
  </section>`;
  $('report').innerHTML = html;
  }
  render();

  // ---------- Charts ----------
  function chart(cv, o) {
    const dpr = Math.max(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const Lm = 56, R = 14, Tm = 14, B = 26, w = W - Lm - R, h = H - Tm - B;
    const xs = o.xMin, xe = o.xMax;
    let ymax = o.yMax || 0, ymin = o.yLog ? Infinity : 0;
    for (const s of o.series) for (const v of s.y) if (v != null && !isNaN(v)) { if (v > ymax) ymax = v; if (o.yLog && v > 0 && v < ymin) ymin = v; }
    for (const p of o.points || []) { if (p.y > ymax) ymax = p.y; if (o.yLog && p.y > 0 && p.y < ymin) ymin = p.y; }
    for (const r of o.hrefs || []) if (r.y > ymax) ymax = r.y;
    if (!ymax) ymax = 1;
    let Y, ticks;
    if (o.yLog) {
      ymin = Math.pow(10, Math.floor(Math.log10(Math.max(ymin === Infinity ? 1 : ymin, 0.1)))); ymax = Math.pow(10, Math.ceil(Math.log10(ymax)));
      Y = v => Tm + h - (Math.log10(Math.max(v, ymin)) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin)) * h;
      ticks = []; for (let v = ymin; v <= ymax * 1.001; v *= 10) { ticks.push(v); if (v * 3 < ymax) ticks.push(v * 3); }
    } else {
      const raw = ymax * 1.08 / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const st = [1, 2, 2.5, 5, 10].find(m => m * mag >= raw) * mag; ymax = st * 4;
      Y = v => Tm + h - v / ymax * h; ticks = [0, st, 2 * st, 3 * st, 4 * st];
    }
    const X = v => Lm + (v - xs) / ((xe - xs) || 1) * w;
    g.font = '11px -apple-system, sans-serif'; g.lineWidth = 1;
    for (const v of ticks) {
      const yy = Math.round(Y(v)) + .5; g.strokeStyle = css('--grid'); g.beginPath(); g.moveTo(Lm, yy); g.lineTo(Lm + w, yy); g.stroke();
      g.fillStyle = css('--muted'); g.textAlign = 'right'; g.fillText(o.yFmt(v), Lm - 7, yy + 3.5);
    }
    g.textAlign = 'center';
    const xt = o.xTicks || 8;
    for (let i = 0; i <= xt; i++) { const v = xs + (xe - xs) * i / xt; g.fillText(o.xFmt(v), X(v), H - 7); }
    for (const m of o.vbands || []) { g.strokeStyle = css('--grid'); g.lineWidth = 1; g.beginPath(); g.moveTo(X(m.x), Tm); g.lineTo(X(m.x), Tm + h); g.stroke(); if (m.label) { g.fillStyle = css('--muted'); g.font = '10px -apple-system, sans-serif'; g.textAlign = 'left'; g.fillText(m.label, X(m.x) + 3, Tm + 9); } }
    for (const r of o.hrefs || []) { g.strokeStyle = css(r.color); g.setLineDash(r.dash || [4, 4]); g.lineWidth = 1.25; g.beginPath(); g.moveTo(Lm, Y(r.y)); g.lineTo(Lm + w, Y(r.y)); g.stroke(); g.setLineDash([]); }
    for (const p of o.points || []) { g.fillStyle = css(p.color); g.globalAlpha = p.alpha ?? 0.35; g.beginPath(); g.arc(X(p.x), Y(p.y), 2.2, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
    g.lineJoin = 'round';
    for (const s of o.series) {
      if (!s.y.some(v => v != null && v > 0)) continue;
      g.strokeStyle = css(s.color); g.lineWidth = s.width || 2; g.setLineDash(s.dash || []); g.beginPath(); let on = false;
      s.y.forEach((v, i) => { if (v == null || isNaN(v)) { on = false; return; } const x = X(s.x ? s.x[i] : o.x[i]), y = Y(o.yLog ? Math.max(v, ymin) : v); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; });
      g.stroke(); g.setLineDash([]);
    }
    for (const m of o.vmarks || []) {
      const x = X(m.x); g.strokeStyle = css(m.color); g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(x, Tm); g.lineTo(x, Tm + h); g.stroke(); g.setLineDash([]);
      if (m.label) { g.font = '600 11px -apple-system, sans-serif'; g.fillStyle = css(m.color); const tw = g.measureText(m.label).width; const right = x + 6 + tw > Lm + w; g.textAlign = right ? 'right' : 'left'; g.fillText(m.label, right ? x - 6 : x + 6, Tm + 22 + (m.row || 0) * 14); }
    }
  }
  const legend = (el, items) => { el.innerHTML = items.map(i => `<span><i class="${i.dash ? 'dash' : ''}" style="background:${css(i.color)};color:${css(i.color)}"></i>${i.label}</span>`).join(''); };

  const rows = S.filter(r => r && r.t != null);
  const tx = rows.map(r => r.t), tMax = Math.max(1, ...tx);
  const stepMarks = []; if (steps) { let prev = null; for (const r of rows) if (r.step && r.step !== prev) { stepMarks.push({ x: r.t, label: N(test.steps[r.step - 1]) }); prev = r.step; } }
  const tf = v => mmss(v);

  function drawAll() {
    if (!rows.length) return;
    const marks = [];
    if (a.onset) marks.push({ x: a.onset.t, color: '--warn', label: t('Latency onset · ~{tps} TPS', { tps: N(a.onset.tps) }), row: 0 });
    if (a.saturation) marks.push({ x: a.saturation.t, color: '--err', label: t('Saturation · {tps} TPS', { tps: N(a.saturation.ok) }), row: 1 });
    for (const e of ev.filter(e => e.type === 'session').slice(0, 10)) marks.push({ x: e.t, color: '--err' });
    const s1 = [
      { y: rows.map(r => r.target), color: '--muted', width: 1.5, dash: [5, 4], label: t('Target') },
      { y: rows.map(r => r.sentTps), color: '--accent', width: 1.5, label: t('Sent') },
      { y: rows.map(r => r.okTps), color: '--ok', width: 2.25, label: t('Accepted') },
      { y: rows.map(r => r.thrTps), color: '--warn', width: 1.5, label: 'Throttle' },
      { y: rows.map(r => r.errTps), color: '--err', width: 1.5, label: t('Errors') },
    ];
    chart($('c1'), { x: tx, xMin: 0, xMax: tMax, series: s1, vmarks: marks, vbands: stepMarks, yFmt: v => v >= 1000 ? (v / 1000).toLocaleString(I18N.locale) + 'k' : String(Math.round(v)), xFmt: tf });
    legend($('lg1'), s1.filter(s => s.y.some(v => v > 0)));

    const lat = Math.max(...rows.map(r => r.p99 || 0)), base = a.baseline && a.baseline.p95 || 1;
    const yLog = lat / base > 30;
    const s2 = [
      { y: rows.map(r => r.p50), color: '--ok', width: 1.75, label: 'p50' },
      { y: rows.map(r => r.p95), color: '--warn', width: 2.25, label: 'p95' },
      { y: rows.map(r => r.p99), color: '--err', width: 1.5, label: 'p99' },
      { y: rows.map(r => r.e2eP95), color: '--violet', width: 1.75, label: t('End-to-end p95') },
    ];
    const hrefs = [];
    if (a.baseline && a.baseline.p95) hrefs.push({ y: a.baseline.p95, color: '--muted', dash: [2, 3] });
    if (test.criteria && test.criteria.p95Max) hrefs.push({ y: test.criteria.p95Max, color: '--err', dash: [6, 4] });
    chart($('c2'), { x: tx, xMin: 0, xMax: tMax, series: s2, hrefs, vmarks: marks.filter(m => m.label), vbands: stepMarks, yLog, yFmt: v => MS(v), xFmt: tf });
    legend($('lg2'), s2.filter(s => s.y.some(v => v > 0)).concat(yLog ? [{ label: t('log scale'), color: '--muted', dash: true }] : []));

    const pts = rows.filter(r => r.p95 != null && r.okTps > 0);
    const xMax3 = Math.max(1, ...pts.map(r => r.okTps));
    const lim = a.onset ? a.onset.limit : null;
    const c3 = {
      x: a.curve.map(c => c.tps), xMin: 0, xMax: xMax3 * 1.05, xTicks: 6,
      points: pts.map(r => ({ x: r.okTps, y: r.p95, color: lim && r.p95 > lim ? '--err' : '--accent', alpha: 0.35 })),
      series: [
        { y: a.curve.map(c => c.p95), color: '--warn', width: 2.25, label: t('p95 (median)') },
        { y: a.curve.map(c => c.p99), color: '--err', width: 1.5, label: t('p99 (median)') },
        { y: a.curve.map(c => c.e2e), color: '--violet', width: 1.75, label: t('End-to-end p95') },
      ],
      vmarks: a.onset ? [{ x: a.onset.tps, color: '--warn', label: t('Latency onset · ~{tps} TPS', { tps: N(a.onset.tps) }) }] : [],
      hrefs: a.baseline && a.baseline.p95 ? [{ y: a.baseline.p95, color: '--muted', dash: [2, 3] }] : [],
      yLog, yFmt: v => MS(v), xFmt: v => v >= 1000 ? (v / 1000).toLocaleString(I18N.locale, { maximumFractionDigits: 1 }) + 'k' : String(Math.round(v)),
    };
    chart($('c3'), c3);
    legend($('lg3'), [{ label: t('p95 per second'), color: '--accent' }].concat(c3.series.filter(s => s.y.some(v => v > 0))));
  }
  drawAll();
  window.addEventListener('resize', drawAll);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);

  // ---------- Export ----------
  const fname = ext => `smpp-report-${(rep.name || rep.id).replace(/[^\w.-]+/g, '_')}.${ext}`;
  const download = (text, name, type) => {
    if (api.saveFile && !api.web) return api.saveFile(text, name);
    const el = document.createElement('a'); el.href = URL.createObjectURL(new Blob([text], { type })); el.download = name; document.body.appendChild(el); el.click(); el.remove();
  };
  $('bJson').onclick = () => download(JSON.stringify(rep, null, 1), fname('json'), 'application/json');
  $('bCsv').onclick = () => {
    const tr = I18N.lang === 'tr', sep = tr ? ';' : ',', dec = tr ? ',' : '.';
    const cols = ['t', 'step', 'target', 'sentTps', 'okTps', 'errTps', 'thrTps', 'toTps', 'dlrTps', 'inflight', 'windowFull', 'bound', 'p50', 'p95', 'p99', 'max', 'dlrP50', 'dlrP95', 'e2eN', 'e2eP50', 'e2eP95', 'e2eP99'];
    const head = ['second', 'step', 'target_tps', 'sent_tps', 'accepted_tps', 'error_tps', 'throttle_tps', 'timeout_tps', 'dlr_tps', 'inflight', 'window_full_ratio', 'bound_sessions', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'dlr_p50_ms', 'dlr_p95_ms', 'e2e_total', 'e2e_p50_ms', 'e2e_p95_ms', 'e2e_p99_ms'];
    const f = v => v == null || isNaN(v) ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(2)).replace('.', dec);
    const clean = s => String(s).replace(new RegExp(sep, 'g'), ' ');
    const lvl = { ok: 'OK', warn: t('WARNING'), bad: t('ISSUE') };
    const lines = [`# ${clean(title)}${sep}${dt(rep.createdAt)}`, ...a.findings.map(x => `# ${lvl[x.level]}${sep}${clean(x.text)}`), '', head.join(sep), ...rows.map(r => cols.map(c => f(r[c])).join(sep))];
    download('\ufeff' + lines.join('\n'), fname('csv'), 'text/csv;charset=utf-8');
  };
  $('bPdf').onclick = async () => {
    document.documentElement.classList.add('print'); drawAll();
    try { if (api.reportPdf) await api.reportPdf(fname('pdf')); else { await new Promise(r => setTimeout(r, 50)); window.print(); } }
    finally { document.documentElement.classList.remove('print'); drawAll(); }
  };
  window.addEventListener('beforeprint', () => { document.documentElement.classList.add('print'); drawAll(); });
  window.addEventListener('afterprint', () => { document.documentElement.classList.remove('print'); drawAll(); });
  I18N.onChange(() => { render(); drawAll(); });
})();

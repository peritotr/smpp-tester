// Report page for a routing test (several clients → the platform → several vendors). Called from report.js.
window.RoutingReport = function (rep, h) {
  const { $, t, esc, css, N, MS, mmss, dt } = h;
  const V = rep.vendors || [], C = rep.clients || [], M = rep.matrix || [], T = rep.totals || {}, X = rep.dlrCross || [];
  const cName = tag => (C.find(c => c.tag === tag) || {}).name || (tag ? t('Client {n}', { n: tag }) : t('unknown client'));
  const COLORS = ['--accent', '--ok', '--violet', '--warn'];
  const title = () => rep.name || t('Routing test');

  function findings() {
    const F = [];
    if (T.misroute) F.push(['bad', t('{n} messages reached a vendor that should not get their prefix (misrouted).', { n: N(T.misroute) })]);
    else F.push(['ok', t('Every message reached the vendor its prefix is routed to.')]);
    if (T.lost) F.push(['bad', t('{n} accepted messages never reached a vendor.', { n: N(T.lost) })]);
    else F.push(['ok', t('Every accepted message reached a vendor.')]);
    if (T.dup) F.push(['bad', t('{n} messages reached a vendor more than once.', { n: N(T.dup) })]);
    if (T.wrongDlr) F.push(['bad', t('{n} DLRs went to a different client than the one that sent the message.', { n: N(T.wrongDlr) })]);
    else if (rep.test && rep.test.dlr) F.push(['ok', t('Every DLR that came back went to the client that sent the message.')]);
    if (T.unknown) F.push(['warn', t('{n} messages reached a vendor without the test marker (the platform may have changed the text).', { n: N(T.unknown) })]);
    for (const c of C) {
      const ct = c.totals || {};
      if (c.error) F.push(['bad', `${c.name}: ${c.error}`]);
      if (ct.throttled) F.push(['warn', t('{name}: {n} throttle responses.', { name: c.name, n: N(ct.throttled) })]);
      if (ct.timeouts) F.push(['bad', t('{name}: {n} submit_sm without a response.', { name: c.name, n: N(ct.timeouts) })]);
      if (ct.windowAdvice) F.push(['warn', t('{name}: sending was held back by the window; use ≈ {need} per session.', { name: c.name, need: ct.windowAdvice.need })]);
      const errs = Object.entries(ct.errs || {}).filter(([k]) => k !== 'TIMEOUT');
      if (errs.length) F.push(['bad', `${c.name}: ` + t('Error responses: {list}.', { list: errs.map(([k, v]) => `${k} × ${N(v)}`).join(', ') })]);
    }
    return F;
  }

  function render() {
    document.title = `${title()} — ${dt(rep.createdAt)}`;
    const ok = rep.verdict === 'pass';
    const steady = C.reduce((a, c) => a + ((c.totals && (c.totals.steadyTps ?? c.totals.avgTps)) || 0), 0);
    const kpis = [
      [t('Accepted'), N(T.accepted), t('of {n} sent', { n: N(T.sent) })],
      [t('Reached vendors'), N(T.received), t('messages')],
      [t('Misrouted'), N(T.misroute), t('messages')],
      [t('Lost / duplicate'), `${N(T.lost)} / ${N(T.dup)}`, t('messages')],
      [t('DLR to wrong client'), rep.test && rep.test.dlr ? N(T.wrongDlr) : '—', 'DLR'],
      [t('Total rate'), N(steady), t('TPS · after ramp-up')],
    ];
    const lead = ok
      ? t('All {c} clients and {v} vendors: every message reached the vendor its prefix is routed to, once, and every DLR went back to the right client.', { c: C.length, v: V.length })
      : t('The routing test found issues: see the findings and the table below.');
    let html = `<section><div class="head"><div><h1>${esc(title())}</h1>
        <div class="meta">${dt(rep.startedAt || rep.createdAt)} · ${N(rep.test && rep.test.duration)} s · ${esc(t('{c} clients → {v} vendors', { c: C.length, v: V.length }))}</div></div>
        <div class="verdict ${ok ? 'pass' : 'fail'}">${esc(ok ? t('PASSED') : t('FAILED'))}</div></div>
      <p class="lead">${esc(lead)}</p>
      <div class="kpis">${kpis.map(k => `<div class="kpi"><span>${esc(k[0])}</span><b>${k[1]}</b><i>${esc(k[2])}</i></div>`).join('')}</div></section>
    <section><h2>${esc(t('Findings'))}</h2><ul class="findings">${findings().map(([l, s]) => `<li><span class="dot ${l}"></span><span>${esc(s)}</span></li>`).join('')}</ul></section>`;

    // Matrix
    html += `<section><h2>${esc(t('Where each prefix went'))}</h2><div class="scroll"><table><thead><tr><th>${esc(t('Client'))}</th><th>${esc(t('Prefix'))}</th><th>${esc(t('Should go to'))}</th><th class="n">${esc(t('Accepted'))}</th>
      ${V.map(v => `<th class="n">${esc(v.name)}<br><span class="muted">${esc(t('messages · e2e p95'))}</span></th>`).join('')}<th class="n">${esc(t('Lost'))}</th><th class="n">${esc(t('Duplicates'))}</th></tr></thead><tbody>
      ${M.map(r => `<tr><td>${esc(cName(r.client))}</td><td class="mono">${esc(r.prefix)}</td><td>${esc(r.expected.join(', ') || '—')}</td><td class="n">${r.accepted == null ? '—' : N(r.accepted)}</td>
        ${r.cells.map((x, k) => { if (!x || !x.n) return '<td class="n muted">0</td>'; const exp = V[k].expect.includes(r.prefix) || !V[k].expect.length; return `<td class="n ${exp ? 'ok' : 'err'}"><b>${N(x.n)}</b> · ${MS(x.p95)} ms</td>`; }).join('')}
        <td class="n ${r.lost ? 'err' : ''}">${r.lost == null ? '—' : N(r.lost)}</td><td class="n ${r.dup ? 'err' : ''}">${N(r.dup)}</td></tr>`).join('')}
      </tbody></table></div><p class="note">${esc(t('Green: the vendor that should get this prefix. Red: misrouted. e2e p95 = client → platform → vendor.'))}</p></section>`;

    if (X.length) html += `<section><h2>${esc(t('DLRs at the wrong client'))}</h2><table><thead><tr><th>${esc(t('Message sent by'))}</th><th>${esc(t('DLR delivered to'))}</th><th class="n">DLR</th></tr></thead><tbody>
      ${X.map(x => `<tr><td>${esc(cName(x.from))}</td><td>${esc(cName(x.to))}</td><td class="n err">${N(x.n)}</td></tr>`).join('')}</tbody></table></section>`;

    html += `<section><h2>${esc(t('Rate per client and per vendor'))}</h2><div class="legend" id="rlg"></div><div class="chart"><canvas id="rc1"></canvas></div>
      <p class="note">${esc(t('Solid: accepted TPS per client. Dashed: messages per second at each vendor.'))}</p></section>`;

    // Clients
    html += `<section><h2>${esc(t('Clients'))}</h2><div class="scroll"><table><thead><tr><th>${esc(t('Client'))}</th><th>system_id @ ${esc(t('server'))}</th><th>${esc(t('Prefix mix'))}</th><th class="n">${esc(t('Sessions × window'))}</th>
      <th class="n">${esc(t('Target TPS'))}</th><th class="n">${esc(t('Average after ramp-up'))}</th><th class="n">p50 / p95 ms</th><th class="n">Throttle</th><th class="n">${esc(t('Errors'))}</th><th class="n">DLR</th><th class="n">${esc(t('Unmatched DLRs'))}</th></tr></thead><tbody>
      ${C.map(c => { const ct = c.totals || {}, l = ct.lat || {}; return `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.systemId || '—')} @ ${esc(c.host)}:${esc(c.port)}</td><td class="mono">${esc(c.dst)}</td>
        <td class="n">${c.sessions} × ${c.window}</td><td class="n">${N(c.tps)}</td><td class="n">${N(ct.steadyTps ?? ct.avgTps)}</td><td class="n">${MS(l.p50)} / ${MS(l.p95)}</td>
        <td class="n ${ct.throttled ? 'warn' : ''}">${N(ct.throttled)}</td><td class="n ${ct.err ? 'err' : ''}">${N(ct.err)}</td><td class="n">${N(ct.dlr)}</td><td class="n ${ct.dlrUnmatched ? 'warn' : ''}">${N(ct.dlrUnmatched)}</td></tr>`; }).join('')}
      </tbody></table></div></section>`;

    // Vendors
    html += `<section><h2>${esc(t('Vendors'))}</h2><div class="scroll"><table><thead><tr><th>Vendor</th><th>${esc(t('Port'))} · system_id</th><th>${esc(t('Should get'))}</th><th>${esc(t('Behaviour'))}</th><th class="n">${esc(t('Received'))}</th>
      <th class="n">${esc(t('End-to-end p50 / p95 / p99'))}</th><th class="n">${esc(t('Duplicates'))}</th><th class="n">${esc(t('Misrouted'))}</th></tr></thead><tbody>
      ${V.map(v => { const e = v.e2e || {}; const beh = [v.respDelay ? t('response {ms} ms', { ms: v.respDelay }) : '', t('DLR after {ms} ms', { ms: v.dlrDelay }), v.failPct ? t('{p}% failed DLRs', { p: v.failPct }) : '', v.maxTps ? t('limit {n} TPS', { n: N(v.maxTps) }) : ''].filter(Boolean).join(' · ');
        return `<tr><td>${esc(v.name)}</td><td class="mono">${v.port} · ${esc(v.systemId)}</td><td class="mono">${esc(v.expect.join(', ') || '—')}</td><td>${esc(beh)}</td><td class="n">${N(v.received)}</td>
        <td class="n">${MS(e.p50)} / ${MS(e.p95)} / ${MS(e.p99)}</td><td class="n ${v.dup ? 'err' : ''}">${N(v.dup)}</td><td class="n ${v.misroute ? 'err' : ''}">${N(v.misroute)}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${V.some(v => v.samples && v.samples.length) ? `<h3>${esc(t('Misrouted examples'))}</h3><table><thead><tr><th>${esc(t('Time'))}</th><th>Vendor</th><th>${esc(t('Recipient'))}</th><th>${esc(t('Client'))}</th></tr></thead><tbody>
        ${V.flatMap(v => (v.samples || []).slice(0, 10).map(s => `<tr><td class="mono">${new Date(s.t).toLocaleTimeString(I18N.locale)}</td><td>${esc(v.name)}</td><td class="mono">${esc(s.dst)}</td><td>${esc(cName(s.client))}</td></tr>`)).join('')}</tbody></table>` : ''}
    </section>`;

    const ev = [...(rep.events || []).map(e => ({ t: e.t, txt: e.key ? t(e.key, e.p) : e.text })),
      ...C.flatMap(c => (c.events || []).filter(e => e.type !== 'start').map(e => ({ t: e.t, txt: `${c.name}: ${e.key ? t(e.key, e.p) : e.text}` })))].sort((a, b) => a.t - b.t).slice(0, 300);
    html += `<section><h2>${esc(t('Events'))}</h2><table><tbody>${ev.map(e => `<tr><td class="mono" style="width:60px">${mmss(e.t)}</td><td>${esc(e.txt)}</td></tr>`).join('') || `<tr><td class="muted">${esc(t('No events'))}</td></tr>`}</tbody></table>
      <p class="note">${esc(t('Duration {d} s, ramp-up {r} s, DLR {dlr}, message "{text}".', { d: rep.test.duration, r: rep.test.ramp || 0, dlr: rep.test.dlr ? t('Yes') : t('No'), text: rep.test.text || '' }))}</p></section>`;
    $('report').innerHTML = html;
    draw();
  }

  // ---------- Chart: accepted TPS per client (solid), messages/s per vendor (dashed) ----------
  function draw() {
    const cv = $('rc1'); if (!cv) return;
    const series = [
      ...C.map((c, i) => ({ label: c.name, color: COLORS[i % 4], x: (c.series || []).map(r => r.t), y: (c.series || []).map(r => r.okTps) })),
      ...V.map((v, k) => ({ label: v.name, color: COLORS[k % 4], dash: [5, 4], x: (rep.vendorSeries || []).map(r => r.t), y: (rep.vendorSeries || []).map(r => r.rx[k]) })),
    ];
    const dpr = Math.max(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const Lm = 56, R = 14, Tm = 14, B = 26, w = W - Lm - R, hh = H - Tm - B;
    const xMax = Math.max(1, ...series.flatMap(s => s.x)); let yMax = Math.max(1, ...series.flatMap(s => s.y.filter(v => v != null)));
    const raw = yMax * 1.08 / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), st = [1, 2, 2.5, 5, 10].find(m => m * mag >= raw) * mag; yMax = st * 4;
    const Xp = v => Lm + v / xMax * w, Yp = v => Tm + hh - v / yMax * hh;
    g.font = '11px -apple-system, sans-serif';
    for (let i = 0; i <= 4; i++) { const v = st * i, yy = Math.round(Yp(v)) + .5; g.strokeStyle = css('--grid'); g.beginPath(); g.moveTo(Lm, yy); g.lineTo(Lm + w, yy); g.stroke(); g.fillStyle = css('--muted'); g.textAlign = 'right'; g.fillText(v >= 1000 ? (v / 1000).toLocaleString(I18N.locale) + 'k' : String(Math.round(v)), Lm - 7, yy + 3.5); }
    g.textAlign = 'center'; for (let i = 0; i <= 8; i++) { const v = xMax * i / 8; g.fillText(mmss(v), Xp(v), H - 7); }
    for (const s of series) {
      g.strokeStyle = css(s.color); g.lineWidth = s.dash ? 1.5 : 2; g.setLineDash(s.dash || []); g.beginPath();
      s.y.forEach((v, i) => { const x = Xp(s.x[i]), y = Yp(v || 0); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.setLineDash([]);
    }
    $('rlg').innerHTML = series.map(i => `<span><i class="${i.dash ? 'dash' : ''}" style="background:${css(i.color)};color:${css(i.color)}"></i>${esc(i.label)}</span>`).join('');
  }

  // ---------- Export ----------
  const fname = ext => `smpp-routing-${(rep.name || rep.id).replace(/[^\w.-]+/g, '_')}.${ext}`;
  const download = (text, name, type) => {
    if (api.saveFile && !api.web) return api.saveFile(text, name);
    const el = document.createElement('a'); el.href = URL.createObjectURL(new Blob([text], { type })); el.download = name; document.body.appendChild(el); el.click(); el.remove();
  };
  $('bJson').onclick = () => download(JSON.stringify(rep, null, 1), fname('json'), 'application/json');
  $('bCsv').onclick = () => {
    const tr = I18N.lang === 'tr', sep = tr ? ';' : ',', dec = tr ? ',' : '.';
    const f = v => v == null || isNaN(v) ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(2)).replace('.', dec);
    const lines = [`# ${title()}${sep}${dt(rep.createdAt)}${sep}${rep.verdict}`, '',
      ['client', 'prefix', 'expected_vendor', 'accepted', ...V.flatMap(v => [v.name + '_messages', v.name + '_e2e_p95_ms']), 'lost', 'duplicates', 'misrouted'].join(sep),
      ...M.map(r => [cName(r.client), r.prefix, r.expected.join(' '), f(r.accepted), ...r.cells.flatMap(x => [f(x ? x.n : 0), f(x ? x.p95 : null)]), f(r.lost), f(r.dup), f(r.mis)].join(sep)),
      '', ['message_sent_by', 'dlr_delivered_to', 'dlrs'].join(sep), ...X.map(x => [cName(x.from), cName(x.to), x.n].join(sep)),
      '', ['second', ...C.map(c => c.name + '_accepted_tps'), ...V.map(v => v.name + '_received_per_s')].join(sep),
      ...(rep.vendorSeries || []).map((r, i) => [r.t, ...C.map(c => f(((c.series || [])[i] || {}).okTps)), ...r.rx.map(f)].join(sep))];
    download('﻿' + lines.join('\n'), fname('csv'), 'text/csv;charset=utf-8');
  };
  $('bPdf').onclick = async () => {
    document.documentElement.classList.add('print'); draw();
    try { if (api.reportPdf) await api.reportPdf(fname('pdf')); else { await new Promise(r => setTimeout(r, 50)); window.print(); } }
    finally { document.documentElement.classList.remove('print'); draw(); }
  };
  window.addEventListener('resize', draw);
  I18N.onChange(render);
  render();
};

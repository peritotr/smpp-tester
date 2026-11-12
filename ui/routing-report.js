// Report page for a routing test (several clients → the platform → several vendors). Called from report.js.
window.RoutingReport = function (rep, h) {
  const { $, t, esc, css, N, MS, mmss, dt } = h;
  const V = rep.vendors || [], C = rep.clients || [], M = rep.matrix || [], T = rep.totals || {}, X = rep.dlrCross || [];
  const cName = tag => (C.find(c => c.tag === tag) || {}).name || (tag ? t('Client {n}', { n: tag }) : t('unknown client'));
  const COLORS = ['--accent', '--ok', '--violet', '--warn'];
  const title = () => rep.name || t('Routing test');

  function findings() {
    const F = [];
    for (const o of rep.outages || []) {
      const when = t('{name} was down from {from} to {to}', { name: o.vendor, from: mmss(o.down), to: o.up == null ? t('the end') : mmss(o.up) });
      if (o.failoverAfter == null) F.push(['bad', t('{when}: its prefixes ({p}) did not move to another vendor.', { when, p: o.prefixes.join(', ') })]);
      else F.push(['ok', t('{when}: {p} moved to {to} within {s} s ({n} messages).', { when, p: o.prefixes.join(', '), to: o.takenBy.join(', '), s: o.failoverAfter, n: N(o.deliveredElsewhere) })
        + (o.up != null ? ' ' + (o.backAfter != null ? t('Traffic came back to {name} within {s} s after it was up.', { name: o.vendor, s: o.backAfter }) : t('Traffic did not come back to {name} before the end.', { name: o.vendor })) : '')]);
    }
    if (T.misroute) F.push(['bad', t('{n} messages reached a vendor that should not get their prefix (misrouted).', { n: N(T.misroute) })]);
    else F.push(['ok', t('Every message reached the vendor its prefix is routed to.')]);
    if (T.lost) F.push(['bad', t('{n} accepted messages never reached a vendor.', { n: N(T.lost) })]);
    else F.push(['ok', t('Every accepted message reached a vendor.')]);
    if (T.dup) F.push(['bad', t('{n} messages reached a vendor more than once.', { n: N(T.dup) })]);
    if (T.wrongDlr) F.push(['bad', t('{n} DLRs went to a different client than the one that sent the message.', { n: N(T.wrongDlr) })]);
    else if (rep.test && rep.test.dlr) F.push(['ok', t('Every DLR that came back went to the client that sent the message.')]);
    if (T.marked != null) {
      const E = rep.expected || {};
      if (T.unmarked) F.push(['bad', t('{n} messages reached a vendor without the test marker.', { n: N(T.unmarked) })]);
      if (T.broken) F.push(['bad', t('{n} messages reached a vendor with a broken test marker.', { n: N(T.broken) })]);
      if (T.textChanged) F.push(['bad', t('{n} messages arrived with a different text than was sent.', { n: N(T.textChanged) })]);
      if (T.dcsChanged) F.push(['bad', t('{n} messages arrived with a different data_coding than was sent ({dcs}).', { n: N(T.dcsChanged), dcs: E.dcs ?? '—' })]);
      if (!T.unmarked && !T.broken && !T.textChanged && !T.dcsChanged)
        F.push(['ok', t('All {n} messages at the vendors carried an intact marker; text and data_coding matched what was sent ("{text}", data_coding {dcs}).', { n: N(T.marked), text: E.text ?? '', dcs: E.dcs ?? '—' })]);
    } else if (T.unknown) F.push(['warn', t('{n} messages reached a vendor without the test marker (the platform may have changed the text).', { n: N(T.unknown) })]);
    for (const c of C) {
      const ct = c.totals || {};
      if (c.error) F.push(['bad', `${c.name}: ${c.error}`]);
      if (ct.throttled) F.push(['warn', t('{name}: {n} throttle responses.', { name: c.name, n: N(ct.throttled) })]);
      if (ct.timeouts) F.push([(rep.outages || []).length ? 'warn' : 'bad', t('{name}: {n} submit_sm without a response.', { name: c.name, n: N(ct.timeouts) }) + ((rep.outages || []).length ? ' ' + t('Expected for messages that were on their way to a vendor when it was taken down.') : '')]);
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
      ${M.map(r => `<tr><td>${esc(cName(r.client))}</td><td class="mono">${esc(r.prefix)}</td><td>${esc(r.expected.join(', ') || '—')}${r.backup && r.backup.length ? ` <span class="muted">(${esc(t('backup'))}: ${esc(r.backup.join(', '))})</span>` : ''}</td><td class="n">${r.accepted == null ? '—' : N(r.accepted)}</td>
        ${r.cells.map((x, k) => { if (!x || !x.n) return '<td class="n muted">0</td>'; const exp = V[k].expect.includes(r.prefix) || !V[k].expect.length, bk = (V[k].backup || []).includes(r.prefix); return `<td class="n ${exp ? 'ok' : bk ? 'warn' : 'err'}"><b>${N(x.n)}</b> · ${MS(x.p95)} ms</td>`; }).join('')}
        <td class="n ${r.lost ? 'err' : ''}">${r.lost == null ? '—' : N(r.lost)}</td><td class="n ${r.dup ? 'err' : ''}">${N(r.dup)}</td></tr>`).join('')}
      </tbody></table></div><p class="note">${esc(t('Green: the vendor that should get this prefix. Amber: its backup vendor (failover). Red: misrouted. e2e p95 = client → platform → vendor.'))}</p></section>`;

    if (V.some(v => v.content)) {
      const E = rep.expected || {}, bad = (n) => n ? 'err' : '';
      const ex = V.flatMap(v => ((v.content && v.content.samples) || []).map(x => ({ ...x, vendor: v.name }))).slice(0, 40);
      const KIND = { unmarked: t('no marker'), broken: t('broken marker'), text: t('text changed'), dcs: t('data_coding changed') };
      html += `<section><h2>${esc(t('Content check'))}</h2>
        <p class="note">${esc(t('Every message a vendor received is checked: the test marker (#T + 20 digits) must be intact, the text before it must be exactly "{text}" and data_coding must be {dcs}, as sent.', { text: E.text ?? '', dcs: E.dcs ?? '—' }))}</p>
        <div class="scroll"><table><thead><tr><th>Vendor</th><th class="n">${esc(t('Received'))}</th><th class="n">${esc(t('Marker intact'))}</th><th class="n">${esc(t('No marker'))}</th><th class="n">${esc(t('Broken marker'))}</th>
        <th class="n">${esc(t('Text changed'))}</th><th class="n">${esc(t('data_coding changed'))}</th><th class="n">${esc(t('Evidence CSV'))}</th></tr></thead><tbody>
        ${V.map((v, k) => { const c = v.content || {}, all = (c.marked || 0) + (c.unmarked || 0) + (c.broken || 0); return `<tr><td>${esc(v.name)}</td><td class="n">${N(all)}</td><td class="n ok">${N(c.marked)}</td>
          <td class="n ${bad(c.unmarked)}">${N(c.unmarked)}</td><td class="n ${bad(c.broken)}">${N(c.broken)}</td><td class="n ${bad(c.textChanged)}">${N(c.textChanged)}</td><td class="n ${bad(c.dcsChanged)}">${N(c.dcsChanged)}</td>
          <td class="n">${v.evidence ? `<button class="evd no-print" data-k="${k}">${esc(t('Download'))}</button> <span class="muted">${esc(t('{n} rows', { n: N(v.evidence.rows) }))}</span>` : '—'}</td></tr>`; }).join('')}
        </tbody></table></div>
        <p class="note">${esc(t('Evidence CSV: one row per message the vendor received — vendor message_id, recipient, sender, marker, submit and receive time (UTC), end-to-end ms, data_coding and the result of each check. Compare it with your platform records by vendor message_id or recipient and time.'))}</p>
        ${ex.length ? `<h3>${esc(t('Examples'))}</h3><div class="scroll"><table><thead><tr><th>${esc(t('Time'))}</th><th>Vendor</th><th>${esc(t('Client'))}</th><th>${esc(t('Recipient'))}</th><th>${esc(t('Problem'))}</th><th>data_coding</th><th>${esc(t('Text received'))}</th></tr></thead><tbody>
          ${ex.map(x => `<tr><td class="mono">${new Date(x.t).toLocaleTimeString(I18N.locale)}</td><td>${esc(x.vendor)}</td><td>${esc(cName(x.client))}</td><td class="mono">${esc(x.dst)}</td><td class="err">${esc(KIND[x.kind] || x.kind)}</td>
            <td class="mono">${x.dcs}${x.expectDcs != null && x.dcs !== x.expectDcs ? ' (' + esc(t('sent {n}', { n: x.expectDcs })) + ')' : ''}</td><td class="mono">${esc(x.text)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </section>`;
    }

    if ((rep.outages || []).length) html += `<section><h2>${esc(t('Failover'))}</h2><div class="scroll"><table><thead><tr><th>Vendor</th><th>${esc(t('Prefixes'))}</th><th>${esc(t('Down'))}</th><th>${esc(t('Up again'))}</th>
      <th class="n">${esc(t('Moved after'))}</th><th>${esc(t('Moved to'))}</th><th class="n">${esc(t('Messages there'))}</th><th class="n">${esc(t('Back after'))}</th></tr></thead><tbody>
      ${rep.outages.map(o => `<tr><td>${esc(o.vendor)}</td><td class="mono">${esc(o.prefixes.join(', '))}</td><td class="mono">${mmss(o.down)}</td><td class="mono">${o.up == null ? '—' : mmss(o.up)}</td>
        <td class="n ${o.failoverAfter == null ? 'err' : ''}">${o.failoverAfter == null ? esc(t('did not move')) : '≤ ' + o.failoverAfter + ' s'}</td><td>${esc(o.takenBy.join(', ') || '—')}</td><td class="n">${N(o.deliveredElsewhere)}</td>
        <td class="n">${o.up == null ? '—' : o.backAfter == null ? esc(t('did not come back')) : '≤ ' + o.backAfter + ' s'}</td></tr>`).join('')}</tbody></table></div>
      <p class="note">${esc(t('Times are per second: when another vendor first got the down vendor\'s prefixes, and when they first reached it again after it was up. Lost messages during the outage are in the table above.'))}</p></section>`;

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
        return `<tr><td>${esc(v.name)}</td><td class="mono">${v.port} · ${esc(v.systemId)}</td><td class="mono">${esc(v.expect.join(', ') || '—')}${v.backup && v.backup.length ? `<br><span class="muted">${esc(t('backup'))}: ${esc(v.backup.join(', '))}</span>` : ''}</td><td>${esc(beh)}</td><td class="n">${N(v.received)}</td>
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
    document.querySelectorAll('button.evd').forEach(b => b.onclick = () => {
      const ev = V[Number(b.dataset.k)].evidence; if (!ev) return;
      if (api.evidenceSave && !api.web) return api.evidenceSave(ev.file);
      const a = document.createElement('a'); a.href = '/evidence?file=' + encodeURIComponent(ev.file); a.download = ev.file.replace(/\.gz$/, ''); document.body.appendChild(a); a.click(); a.remove();
    });
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
    for (const o of rep.outages || []) {
      const x1 = Xp(o.down), x2 = Xp(o.up ?? xMax);
      g.fillStyle = css('--err'); g.globalAlpha = 0.08; g.fillRect(x1, Tm, Math.max(1, x2 - x1), hh); g.globalAlpha = 1;
      g.fillStyle = css('--err'); g.font = '600 10.5px -apple-system, sans-serif'; g.textAlign = 'left'; g.fillText(t('{name} down', { name: o.vendor }), x1 + 4, Tm + 11);
    }
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

// Report section for per-message records (records.js): counts, downloads, duplicate-DLR examples.
// Used by the load test report and by the routing test report (one block per client).
window.RecordsUI = (() => {

  function findings(R, name, t, N) {
    if (!R || R.error) return [];
    const who = name ? name + ': ' : '', F = [];
    if (R.duplicateIds) F.push(['bad', who + t('{n} messages got more than one DLR ({extra} extra DLRs). The list is in the per-message records (Duplicate DLRs).', { n: N(R.duplicateIds), extra: N(R.extraDlrs) })]);
    if (R.missing) F.push(['warn', who + t('{n} accepted messages got no DLR.', { n: N(R.missing) })]);
    if (R.unmatched) F.push(['warn', who + t('{n} DLRs match no message this client sent.', { n: N(R.unmatched) })]);
    if (!R.duplicateIds && !R.missing && !R.unmatched) F.push(['ok', who + t('Every accepted message got exactly one DLR ({n} DLRs).', { n: N(R.dlrs) })]);
    return F;
  }

  // R: totals.records; title: section heading; esc/t/N/MS from the report
  function section(R, title, h) {
    const { esc, t, N } = h;
    if (!R) return '';
    if (R.error) return `<section><h2>${esc(title)}</h2><p class="err">${esc(t('The records could not be summarised: {msg}', { msg: R.error }))}</p></section>`;
    const rows = [
      [t('Submits sent'), N(R.submits)], [t('Accepted (submit_sm_resp OK)'), N(R.accepted)], [t('DLRs received'), N(R.dlrs)], [t('Distinct receipted_message_id'), N(R.uniqueDlrs)],
      [t('Messages with more than one DLR'), N(R.duplicateIds), R.duplicateIds ? 'err' : ''], [t('Extra DLRs'), N(R.extraDlrs), R.extraDlrs ? 'err' : ''],
      [t('Accepted without a DLR'), N(R.missing), R.missing ? 'warn' : ''], [t('DLRs matching no submit'), N(R.unmatched), R.unmatched ? 'warn' : ''],
    ];
    const ex = R.examples || [];
    const KINDS = [['submits', t('Submits')], ['dlrs', t('DLRs received')], ['duplicates', t('Duplicate DLRs')], ['missing', t('Submits without a DLR')], ['unmatched', t('DLRs matching no submit')]];
    return `<section><h2>${esc(title)}</h2>
      <div class="grid2"><table class="kv"><tbody>${rows.map(r => `<tr><td>${esc(r[0])}</td><td class="n ${r[2] || ''}">${r[1]}</td></tr>`).join('')}</tbody></table>
      <div><p class="note">${esc(t('Every submit (with the message_id from submit_sm_resp) and every DLR this client received, one row each, with UTC times in ms, session, ids, stat, err, dates and addresses. Test id: {run}', { run: R.run }))}</p>
      <div class="rec-dl no-print">${KINDS.map(([k, l]) => `<button data-run="${esc(R.run)}" data-kind="${k}">${esc(l)} ↓</button>`).join(' ')}</div></div></div>
      ${ex.length ? `<h3>${esc(t('Messages with more than one DLR (first {n})', { n: ex.length }))}</h3><div class="scroll"><table><thead><tr><th>receipted_message_id</th><th class="n">DLR</th><th>${esc(t('Arrivals (UTC)'))}</th><th>stat</th><th>${esc(t('Session'))}</th><th>${esc(t('Submitted (UTC)'))}</th><th>${esc(t('Recipient'))}</th></tr></thead><tbody>
        ${ex.map(x => `<tr><td class="mono">${esc(x.id)}</td><td class="n err">${x.n}</td><td class="mono">${x.at.map(esc).join('<br>')}</td><td class="mono">${x.stat.map(esc).join('<br>')}</td><td class="mono">${x.sess.map(esc).join('<br>')}</td><td class="mono">${esc(x.sent || '—')}</td><td class="mono">${esc(x.dst || '—')}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    </section>`;
  }

  // Download buttons (call after the HTML is in the page)
  function wire() {
    document.querySelectorAll('.rec-dl button').forEach(b => b.onclick = () => {
      const run = b.dataset.run, kind = b.dataset.kind;
      if (api.recordsSave && !api.web) return api.recordsSave(run, kind);
      const a = document.createElement('a'); a.href = `/records?run=${encodeURIComponent(run)}&kind=${kind}`; a.download = `${run}-${kind}.csv`; document.body.appendChild(a); a.click(); a.remove();
    });
  }
  return { section, findings, wire };
})();

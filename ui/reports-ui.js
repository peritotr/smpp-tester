// Reports list
(() => {
  const fmtN = n => n == null ? '—' : Math.round(n).toLocaleString(I18N.locale);
  const fmtD = ts => { const d = new Date(ts); return d.toLocaleDateString(I18N.locale) + ' ' + d.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' }); };
  // 'kademeli' / 'sabit' are kept for reports saved by older versions
  const modeName = m => (m === 'step' || m === 'kademeli') ? t('Step') : t('Constant');
  async function refresh() {
    let list = [];
    try { list = await api.reportsList() || []; } catch {}
    $('cReports').textContent = list.length;
    const body = $('rBody');
    if (!list.length) { body.innerHTML = `<tr><td colspan="10" class="muted">${esc(t('No reports yet. They appear here when a load test finishes.'))}</td></tr>`; return; }
    body.innerHTML = list.map(r => `<tr data-id="${esc(r.id)}">
      <td>${fmtD(r.createdAt)}</td><td class="txt" title="${esc(r.name)}">${esc(r.name || '—')}</td><td>${esc(modeName(r.mode))}</td>
      <td>${fmtN(r.target)}</td><td>${fmtN(r.capacity)}</td>
      <td>${r.kneeTps ? fmtN(r.kneeTps) + ' (' + esc(t('step')) + ')' : r.onsetTps ? '~' + fmtN(r.onsetTps) : `<span class="ok">${esc(t('none'))}</span>`}</td>
      <td>${r.p95 == null ? '—' : (r.p95 < 10 ? r.p95.toFixed(1) : Math.round(r.p95)) + ' ms'}</td>
      <td><span class="badge ${r.verdict || 'none'}">${r.verdict === 'pass' ? esc(t('Passed')) : r.verdict === 'fail' ? esc(t('Failed')) : '—'}</span></td>
      <td class="${r.issues ? 'warn' : 'ok'}">${r.issues || 0}</td>
      <td class="act"><button class="ghost" data-act="rename">${esc(t('Rename'))}</button> <button class="ghost" data-act="del">${esc(t('Delete'))}</button></td></tr>`).join('');
  }
  window.refreshReports = refresh;
  $('rRefresh').onclick = refresh;
  $('rBody').onclick = async e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const id = tr.dataset.id, act = e.target.dataset && e.target.dataset.act;
    if (act === 'del') { if (confirm(t('Delete this report?'))) { await api.reportDelete(id); refresh(); } return; }
    if (act === 'rename') {
      const cur = tr.children[1].title || '';
      const td = tr.children[1]; td.innerHTML = `<input value="${esc(cur)}" style="min-width:160px">`;
      const inp = td.querySelector('input'); inp.focus(); inp.select();
      const done = async ok => { if (ok) await api.reportRename(id, inp.value.trim()); refresh(); };
      inp.onkeydown = ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
      inp.onblur = () => done(true); inp.onclick = ev => ev.stopPropagation();
      return;
    }
    api.reportOpen(id);
  };
  document.querySelector('.modes [data-mode=reports]').addEventListener('click', refresh);
  I18N.onChange(refresh);
  refresh();
})();

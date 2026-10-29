// "Vendor messages": what reached the built-in vendor, decoded — sender, recipient, data_coding and text.
// Answers "did the message arrive, with which text and in which encoding?" (uses $, val, esc, t from renderer.js)
(() => {
  let rows = [], open = new Set(), timer = null, busy = false, last = null;
  const vis = () => $('view-vmsgs').classList.contains('on');
  const fmtT = ts => { const d = new Date(ts); return d.toLocaleTimeString(I18N.locale, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
  const fmtN = n => Number(n || 0).toLocaleString(I18N.locale);
  const key = r => r.id + '|' + r.t;
  // Control characters shown visibly so "Thank you" vs "Thank you\n" is obvious
  const show = s => esc(s).replace(/\r/g, '␍').replace(/\n/g, '␊\n').replace(/\f/g, '␌');

  async function refresh() {
    if (busy) return; busy = true;
    try {
      const d = await api.mockMsgs(val('vmQ'));
      last = d;
      if (!d) { rows = []; $('vmSum').textContent = t('The vendor is not running. Start it on the left; messages your platform sends to it appear here.'); render(); return; }
      rows = d.list;
      const enc = Object.entries(d.enc).sort((a, b) => b[1] - a[1]).map(([dcs, n]) => `${encName(Number(dcs))} ${fmtN(n)}`).join(' · ');
      $('vmSum').textContent = t('Received since the vendor started: {n} · last {kept} kept here', { n: fmtN(d.total), kept: fmtN(d.kept) })
        + (enc ? ' · ' + t('by encoding: {list}', { list: enc }) : '')
        + (val('vmQ').trim() ? ' · ' + t('{n} match', { n: fmtN(rows.length) }) : '');
      render();
    } catch { /* keep the last list */ } finally { busy = false; }
  }
  // Same names as the vendor uses (sms-decode.js), for the summary line
  function encName(dcs) {
    const S = { 0: 'GSM7', 1: 'IA5/ASCII', 2: 'Binary', 3: 'Latin-1', 4: 'Binary', 5: 'JIS', 6: 'Cyrillic', 7: 'Hebrew', 8: 'UCS2', 9: 'Pictogram', 10: 'ISO-2022-JP', 13: 'Kanji', 14: 'KS C 5601' };
    let a = 'Unknown';
    if (dcs <= 0x0f) a = S[dcs] || a;
    else if ((dcs & 0xc0) === 0) a = ['GSM7', 'Binary', 'UCS2', 'Unknown'][(dcs >> 2) & 3];
    else if ((dcs & 0xf0) === 0xf0) a = dcs & 4 ? 'Binary' : 'GSM7';
    else if ((dcs & 0xf0) === 0xc0 || (dcs & 0xf0) === 0xd0) a = 'GSM7';
    else if ((dcs & 0xf0) === 0xe0) a = 'UCS2';
    return `${a} (${dcs})`;
  }

  function render() {
    const body = $('vmBody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="muted">${esc(last ? (val('vmQ').trim() ? t('No message matches.') : t('No messages yet. Point your platform at the vendor and send one.')) : '—')}</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(r => {
      const k = key(r), o = open.has(k);
      const main = `<tr data-k="${esc(k)}">
        <td>${fmtT(r.t)}</td><td>${esc(r.sid || '—')}</td><td>${esc(r.src)}</td><td>${esc(r.dst)}</td>
        <td><span class="enc ${esc(r.enc)}">${esc(r.encLabel)}</span></td><td>${esc(r.parts || '—')}</td>
        <td class="vtext">${r.text ? show(r.text) : `<span class="muted">${esc(t('(binary, see hex)'))}</span>`}</td><td>${esc(r.id)}</td></tr>`;
      if (!o) return main;
      return main + `<tr class="vdet"><td colspan="8">
        <div class="small">${esc(t('Sender TON {s} · recipient TON {d} · data_coding {dcs} · {b} bytes{udh} · DLR requested: {reg}', {
          s: r.srcTon, d: r.dstTon, dcs: `${r.dcs} (0x${r.dcs.toString(16).padStart(2, '0')})`, b: r.bytes, udh: r.udh ? ' · UDH' : '', reg: r.reg ? t('yes') : t('no') }))}</div>
        <div class="small muted" style="margin-top:4px">${esc(t('Raw short_message (hex)'))}</div><code>${esc(r.hex.replace(/(..)/g, '$1 ').trim())}</code></td></tr>`;
    }).join('');
  }

  $('vmBody').onclick = e => {
    const tr = e.target.closest('tr[data-k]'); if (!tr) return;
    const k = tr.dataset.k; open.has(k) ? open.delete(k) : open.add(k); render();
  };
  let qt = null;
  $('vmQ').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(refresh, 250); });
  $('vmRefresh').onclick = refresh;
  $('vmClear').onclick = async () => { await api.mockMsgsClear(); open.clear(); refresh(); };
  $('vmCsv').onclick = () => {
    if (!rows.length) return;
    const sep = I18N.lang === 'tr' ? ';' : ',';
    const cell = v => { const s = String(v ?? ''); return /[";\n,\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [['time', 'account', 'sender', 'sender_ton', 'recipient', 'recipient_ton', 'data_coding', 'encoding', 'part', 'text', 'message_id', 'bytes', 'hex'].join(sep),
      ...rows.map(r => [new Date(r.t).toISOString(), r.sid, r.src, r.srcTon, r.dst, r.dstTon, r.dcs, r.encLabel, r.parts, r.text, r.id, r.bytes, r.hex].map(cell).join(sep))];
    api.saveFile('﻿' + lines.join('\n'), `vendor-messages-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`);
  };

  // Refresh every 2 s while the view is open and auto refresh is on; the tab shows the running count
  function loop() { clearInterval(timer); timer = setInterval(() => { if (vis() && val('vmAuto') && !document.hidden) refresh(); }, 2000); }
  document.querySelector('.modes [data-mode=vmsgs]').addEventListener('click', refresh);
  api.on('mock:stats', m => { if (m && m.msgTotal != null) $('cVmsgs').textContent = fmtN(m.msgTotal); });
  I18N.onChange(() => { if (vis()) refresh(); else render(); });
  loop();
  if (vis()) refresh();
})();

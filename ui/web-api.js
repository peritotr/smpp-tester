// Web version: provides the same window.api that Electron's preload exposes, over a WebSocket.
(() => {
  if (window.api) return;
  const listeners = {}, pending = new Map(), queue = [];
  let ws = null, nextId = 1, retry = 0, banner = null;

  function setBanner(text) {
    if (!banner) {
      banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:999;background:#ef5a5a;color:#fff;padding:6px 14px;border-radius:7px;font:12.5px -apple-system,sans-serif;box-shadow:0 2px 10px #0003';
      document.body.appendChild(banner);
    }
    banner.textContent = text; banner.style.display = text ? '' : 'none';
  }

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { retry = 0; setBanner(''); while (queue.length) ws.send(queue.shift()); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); } return; }
      (listeners[m.ev] || []).forEach(fn => { try { fn(m.data); } catch (err) { console.error(err); } });
    };
    ws.onclose = e => {
      for (const [, p] of pending) p.resolve({ ok: false, error: 'Lost connection to the server' });
      pending.clear();
      if (e.code === 1006 && retry > 2) {
        // The session may have expired: check whether the login page is served
        fetch('/', { redirect: 'manual' }).then(r => { if (r.type === 'opaqueredirect' || r.status === 303) location.href = '/login'; }).catch(() => {});
      }
      setBanner(typeof I18N !== 'undefined' ? I18N.t('Lost connection to the server, reconnecting…') : 'Lost connection to the server, reconnecting…');
      setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    };
  }

  function invoke(ch, ...args) {
    return new Promise((resolve, reject) => {
      const id = nextId++; pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, ch, args });
      ws && ws.readyState === 1 ? ws.send(msg) : queue.push(msg);
    });
  }

  function download(text, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: name.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return Promise.resolve(name);
  }

  window.api = {
    web: true,
    connect: cfg => invoke('smpp:connect', cfg),
    disconnect: () => invoke('smpp:disconnect'),
    enquire: () => invoke('smpp:enquire'),
    submit: m => invoke('smpp:submit', m),
    stop: () => invoke('smpp:stop'),
    analyze: (t, e) => invoke('smpp:analyze', t, e),
    loadStart: (cfg, test) => invoke('load:start', cfg, test),
    loadStop: () => invoke('load:stop'),
    loadKill: () => invoke('load:kill'),
    mockStart: o => invoke('mock:start', o),
    mockStop: () => invoke('mock:stop'),
    mockReset: () => invoke('mock:reset'),
    mockMsgs: q => invoke('mock:msgs', q),
    mockMsgsClear: () => invoke('mock:msgsClear'),
    ips: () => invoke('sys:ips'),
    mockMo: (t, f, to) => invoke('mock:mo', t, f, to),
    loadProfiles: () => invoke('profiles:load'),
    saveProfiles: l => invoke('profiles:save', l),
    saveFile: (text, name) => download(text, name),
    exportLog: t => download(t, `smpp-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`),
    reportsList: () => invoke('reports:list'),
    reportGet: id => invoke('reports:get', id),
    reportDelete: id => invoke('reports:delete', id),
    reportRename: (id, name) => invoke('reports:rename', id, name),
    reportOpen: id => { window.open('/report.html?id=' + encodeURIComponent(id), '_blank', 'noopener'); return Promise.resolve(true); },
    on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
  };
  // Connect only after every UI script has registered its listeners
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect); else connect();
})();

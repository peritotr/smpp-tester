// A tiny SMS platform for trying out the routing test without a real SMSC: accepts customer binds, routes each
// submit_sm by destination prefix to a vendor, and sends the vendor's DLRs back to the customer that sent the
// message. Faults on purpose: misrouteEvery = every Nth message goes to the wrong vendor, wrongDlrEvery = every Nth
// DLR goes to another customer, dropEvery = every Nth message is accepted but never forwarded.
//
// node tools/mini-router.js <port> <prefix>=<host:port:system_id:password> [...]
//   e.g. node tools/mini-router.js 2900 9053=127.0.0.1:2901:vendA:pw 9054=127.0.0.1:2902:vendB:pw
const smpp = require('smpp');

function miniRouter({ port, routes, misrouteEvery = 0, wrongDlrEvery = 0, dropEvery = 0, log = () => {} }) {
  const vendors = [], customers = new Set(), byVendorId = new Map();
  let seq = 0, nSub = 0, nDlr = 0, nDrop = 0, closed = false; const stats = { misrouted: 0, wrongDlr: 0, dropped: 0 };
  const ownId = () => 'R' + (++seq).toString(36).toUpperCase();

  // Vendor connections are retried until the vendor listens (it may start after the router)
  const ready = Promise.all(routes.map(r => new Promise(resolve => {
    const [host, p, sid, pw] = r.to.split(':');
    const v = { prefix: r.prefix, s: null, up: false }; vendors.push(v);
    const open = () => {
      if (closed) return;
      const s = v.s = smpp.connect({ url: `smpp://${host}:${p}`, auto_enquire_link_period: 0 });
      s.on('error', () => {});
      s.on('close', () => { v.up = false; setTimeout(open, 300); });
      s.on('connect', () => s.bind_transceiver({ system_id: sid, password: pw || '' }, pdu => { if (pdu.command_status === 0) { v.up = true; resolve(); } }));
      s.on('deliver_sm', pdu => onDlr(s, pdu));
    };
    open();
  })));
  function onDlr(s, pdu) {
    s.send(pdu.response());
    const vid = pdu.receipted_message_id || (/id:(\S+)/.exec(String(pdu.short_message && pdu.short_message.message || '')) || [])[1];
    const m = byVendorId.get(vid); if (!m) return;
    byVendorId.delete(vid);
    let to = m.customer;
    if (wrongDlrEvery && ++nDlr % wrongDlrEvery === 0) { const other = [...customers].find(c => c.sid !== m.customer.sid && c.bound); if (other) { to = other; stats.wrongDlr++; } }
    if (!to.bound) return;
    const txt = String(pdu.short_message.message).replace(/id:\S+/, 'id:' + m.own);
    to.deliver_sm({ esm_class: 4, source_addr: pdu.source_addr, destination_addr: pdu.destination_addr, short_message: txt, receipted_message_id: m.own, message_state: pdu.message_state || 2 });
  }

  const server = smpp.createServer(session => {
    session.on('error', () => {});
    session.on("bind_transceiver", pdu => { session.sid = pdu.system_id; session.bound = true; customers.add(session); session.send(pdu.response()); });
    session.on('enquire_link', pdu => session.send(pdu.response()));
    session.on('close', () => { session.bound = false; customers.delete(session); });
    session.on('deliver_sm_resp', () => {});
    session.on('submit_sm', pdu => {
      const dst = String(pdu.destination_addr).replace(/\D/g, '');
      let v = vendors.find(x => dst.startsWith(x.prefix));
      if (!v) return session.send(pdu.response({ command_status: 0x0b })); // ESME_RINVDSTADR
      if (!vendors.every(x => x.up)) return session.send(pdu.response({ command_status: 0x14 })); // vendors not connected yet: queue full
      if (dropEvery && ++nDrop % dropEvery === 0) { stats.dropped++; return session.send(pdu.response({ message_id: ownId() })); } // accepted, never forwarded
      if (misrouteEvery && ++nSub % misrouteEvery === 0) { v = vendors.find(x => x !== v) || v; stats.misrouted++; }
      const own = ownId();
      v.s.submit_sm({ source_addr: pdu.source_addr, destination_addr: pdu.destination_addr, data_coding: pdu.data_coding, short_message: pdu.short_message, registered_delivery: pdu.registered_delivery }, r => {
        if (r.command_status !== 0) return session.send(pdu.response({ command_status: r.command_status }));
        if (pdu.registered_delivery) byVendorId.set(r.message_id, { own, customer: session });
        session.send(pdu.response({ message_id: own }));
      });
    });
  });
  server.listen(port);
  return { ready, stats, close: () => { closed = true; server.close(); for (const c of customers) c.close(); for (const v of vendors) try { v.s.close(); } catch {} } };
}

if (require.main === module) {
  const [port, ...rest] = process.argv.slice(2);
  const routes = rest.map(a => { const [prefix, to] = a.split('='); return { prefix, to }; });
  const r = miniRouter({ port: Number(port), routes, misrouteEvery: Number(process.env.MISROUTE_EVERY) || 0, wrongDlrEvery: Number(process.env.WRONG_DLR_EVERY) || 0, dropEvery: Number(process.env.DROP_EVERY) || 0, log: console.log });
  r.ready.then(() => console.log(`mini router on ${port}: ${routes.map(x => x.prefix + ' → ' + x.to.split(':').slice(0, 2).join(':')).join(', ')}`), e => { console.error(e.message); process.exit(1); });
}

module.exports = { miniRouter };

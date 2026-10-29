// Acceptance check for DLR redelivery, with the vendor in its own process as in the apps.
//   node tools/dlr-redelivery-check.js [messages=10000] [awaySeconds=30]
// Scenarios:
//   normal   – no disconnect: every DLR arrives once
//   away     – the gateway's bind drops before the DLRs go out, comes back after awaySeconds: every DLR arrives once
//   restart  – same, and the vendor is restarted (SIGTERM) while the gateway is away
//   crash    – same, but the vendor is killed hard (SIGKILL)
// Each DLR must carry the submit_sm_resp message_id in receipted_message_id and in the receipt text, with no duplicates.
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const smpp = require('smpp');

const N = Number(process.argv[2] || 10000), AWAY = Number(process.argv[3] || 30) * 1000;
const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let port = 23000 + Math.floor(Math.random() * 2000);

function startVendor(opts) {
  return new Promise((resolve, reject) => {
    const p = fork(path.join(root, 'mock-worker.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    p.logs = [];
    p.on('message', m => { if (m.type === 'started') resolve(p); else if (m.type === 'error') reject(new Error(m.text)); else if (m.type === 'log') p.logs.push(m.text); else if (m.type === 'stats') p.stats = m.stats; });
    p.send({ type: 'start', opts });
  });
}
const stopVendor = (p, sig) => new Promise(r => { p.once('exit', r); p.kill(sig); });

async function gateway(bindFn = 'bind_transceiver') {
  const s = smpp.connect({ url: `smpp://127.0.0.1:${port}`, auto_enquire_link_period: 0 });
  s.on('error', () => {});
  await new Promise(r => s.once('connect', r));
  await new Promise((res, rej) => s[bindFn]({ system_id: 'gateway', password: 'x' }, p => p.command_status === 0 ? res() : rej(new Error('bind failed'))));
  s.dlrs = [];
  s.on('deliver_sm', p => { const m = p.short_message.message; s.dlrs.push({ rid: p.receipted_message_id, txt: Buffer.isBuffer(m) ? m.toString('latin1') : String(m), at: Date.now() }); s.send(p.response()); });
  return s;
}
async function submitAll(s) {
  const ids = [];
  for (let i = 0; i < N; i += 500) {  // pipelined in batches of 500
    const batch = await Promise.all(Array.from({ length: Math.min(500, N - i) }, (_, k) => new Promise(res =>
      s.submit_sm({ source_addr: 'TEST', destination_addr: '4477' + String(i + k).padStart(8, '0'), short_message: 'Hello ' + (i + k), registered_delivery: 1 }, p => res(p.command_status === 0 ? p.message_id : null)))));
    ids.push(...batch);
  }
  return ids;
}
async function collect(s, want, ms) { const end = Date.now() + ms; while (s.dlrs.length < want && Date.now() < end) await sleep(100); await sleep(1000); }
function verdict(name, ids, dlrs, extra = '') {
  const sent = new Set(ids.filter(Boolean)), got = dlrs.map(d => d.rid), uniq = new Set(got);
  const wrong = dlrs.filter(d => (/id:(\S+)/.exec(d.txt) || [])[1] !== d.rid || !sent.has(d.rid)).length;
  const missing = [...sent].filter(id => !uniq.has(id)).length;
  const ok = sent.size === N && got.length === N && uniq.size === N && !wrong && !missing;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(8)} submitted ${sent.size}, DLRs ${got.length}, unique ${uniq.size}, missing ${missing}, duplicates ${got.length - uniq.size}, id mismatches ${wrong}${extra}`);
  return ok;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlr-check-'));
  let allOk = true;
  try {
    // normal: DLRs flow while bound
    port++; let v = await startVendor({ port, dlrDelay: 1500, stateDir: dir });
    let g = await gateway(); let t0 = Date.now();
    let ids = await submitAll(g); await collect(g, N, 30000);
    allOk &= verdict('normal', ids, g.dlrs, ` · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    g.destroy(); await stopVendor(v, 'SIGTERM');

    for (const mode of ['away', 'restart', 'crash']) {
      port++; v = await startVendor({ port, dlrDelay: 10000, stateDir: dir }); // DLRs due 10 s after submit
      g = await gateway();
      ids = await submitAll(g);
      g.destroy();                                    // the gateway goes away before any DLR is due
      const left = Date.now();
      if (mode !== 'away') {
        await sleep(12000);                           // all DLRs due, nobody bound: pending
        await stopVendor(v, mode === 'restart' ? 'SIGTERM' : 'SIGKILL');
        v = await startVendor({ port, dlrDelay: 10000, stateDir: dir });
      }
      await sleep(Math.max(0, AWAY - (Date.now() - left)));
      g = await gateway(); t0 = Date.now();
      await collect(g, N, 90000);
      const last = g.dlrs.length ? (g.dlrs[g.dlrs.length - 1].at - t0) / 1000 : 0;
      await sleep(1100);
      const st = v.stats || {};
      allOk &= verdict(mode, ids, g.dlrs, ` · away ${(AWAY / 1000).toFixed(0)} s · drained in ${last.toFixed(1)} s · redelivered ${st.dlrRedelivered} · pending ${st.dlrPending} · log: "${v.logs.filter(l => /pending DLRs/.test(l)).join(' / ')}"`);
      g.destroy(); await stopVendor(v, 'SIGTERM');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

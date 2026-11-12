// Routing test: 2 vendors, 2 clients (different customers) through a small prefix router (tools/mini-router.js).
// Clean routing passes; misroutes, lost messages and DLRs sent to the wrong customer are counted exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fork } = require('child_process');
const { RoutingRun } = require('../routing-run');
const { miniRouter } = require('../tools/mini-router');
const { freePort } = require('./helpers');

const spawn = (file, onMsg) => {
  const p = fork(path.join(__dirname, '..', file), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  p.on('message', onMsg);
  return { post: m => p.connected && p.send(m), kill: () => p.kill(), onExit: f => p.on('exit', f) };
};

async function run(faults) {
  const rp = freePort(), va = freePort(), vb = freePort();
  const router = miniRouter({ port: rp, routes: [{ prefix: '9053', to: `127.0.0.1:${va}:vendA:pw` }, { prefix: '9054', to: `127.0.0.1:${vb}:vendB:pw` }], ...faults });
  const r = new RoutingRun(spawn);
  const done = new Promise(res => r.on('done', res));
  await r.start({ duration: 4, ramp: 0, dlr: true, dlrWait: 4, respTimeout: 5, text: 'Routing',
    vendors: [{ name: 'A', port: va, systemId: 'vendA', password: 'pw', prefixes: '9053', dlrDelay: 100 }, { name: 'B', port: vb, systemId: 'vendB', password: 'pw', prefixes: '9054', dlrDelay: 100 }],
    clients: [{ name: 'C1', host: '127.0.0.1', port: rp, systemId: 'c1', sessions: 2, window: 100, tps: 300, dst: '9053XXXXXXXX:70, 9054XXXXXXXX:30' },
              { name: 'C2', host: '127.0.0.1', port: rp, systemId: 'c2', sessions: 2, window: 100, tps: 300, dst: '9053XXXXXXXX:30, 9054XXXXXXXX:70' }] });
  const rep = await done; router.close();
  return { rep, router };
}

test('clean routing: every prefix at its vendor, nothing lost, DLRs back at the sender', async () => {
  const { rep } = await run({});
  assert.equal(rep.verdict, 'pass', JSON.stringify(rep.totals));
  assert.equal(rep.matrix.length, 4);
  for (const m of rep.matrix) {
    const k = m.prefix === '9053' ? 0 : 1;
    assert.equal(m.cells[k].n, m.accepted, `C${m.client} ${m.prefix} all at ${rep.vendors[k].name}`);
    assert.ok(!m.cells[1 - k] || m.cells[1 - k].n === 0);
  }
  const c1 = rep.matrix.filter(m => m.client === 1), share = c1.find(m => m.prefix === '9053').accepted / (c1[0].accepted + c1[1].accepted);
  assert.ok(Math.abs(share - 0.7) < 0.02, `70/30 mix: ${share}`);
  assert.equal(rep.totals.received, rep.totals.accepted);
});

test('faults are found and counted: misroutes, lost messages, DLRs at the wrong customer', async () => {
  const { rep, router } = await run({ misrouteEvery: 50, wrongDlrEvery: 40, dropEvery: 97 });
  assert.equal(rep.verdict, 'fail');
  assert.equal(rep.totals.misroute, router.stats.misrouted);
  assert.equal(rep.totals.lost, router.stats.dropped);
  assert.equal(rep.totals.wrongDlr, router.stats.wrongDlr);
  assert.ok(rep.totals.misroute > 0 && rep.totals.lost > 0 && rep.totals.wrongDlr > 0);
  assert.ok(rep.vendors.some(v => v.samples.length));
});

test('vendors started ahead stay up between tests; a wrong vendor login is reported', async () => {
  const rp = freePort(), va = freePort(), vb = freePort();
  const r = new RoutingRun(spawn);
  const vlog = []; r.on('vlog', m => vlog.push(m.msg.key));
  const V = [{ name: 'A', port: va, systemId: 'vendA', password: 'pw', prefixes: '9053', dlrDelay: 50 }, { name: 'B', port: vb, systemId: 'vendB', password: 'pw', prefixes: '9054', dlrDelay: 50 }];
  await r.startVendors({ vendors: V });
  assert.equal(r.vendorsUp, true);
  // A platform with the wrong password for B first, then the right one
  const bad = miniRouter({ port: freePort(), routes: [{ prefix: '9054', to: `127.0.0.1:${vb}:vendB:nope` }] });
  await new Promise(res => setTimeout(res, 800)); bad.close();
  assert.ok(vlog.some(k => /^Bind rejected/.test(k)), vlog.join(' | '));
  const router = miniRouter({ port: rp, routes: [{ prefix: '9053', to: `127.0.0.1:${va}:vendA:pw` }, { prefix: '9054', to: `127.0.0.1:${vb}:vendB:pw` }] });
  await router.ready;
  const procs = r.vendors.map(v => v.proc);
  const spec = { vendors: V, duration: 2, ramp: 0, dlr: true, dlrWait: 3, respTimeout: 5, text: 'Routing',
    clients: [{ name: 'C1', host: '127.0.0.1', port: rp, systemId: 'c1', sessions: 1, window: 50, tps: 200, dst: '9053XXXXXXXX, 9054XXXXXXXX' }] };
  for (let k = 0; k < 2; k++) {
    const done = new Promise(res => r.once('done', res));
    await r.start(spec);
    const rep = await done;
    assert.equal(rep.verdict, 'pass', JSON.stringify(rep.totals));
    assert.ok(rep.totals.received > 300 && rep.totals.received < 500, `counters start from zero each test: ${rep.totals.received}`);
  }
  assert.equal(r.vendorsUp, true, 'still up after the tests');
  assert.deepEqual(r.vendors.map(v => v.proc), procs, 'same vendor processes: the platform stayed bound');
  r.stopVendors(); router.close();
  assert.equal(r.vendorsUp, false);
});

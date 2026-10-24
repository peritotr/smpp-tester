// Shared helpers for the test suite: run the mock vendor and the load engine as child processes.
const { fork } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
let nextPort = 14000 + Math.floor(Math.random() * 2000);
const freePort = () => nextPort++;

function startVendor(opts) {
  return new Promise((resolve, reject) => {
    const p = fork(path.join(root, 'mock-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const v = { proc: p, stats: null, e2e: null, kill: () => p.kill() };
    p.on('message', m => {
      if (m.type === 'started') resolve(v);
      else if (m.type === 'error') reject(new Error(m.text));
      else if (m.type === 'stats') { v.stats = m.stats; if (m.stats.e2e && m.stats.e2e.n) v.e2e = m.stats.e2e; }
    });
    p.send({ type: 'start', opts });
  });
}

// Runs one load test to completion; resolves with { done, events, phases, ticks }
function runLoad(cfg, test, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = fork(path.join(root, 'load-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const out = { phases: [], ticks: [], logs: [] };
    const timer = setTimeout(() => { p.kill(); reject(new Error('load test timed out')); }, timeoutMs);
    p.on('message', m => {
      if (m.type === 'phase') {
        out.phases.push(m);
        if (m.phase === 'error') { clearTimeout(timer); p.kill(); resolve(out); }
      } else if (m.type === 'tick') out.ticks.push(m.row);
      else if (m.type === 'log') out.logs.push(m);
      else if (m.type === 'done') { out.done = m; clearTimeout(timer); setTimeout(() => { p.kill(); resolve(out); }, 300); }
    });
    p.send({ type: 'start', cfg, test });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { startVendor, runLoad, freePort, sleep, root };

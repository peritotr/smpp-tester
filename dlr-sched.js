// Small building blocks for the vendor's DLR scheduling.

// Binary min-heap keyed by a numeric field (due time, next retry time). O(log n) push/pop, so millions of pending
// DLRs never need a full scan on the hot path.
class MinHeap {
  // Ties are broken by creation order (n), so equal times keep the order DLRs were created in
  constructor(key) { this.key = key; this.a = []; }
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
  lt(x, y) { const k = this.key; return x[k] < y[k] || (x[k] === y[k] && x.n < y.n); }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.lt(x, a[p])) break; a[i] = a[p]; i = p; }
    a[i] = x;
  }
  pop() {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0], last = a.pop();
    if (a.length) {
      let i = 0; const n = a.length;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && this.lt(a[c + 1], a[c])) c++;
        if (!this.lt(a[c], last)) break;
        a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return top;
  }
  // Remove every element for which fn returns true (rare: expiry sweeps, redelivery switched off)
  removeWhere(fn) { const keep = [], out = []; for (const x of this.a) (fn(x) ? out : keep).push(x); this.a = []; for (const x of keep) this.push(x); return out; }
}

// DLR delay after submit: fixed, or drawn from a distribution (ms). mode: fixed | uniform | normal | exponential.
// uniform: mean ± spread · normal: mean, standard deviation = spread · exponential: mean (spread ignored).
function delaySampler(mode, mean, spread) {
  mean = Math.max(0, Number(mean) || 0); spread = Math.max(0, Number(spread) || 0);
  switch (mode) {
    case 'uniform': return () => Math.max(0, mean - spread + Math.random() * 2 * spread);
    case 'normal': return () => {
      const u = 1 - Math.random(), v = Math.random();
      return Math.max(0, mean + spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    };
    case 'exponential': return () => Math.min(mean * 20, -mean * Math.log(1 - Math.random()));
    default: return () => mean;
  }
}

// Exponential back-off with jitter: attempt n waits min(max, base·2^(n-1)), spread over its upper half so a batch
// rejected at the same moment does not come back at the same moment.
function backoff(fails, baseMs, maxMs) {
  const d = Math.min(maxMs, baseMs * 2 ** Math.max(0, fails - 1));
  return d * (0.5 + Math.random() * 0.5);
}

// "0x01, 0x0B, 11" → Set of numbers
function parseCodes(v, dflt) {
  const src = v == null || v === '' ? dflt : v;
  const list = Array.isArray(src) ? src : String(src).split(/[\s,;]+/);
  const out = new Set();
  for (const x of list) { if (x === '' || x == null) continue; const n = typeof x === 'number' ? x : /^0x/i.test(x) ? parseInt(x, 16) : parseInt(x, 10); if (Number.isFinite(n)) out.add(n >>> 0); }
  return out;
}

const hex = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(2, '0');

module.exports = { MinHeap, delaySampler, backoff, parseCodes, hex };

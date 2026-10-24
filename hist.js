// Logarithmic latency histogram (~3% resolution), microsecond buckets
class Hist {
  constructor() { this.b = new Uint32Array(700); this.n = 0; this.sum = 0; this.max = 0; }
  add(ms) { const us = Math.max(1, ms * 1000); const i = Math.min(699, Math.floor(Math.log(us) / Math.log(1.03))); this.b[i]++; this.n++; this.sum += ms; if (ms > this.max) this.max = ms; }
  pct(p) {
    if (!this.n) return null; const t = this.n * p; let c = 0;
    for (let i = 0; i < 700; i++) { c += this.b[i]; if (c >= t) return Math.pow(1.03, i + 0.5) / 1000; }
    return this.max;
  }
  merge(h) { for (let i = 0; i < 700; i++) this.b[i] += h.b[i]; this.n += h.n; this.sum += h.sum; this.max = Math.max(this.max, h.max); }
  summary() { return this.n ? { n: this.n, avg: this.sum / this.n, p50: this.pct(0.5), p95: this.pct(0.95), p99: this.pct(0.99), max: this.max } : { n: 0 }; }
}

module.exports = { Hist };

// Archive of load test reports (shared by the web server and the desktop app).
// Each report is <dir>/<id>.json; <dir>/index.json keeps short summaries for the list.
const fs = require('fs');
const path = require('path');
const { summary } = require('./ui/analysis.js');

class ReportStore {
  constructor(dir) { this.dir = dir; this.evidenceDir = path.join(dir, 'evidence'); fs.mkdirSync(dir, { recursive: true }); }
  // Routing test evidence file (gzipped CSV) by its name, or null
  evidencePath(name) { return /^[\w.-]+\.csv\.gz$/.test(String(name)) ? path.join(this.evidenceDir, name) : null; }
  _idx() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); } catch { return this._rebuild(); } }
  _writeIdx(list) { fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(list)); }
  _rebuild() {
    const list = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^\d{8}-\d{6}-[a-z0-9]+\.json$/.test(f)) continue;
      try { list.push(this._entry(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')))); } catch {}
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    this._writeIdx(list); return list;
  }
  _entry(rep) {
    if (rep.kind === 'routing') {
      const C = rep.clients || [], T = rep.totals || {};
      return { id: rep.id, name: rep.name || '', createdAt: rep.createdAt, mode: 'routing', host: [...new Set(C.map(c => c.host))].join(', '),
        target: C.reduce((a, c) => a + (c.tps || 0), 0), capacity: C.reduce((a, c) => a + ((c.totals && (c.totals.steadyTps ?? c.totals.avgTps)) || 0), 0),
        p95: Math.max(0, ...C.map(c => (c.totals && c.totals.lat && c.totals.lat.p95) || 0)) || null, sent: T.sent, verdict: rep.verdict, issues: rep.issues || 0,
        secs: rep.test && rep.test.duration };
    }
    let s = {}; try { s = summary(rep); } catch {}
    return { id: rep.id, name: rep.name || '', createdAt: rep.createdAt, host: rep.cfg && rep.cfg.host, target: rep.test && rep.test.tps,
      mode: rep.test && rep.test.steps ? 'step' : 'constant', secs: rep.totals && rep.totals.secs, ...s };
  }
  save(rep) {
    const d = new Date(rep.createdAt || Date.now());
    const p = n => String(n).padStart(2, '0');
    rep.id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
    fs.writeFileSync(path.join(this.dir, rep.id + '.json'), JSON.stringify(rep));
    const list = this._idx().filter(e => e.id !== rep.id);
    const entry = this._entry(rep); list.unshift(entry); this._writeIdx(list);
    return entry;
  }
  list() { return this._idx(); }
  get(id) {
    if (!/^[\w-]+$/.test(String(id))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8')); } catch { return null; }
  }
  remove(id) {
    if (!/^[\w-]+$/.test(String(id))) return false;
    const rep = this.get(id);
    for (const v of (rep && rep.vendors) || []) { const f = v.evidence && this.evidencePath(v.evidence.file); if (f) try { fs.unlinkSync(f); } catch {} }
    try { fs.unlinkSync(path.join(this.dir, id + '.json')); } catch {}
    this._writeIdx(this._idx().filter(e => e.id !== id)); return true;
  }
  rename(id, name) {
    const rep = this.get(id); if (!rep) return false;
    rep.name = String(name || '').slice(0, 120);
    fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(rep));
    this._writeIdx(this._idx().map(e => e.id === id ? { ...e, name: rep.name } : e)); return true;
  }
}

// Combines the engine's 'done' output, the start request and vendor info into one report
function assembleReport({ done, req, series, vendorOpts, vendorE2e, app }) {
  const cfg = req && req.cfg || {};
  return {
    version: 1, app: app || 'smpp-tester',
    name: (req && req.test && req.test.name) || '',
    createdAt: done.endedAt || Date.now(), startedAt: done.startedAt, endedAt: done.endedAt,
    cfg: { host: cfg.host, port: cfg.port, systemId: cfg.systemId, tls: !!cfg.tls, bindMode: cfg.bindMode },
    test: { ...done.test, text: req && req.test && req.test.text, src: req && req.test && req.test.src, dst: req && req.test && req.test.dst, encoding: req && req.test && req.test.encoding },
    totals: done.totals,
    series: series && series.length ? series : done.series,
    events: done.events || [],
    vendor: vendorOpts ? { opts: { ...vendorOpts, password: undefined }, e2e: vendorE2e || null } : null,
  };
}

module.exports = { ReportStore, assembleReport };

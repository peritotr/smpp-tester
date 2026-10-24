// Lists every translatable English string in the code base and reports the ones missing from the TR dictionary.
// Usage: node tools/i18n-keys.js [--all]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const keys = new Set();
const add = (s, html) => { if (html) s = s.replace(/\s+/g, ' ').trim(); if (s && /[A-Za-z]/.test(s)) keys.add(s); };
const unq = s => s.replace(/\\'/g, "'").replace(/\\"/g, '"');

// JS: t('…'), I18N.t('…'), msg('…'), err('…'), key: '…', label: '…' (single-quoted literals only)
const jsFiles = ['ui/renderer.js', 'ui/load.js', 'ui/reports-ui.js', 'ui/report.js', 'ui/analysis.js', 'ui/web-api.js',
  'load-engine.js', 'mock-smsc.js', 'smpp-core.js', 'server.js', 'main.js'];
const jsRe = [/\b(?:t|I18N\.t|msg|err|setPhase)\(\s*'((?:[^'\\]|\\.)*)'/g, /\b(?:t|I18N\.t)\(\s*\"((?:[^\"\\]|\\.)*)\"/g, /\b_event\(\s*'\w+',\s*'((?:[^'\\]|\\.)*)'/g, /\b(?:key|infoKey|label):\s*'((?:[^'\\]|\\.)*)'/g, /[{,]\s*error:\s*'((?:[^'\\]|\\.)*)'/g];
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const re of jsRe) for (const m of src.matchAll(re)) add(unq(m[1]));
  // Lookup tables whose values are passed through t(): STATE_TXT, STEP_STATUS, CAUSE
  for (const tbl of src.matchAll(/(?:STATE_TXT|STEP_STATUS|CAUSE) = \{([\s\S]*?)\};/g)) for (const m of tbl[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) add(unq(m[1]));
}
// HTML: elements with data-i18n, and data-i18n-attr attribute values
for (const f of ['ui/index.html', 'ui/report.html']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/<(\w+)\b([^>]*)>([^<]*)(?=<)/g)) if (/\sdata-i18n(?=[\s>]|$)/.test(m[2])) add(m[3], true);
  for (const m of src.matchAll(/<\w+([^>]*data-i18n-attr="([^"]+)"[^>]*)>/g)) for (const a of m[2].split(',')) { const v = new RegExp(`\\s${a.trim()}="([^"]*)"`).exec(m[1]); if (v) add(v[1], true); }
}
const I18N = require(path.join(root, 'ui/i18n.js'));
const tr = I18N.dict('tr');
const same = new Set(I18N.same || []);
const missing = [...keys].filter(k => !(k in tr) && !same.has(k)).sort();
const unused = Object.keys(tr).filter(k => !keys.has(k));
if (process.argv.includes('--all')) console.log([...keys].sort().join('\n'));
console.log(`${keys.size} strings, ${missing.length} missing in TR${unused.length ? `, ${unused.length} unused` : ''}`);
if (missing.length) { console.log('\nMissing:'); missing.forEach(k => console.log('  ' + JSON.stringify(k))); }
if (unused.length && process.argv.includes('--unused')) { console.log('\nUnused:'); unused.forEach(k => console.log('  ' + JSON.stringify(k))); }
process.exitCode = missing.length ? 1 : 0;

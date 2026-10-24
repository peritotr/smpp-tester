// Every translatable string has a Turkish translation, and templates fill in parameters.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const I18N = require('../ui/i18n.js');

test('no missing Turkish translations', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'i18n-keys.js')], { encoding: 'utf8' });
  assert.match(out, /, 0 missing in TR/);
});

test('Turkish templates keep the same placeholders as the English source', () => {
  const tr = I18N.dict('tr');
  const ph = s => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const [en, t] of Object.entries(tr)) assert.equal(ph(t), ph(en), `placeholders differ for: ${en}`);
});

test('t() fills parameters and falls back to English', () => {
  assert.equal(I18N.t('{n} part(s)', { n: 3 }), '3 part(s)');
  assert.equal(I18N.msg({ key: 'Port {port} is already in use', p: { port: 2775 } }), 'Port 2775 is already in use');
  assert.equal(I18N.msg('Some untranslated text'), 'Some untranslated text');
});

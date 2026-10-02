// Collects every t('…') key used in the panel and reports keys each locale is missing.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(f) && !p.includes('locales')) files.push(p);
  }
})('src/panel');

const keys = new Set();
const re = /\bt\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
for (const f of files) {
  for (const m of readFileSync(f, 'utf8').matchAll(re)) keys.add(m[2].replace(/\\(['"`\\])/g, '$1'));
}
// Strings translated through a variable: tab and field labels, helper modes, model notes, Pro reasons.
const extra = [
  ['src/panel/App.tsx', /label: '([^']+)'/g],
  ['src/panel/views/Import.tsx', /(?:label|hint): '([^']+)'/g],
  ['src/shared/models.ts', /note: '([^']+)'/g],
  ['src/background/runner.ts', /out\.add\('([^']+)'\)/g]
];
for (const [f, rx] of extra) for (const m of readFileSync(f, 'utf8').matchAll(rx)) keys.add(m[1]);
const list = [...keys].sort();
writeFileSync('research/i18n-keys.json', JSON.stringify(list, null, 2) + '\n');
console.log(list.length, 'keys');

for (const f of readdirSync('src/panel/locales').filter((f) => f.endsWith('.json'))) {
  const dict = JSON.parse(readFileSync(join('src/panel/locales', f), 'utf8'));
  const missing = list.filter((k) => !(k in dict));
  const stale = Object.keys(dict).filter((k) => !keys.has(k));
  console.log(f, 'missing', missing.length, 'stale', stale.length);
}

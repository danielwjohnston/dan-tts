// The extension can't import files outside its folder, so it carries copies of the
// engine and the text chunker. Run this after changing either; CI runs it with --check.
//   node scripts/sync-extension.mjs           copy into extension/
//   node scripts/sync-extension.mjs --check   fail if the copies are out of date
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ...readdirSync(join(root, 'engine/src')).filter((f) => f.endsWith('.js')).map((f) => [`engine/src/${f}`, `extension/engine/${f}`]),
  ['static/chunk-text.js', 'extension/lib/chunk-text.js'],
];
const check = process.argv.includes('--check');
let stale = 0;
for (const [src, dst] of pairs) {
  const a = readFileSync(join(root, src), 'utf8');
  let b = null;
  try { b = readFileSync(join(root, dst), 'utf8'); } catch {}
  if (a === b) continue;
  if (check) { console.error(`out of date: ${dst} (copy of ${src})`); stale++; }
  else { writeFileSync(join(root, dst), a); console.log(`updated ${dst}`); }
}
if (check && stale) { console.error('Run: node scripts/sync-extension.mjs'); process.exit(1); }

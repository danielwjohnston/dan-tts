// Build the Firefox version of the extension from the same source.
//   node scripts/build-firefox.mjs        → dist/firefox/ (load via about:debugging) and dist/dan-tts-firefox.zip
// Differences are manifest-only: Firefox uses a background page (it has no service-worker
// offscreen documents; the player runs inline there) and needs a gecko id.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'extension');
const out = join(root, 'dist', 'firefox');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true, filter: (p) => !relative(src, p).startsWith('test') && !p.endsWith('README.md') });

const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
m.background = { scripts: ['background.js'], type: 'module' };
m.permissions = m.permissions.filter((p) => p !== 'offscreen');
delete m.minimum_chrome_version;
// 140: CSS Custom Highlight API (in-place selection highlighting)
m.browser_specific_settings = { gecko: { id: 'dan-tts-reader@danielwjohnston.github.io', strict_min_version: '140.0' } };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
rmSync(join(out, 'offscreen.html'));

// Zip (stored) for about:debugging → "Load Temporary Add-on…" or AMO signing
const { makeZip } = (await import('node:module')).createRequire(import.meta.url)(join(root, 'static', 'bundle.js'));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ name: relative(out, p).split('\\').join('/'), data: new Uint8Array(readFileSync(p)) });
  }
};
walk(out);
writeFileSync(join(root, 'dist', 'dan-tts-firefox.zip'), makeZip(files));
console.log(`dist/firefox: ${files.length} files; dist/dan-tts-firefox.zip written`);

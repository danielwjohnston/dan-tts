// Assemble desktop/app/ (gitignored) from the extension's reader code plus desktop/src/.
// The desktop window runs the same reader as the extension; src/chrome-shim.js stands in for
// the chrome.* APIs. Runs automatically before `npm start` and `npm test` in desktop/.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const src = join(root, 'desktop', 'src');
const out = join(root, 'desktop', 'app');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'icons'), { recursive: true });
for (const f of ['content.js', 'content.css', 'offscreen.js', 'pdf-reader.js']) cpSync(join(ext, f), join(out, f));
cpSync(join(ext, 'lib'), join(out, 'lib'), { recursive: true });
cpSync(join(ext, 'engine'), join(out, 'engine'), { recursive: true });
cpSync(join(ext, 'icons', '128.png'), join(out, 'icons', '128.png'));
for (const f of readdirSync(src)) if (f !== 'csp.txt') cpSync(join(src, f), join(out, f));

// The extension's PDF reader page, adapted: same CSP as the other pages, the chrome.* shim
// first, a way home, and desktop wording
const csp = readFileSync(join(src, 'csp.txt'), 'utf8').trim();
let html = readFileSync(join(ext, 'pdf-reader.html'), 'utf8');
const patch = (from, to) => { if (!html.includes(from)) throw new Error(`pdf-reader.html changed: can't find ${from}`); html = html.replace(from, to); };
patch('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">\n  <link rel="stylesheet" href="desktop.css">\n  <script src="chrome-shim.js"></script>`);
patch('<body>', '<body>\n  <div class="topbar"><a href="home.html">← Home</a></div>');
patch('or press <strong>Alt+Shift+R</strong> while viewing a PDF online', 'or paste a PDF link on the home page');
writeFileSync(join(out, 'pdf-reader.html'), html);
console.log('desktop/app assembled');

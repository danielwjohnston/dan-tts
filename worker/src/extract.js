// Load from URL on the Worker: fetch a page and pull out its readable text. There is no DOM
// here and no dependencies, so this is a small, tolerant HTML tokenizer (linear time, implied
// end tags for p/li/dt/dd/tr/td/option, the escaped-script rules of the HTML spec). It keeps
// the Python server's rules (which element is read, the meta-description fallback, limits and
// error messages, so the tester behaves the same against either server) and goes further on
// what is dropped: sidebars, menus and boxes (as the Load from URL cleanup, PR #29, proposes
// for the Python server), MediaWiki chrome, hidden elements and form controls.

export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; DanTTS/0.1; +https://github.com/danielwjohnston/dan-tts)';
const ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';

export class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Their content isn't HTML: skip straight to the closing tag
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'iframe', 'xmp', 'noframes']);
// Never read aloud: code, pictures, site chrome, form controls
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'img', 'picture', 'nav', 'header', 'footer', 'aside', 'menu',
  'iframe', 'object', 'embed', 'canvas', 'video', 'audio', 'select', 'button', 'textarea', 'datalist', 'noframes']);
// Paragraph breaks (blank line) and plain line breaks
const PARA = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'li', 'figcaption', 'hr', 'dd', 'dt', 'tr', 'caption', 'summary',
  'details', 'figure', 'table', 'ul', 'ol', 'dl']);
const BLOCK = new Set(['div', 'section', 'article', 'main', 'body', 'html', 'address', 'fieldset', 'form', 'legend', 'td', 'th', 'thead', 'tbody',
  'tfoot', 'dialog', 'center', 'br', 'label', 'option']);
const KEEP_ROOTS = new Set(['html', 'body', 'main', 'article']);
// Start tags that close an open <p> (the HTML parser's "close a p element" rule)
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul',
  'li', 'dd', 'dt']);
// The Python server's hints (ids and classes that mark sidebars, menus and boxes), plus the
// generic markers MediaWiki sites (Wikisource, Wikipedia) and accessibility helpers use for
// things that aren't the text: print-hidden boxes, hatnotes, category links, "[edit]" links,
// screen-reader-only labels
const CHROME_HINT = /(^|[-_])(sidebar|side-box|menu|navbar|breadcrumbs?|cookies?|comments?|share|sharing|social|promo|ads?|advert(isement)?|toc|masthead|site-header|site-footer|noprint|noexport|hatnote|catlinks|printfooter|editsection|sitesub|contentsub|indicators|skip-link|sr-only|visually-hidden|screen-reader-text)([-_]|$)/i;
const CHROME_ROLE = /navigation|complementary|banner|contentinfo|button|menu|menubar|toolbar|search|dialog|tooltip|tablist|note/;
const META_KEYS = ['og:description', 'description', 'twitter:description'];

// Latin-1 letters &Agrave; … &yuml; are code points 192–255 in this order (× and ÷ aside)
const LATIN1 = 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const ENTITIES = Object.fromEntries(LATIN1.split(' ').map((name, i) => [name, String.fromCodePoint(192 + i)]));
Object.assign(ENTITIES, {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•',
  middot: '·', deg: '°', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', euro: '€', pound: '£',
  yen: '¥', cent: '¢', curren: '¤', sect: '§', para: '¶', dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″', iexcl: '¡',
  iquest: '¿', micro: 'µ', ordf: 'ª', ordm: 'º', macr: '¯', acute: '´', cedil: '¸', uml: '¨', brvbar: '¦', not: '¬', larr: '←',
  rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', spades: '♠', clubs: '♣', diams: '♦', minus: '−', infin: '∞', ne: '≠',
  le: '≤', ge: '≥', asymp: '≈', equiv: '≡', radic: '√', sum: '∑', loz: '◊', oline: '‾', frasl: '⁄', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', pi: 'π', mu: 'μ', sigma: 'σ', omega: 'ω', Omega: 'Ω', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ',
  fnof: 'ƒ', circ: 'ˆ', tilde: '˜', check: '✓',
});
// Numeric references in the Windows-1252 range, which old pages use for curly quotes and dashes
const CP1252 = { 128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž',
  145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ' };

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g, (m, hex, dec, name) => {
    if (name) return m.endsWith(';') && Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : m;
    const code = hex ? parseInt(hex, 16) : Number(dec);
    if (code in CP1252) return CP1252[code];
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  });
}

/** Collects text with inline whitespace collapsed and block breaks between lines. */
class Sink {
  constructor() { this.out = ''; this.pendingBreak = 0; this.pendingSpace = false; this.open = true; }
  text(s) {
    s = s.replace(/[\s ]+/g, ' ');
    if (!s) return;
    if (s === ' ') { this.pendingSpace = true; return; }
    const lead = s[0] === ' ', trail = s[s.length - 1] === ' ';
    s = s.trim();
    if (this.pendingBreak) { this.out += '\n'.repeat(this.pendingBreak); this.pendingBreak = 0; }
    else if ((this.pendingSpace || lead) && this.out) this.out += ' ';
    this.out += s;
    this.pendingSpace = trail;
  }
  brk(n) { if (this.out) this.pendingBreak = Math.max(this.pendingBreak, n); }
  toString() { return this.out.replace(/\n{3,}/g, '\n\n').trim(); }
}

function parseAttrs(html, pos) {
  // From just after the tag name to the closing '>', honoring quotes. Returns [attrs, end, selfClosing]
  const attrs = Object.create(null); // so "constructor" or "hidden" attributes can't collide with Object's
  const n = html.length;
  while (pos < n) {
    while (pos < n && /\s/.test(html[pos])) pos++;
    if (pos >= n) break;
    if (html[pos] === '>') return [attrs, pos + 1, false];
    if (html[pos] === '/') { if (html[pos + 1] === '>') return [attrs, pos + 2, true]; pos++; continue; }
    const m = /[^\s"'<>\/=]+/y; m.lastIndex = pos;
    const name = m.exec(html)?.[0];
    if (!name) { pos++; continue; }
    pos += name.length;
    let value = '';
    let p = pos;
    while (p < n && /\s/.test(html[p])) p++;
    if (html[p] === '=') {
      p++;
      while (p < n && /\s/.test(html[p])) p++;
      const q = html[p];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, p + 1);
        value = html.slice(p + 1, end < 0 ? n : end);
        p = end < 0 ? n : end + 1;
      } else {
        const v = /[^\s>]*/y; v.lastIndex = p;
        value = v.exec(html)[0];
        p += value.length;
      }
      pos = p;
    }
    if (!(name.toLowerCase() in attrs)) attrs[name.toLowerCase()] = decodeEntities(value);
  }
  return [attrs, n, false];
}

// Where a <script> really ends: inside an HTML comment that itself contains "<script", a
// "</script>" belongs to the script (the old document.write('<script …></script>') trick),
// per the tokenizer's escaped and double-escaped script states.
function scriptEnd(html, from) {
  const re = /<!--|-->|<script\b|<\/script\s*>/ig;
  re.lastIndex = from;
  let escaped = false, double = false;
  for (let m; (m = re.exec(html));) {
    const t = m[0].toLowerCase();
    if (t === '<!--') escaped = true;
    else if (t === '-->') { escaped = false; double = false; }
    else if (t.startsWith('<script')) { if (escaped) double = true; }
    else if (double) double = false;
    else return m;
  }
  return null;
}

const isChrome = (name, attrs) => {
  if (CHROME_ROLE.test(attrs.role || '')) return true;
  // Not shown to sighted readers either: hidden, aria-hidden, display:none, or marked as not-content
  if ('hidden' in attrs || attrs['aria-hidden'] === 'true' || 'data-nosnippet' in attrs || /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || '')) return true;
  if (KEEP_ROOTS.has(name)) return false;
  const tokens = [attrs.id || '', ...(attrs.class || '').split(/\s+/)];
  return tokens.some((t) => t && CHROME_HINT.test(t));
};

/**
 * Readable text of an HTML document.
 * @returns {{ title: string, text: string, description: string }}
 *  text: the first <main>, else the first <article>, else the whole body, with site chrome removed
 */
export function htmlToText(html) {
  const body = new Sink();
  let main = null, article = null;
  const stack = []; // open elements: { name, drop, capture }
  const openIdx = new Map(); // name -> stack indexes of the open elements with that name, ascending
  let dropDepth = 0;
  let title = null;
  const metas = {};

  const sinks = () => [body, main, article].filter((s) => s && s.open);
  const emitText = (s) => { if (!dropDepth) for (const k of sinks()) k.text(s); };
  const emitBreak = (count) => { if (!dropDepth) for (const k of sinks()) k.brk(count); };
  const breakFor = (name) => (PARA.has(name) ? 2 : BLOCK.has(name) || DROP.has(name) ? 1 : 0);

  const close = (el) => {
    if (el.capture) el.capture.open = false;
    if (el.drop) { dropDepth--; emitBreak(breakFor(el.name)); return; }
    const b = breakFor(el.name);
    if (b) emitBreak(b);
  };
  // Every push and pop is O(1), so a page full of stray or omitted end tags stays linear
  const lastOpen = (name) => { const a = openIdx.get(name); return a && a.length ? a[a.length - 1] : -1; };
  const push = (el) => { let a = openIdx.get(el.name); if (!a) openIdx.set(el.name, a = []); a.push(stack.length); stack.push(el); };
  const pop = () => { const el = stack.pop(); openIdx.get(el.name).pop(); close(el); };
  const closeTo = (name) => { const idx = lastOpen(name); if (idx < 0) return; while (stack.length > idx) pop(); };
  const deepest = (...names) => Math.max(-1, ...names.map(lastOpen));
  // End tags the HTML parser supplies itself when the next start tag implies them
  const impliedEnd = (name) => {
    if (CLOSES_P.has(name) && lastOpen('p') > deepest('button', 'table', 'td', 'th', 'caption', 'template')) closeTo('p');
    if (name === 'li' && lastOpen('li') > deepest('ul', 'ol', 'menu')) closeTo('li');
    if ((name === 'dt' || name === 'dd') && deepest('dt', 'dd') > lastOpen('dl')) closeTo(lastOpen('dt') > lastOpen('dd') ? 'dt' : 'dd');
    if (name === 'tr' && lastOpen('tr') > lastOpen('table')) closeTo('tr');
    if ((name === 'td' || name === 'th') && deepest('td', 'th') > deepest('tr', 'table')) closeTo(lastOpen('td') > lastOpen('th') ? 'td' : 'th');
    if ((name === 'thead' || name === 'tbody' || name === 'tfoot') && deepest('thead', 'tbody', 'tfoot') > lastOpen('table')) closeTo(['thead', 'tbody', 'tfoot'].sort((x, y) => lastOpen(y) - lastOpen(x))[0]);
    if (name === 'option' && lastOpen('option') > lastOpen('select')) closeTo('option');
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { emitText(decodeEntities(html.slice(i))); break; }
    if (lt > i) emitText(decodeEntities(html.slice(i, lt)));
    const c = html[lt + 1];
    if (c === '!' || c === '?') {
      // Comment, doctype, CDATA or processing instruction
      const end = html.startsWith('<!--', lt) ? html.indexOf('-->', lt + 4) : html.indexOf('>', lt);
      if (end < 0) break;
      i = end + (html.startsWith('<!--', lt) ? 3 : 1);
      continue;
    }
    if (c === '/') {
      const m = /<\/([a-zA-Z][^\s\/>]*)[^>]*>/y; m.lastIndex = lt;
      const e = m.exec(html);
      if (!e) { emitText('<'); i = lt + 1; continue; }
      closeTo(e[1].toLowerCase());
      i = lt + e[0].length;
      continue;
    }
    const m = /<([a-zA-Z][^\s\/>]*)/y; m.lastIndex = lt;
    const s = m.exec(html);
    if (!s) { emitText('<'); i = lt + 1; continue; }
    const name = s[1].toLowerCase();
    const [attrs, after, selfClosing] = parseAttrs(html, lt + s[0].length);
    i = after;

    if (name === 'meta') {
      const key = (attrs.property || attrs.name || '').toLowerCase();
      if (META_KEYS.includes(key) && attrs.content && attrs.content.trim() && !(key in metas)) metas[key] = attrs.content.trim();
      continue;
    }
    if (RAW.has(name) && !selfClosing) {
      const endRe = new RegExp(`</${name}\\s*>`, 'ig'); endRe.lastIndex = i;
      const e = name === 'script' ? scriptEnd(html, i) : endRe.exec(html);
      const raw = html.slice(i, e ? e.index : n);
      i = e ? e.index + e[0].length : n;
      if (name === 'title' && title === null && !dropDepth) title = decodeEntities(raw).replace(/\s+/g, ' ').trim();
      else if (!DROP.has(name) && !dropDepth) emitText(decodeEntities(raw));
      else emitBreak(1);
      continue;
    }
    const drop = DROP.has(name) || isChrome(name, attrs);
    if (VOID.has(name) || selfClosing) {
      if (!drop) { if (name === 'br') emitBreak(1); else if (name === 'hr') emitBreak(2); }
      else emitText(' ');
      continue;
    }
    impliedEnd(name);
    const el = { name, drop, capture: null };
    if (drop) { emitBreak(breakFor(name)); dropDepth++; }
    else {
      const b = breakFor(name);
      if (b) emitBreak(b);
      if (!dropDepth && name === 'main' && !main) el.capture = main = new Sink();
      else if (!dropDepth && name === 'article' && !article) el.capture = article = new Sink();
    }
    push(el);
  }
  while (stack.length) pop();

  const description = META_KEYS.map((k) => metas[k]).find(Boolean) || '';
  const text = (main || article || body).toString();
  return { title: title || '', text, description };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
const ipv4 = (host) => {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m ? m.slice(1).map(Number) : null;
};
const privateV4 = ([a, b, c]) => a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
  || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
// The eight 16-bit groups of an IPv6 address (as the URL parser serializes it), or null
function ipv6Groups(host) {
  if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(':')) return null;
  const [head, tail = ''] = host.split('::');
  const expand = (part) => (part ? part.split(':') : []).flatMap((g) => {
    const v4 = ipv4(g);
    return v4 ? [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]] : [parseInt(g, 16)];
  });
  const a = expand(head), b = expand(tail);
  if (host.includes('::') ? a.length + b.length > 7 : a.length !== 8) return null;
  const groups = [...a, ...new Array(8 - a.length - b.length).fill(0), ...b];
  return groups.some(Number.isNaN) ? null : groups;
}
function isPrivateHost(hostname) {
  let host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const v4 = ipv4(host);
  if (v4) return privateV4(v4);
  const g = ipv6Groups(host);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]); // 64:ff9b::a.b.c.d
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] === 0x2001 && g[1] === 0xdb8) || (g[0] & 0xff00) === 0xff00;
}

/** Rejects anything but http(s) to a public host (the Worker can't see your network, but be explicit). */
export function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new HttpError(400, 'URL must start with http:// or https://'); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new HttpError(400, 'URL must start with http:// or https://');
  if (isPrivateHost(u.hostname)) throw new HttpError(400, 'URL host is not allowed');
  return u;
}

function decodeBody(bytes, contentType) {
  let charset = (contentType.match(/charset=["']?([\w.:-]+)/i) || [])[1];
  if (!charset) {
    // Sniff a <meta charset> in the first 2 KB, like browsers do
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    charset = (head.match(/<meta[^>]+charset=["']?([\w.:-]+)/i) || [])[1];
  }
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

const CF_REASONS = { 520: 'the site sent an invalid response', 521: 'the web server is down', 522: 'the connection timed out', 523: 'the site is unreachable',
  524: 'the site took too long to respond', 525: 'TLS handshake failed', 526: 'the site has an invalid certificate' };

/** Fetches a page as text, following redirects one hop at a time so each hop is checked. */
export async function fetchHtml(url, { fetchImpl = globalThis.fetch } = {}) {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = assertPublicUrl(url);
    let res;
    try {
      res = await fetchImpl(u.toString(), { headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new HttpError(504, 'URL fetch timed out');
      throw new HttpError(502, `Failed to fetch URL: ${err?.message || err}`);
    }
    const location = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      try { url = new URL(location, u).toString(); } catch { throw new HttpError(502, 'URL returned an invalid redirect'); }
      continue;
    }
    // On Cloudflare a subrequest that can't reach the site doesn't reject: it resolves with one of
    // Cloudflare's own 52x/530 statuses. Report those like the Python server reports its errors.
    if (res.status === 530) throw new HttpError(400, 'Could not resolve URL host');
    if (res.status >= 520 && res.status <= 529) throw new HttpError(502, `Failed to fetch URL: ${CF_REASONS[res.status] || 'the site could not be reached'}`);
    if ([401, 403, 429].includes(res.status)) {
      throw new HttpError(502, `${u.hostname} blocked automated access (HTTP ${res.status}). Open the page in your browser and paste the text instead.`);
    }
    if (res.status !== 200) throw new HttpError(502, `URL returned HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_FETCH_BYTES) throw new HttpError(413, 'Page is too large');
    const parts = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_FETCH_BYTES) { reader.cancel().catch(() => {}); throw new HttpError(413, 'Page is too large'); }
          parts.push(value);
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new HttpError(504, 'URL fetch timed out');
        throw new HttpError(502, `Failed to fetch URL: ${err?.message || err}`);
      }
    }
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const p of parts) { bytes.set(p, off); off += p.length; }
    return decodeBody(bytes, res.headers.get('content-type') || '');
  }
  throw new HttpError(502, 'Too many redirects');
}

/**
 * The /extract_text endpoint: { text, title, chars } for a URL or bare domain.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function extractText(url, opts = {}) {
  url = (url || '').trim();
  if (!url) throw new HttpError(400, 'URL is required');
  let candidates;
  if (/^https?:\/\//i.test(url)) candidates = [url];
  else if (url.includes('://')) throw new HttpError(400, 'Only http:// and https:// URLs are supported');
  else {
    // Bare domain like "digg.com": try HTTPS first, then fall back to HTTP
    const bare = url.replace(/^\/+/, '');
    candidates = [`https://${bare}`, `http://${bare}`];
  }
  let html, error;
  for (const candidate of candidates) {
    try { html = await fetchHtml(candidate, opts); error = null; break; } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      error = err;
    }
  }
  if (error) throw error;

  const { title, text, description } = htmlToText(html);
  let out = text;
  if (out.split(/\s+/).filter(Boolean).length < 5) {
    if (!description) throw new HttpError(422, 'No readable text found; the page is probably rendered with JavaScript');
    out = [title, description].filter(Boolean).join('\n\n');
  }
  return { text: out, title, chars: out.length };
}

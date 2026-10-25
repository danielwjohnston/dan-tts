// Finds a document's "next page" link: the next chapter of a book read page by page, or the
// next page of a long article. rel="next" wins; then links that say "next" or "continue";
// then links marked next by their class or id (the arrow buttons of a pager), then a link
// that is nothing but a forward arrow. Only http(s) links to a different page, and only on
// the same site unless told otherwise.
(function (root) {
  const WORDS = /^(next|next (page|chapter|part|section|post|article|episode|entry|story|installment)|continue|continue reading|read next|keep reading)$/;
  const norm = (s) => (s || '').toLowerCase().replace(/[›»→>«‹←<|:.…,!\-–—_\s]+/g, ' ').trim();
  const ARROWS = /^[\s›»→>«‹←<]+|[\s›»→>«‹←<]+$/g;
  const FORWARD = /^\s*[›»→>⟩▶⏵⏭➔➜➡⇒]+\s*$/; // an arrow pointing ahead, and nothing else
  const classAndId = (el) => `${el.id || ''} ${el.getAttribute('class') || ''}`;

  // Marked as "next" by its own or a nearby ancestor's class/id (and not as "previous")
  function marked(el) {
    for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) {
      const s = classAndId(e);
      if (/prev/i.test(s)) return false;
      if (/next/i.test(s)) return true;
    }
    return false;
  }

  function label(el, url) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const own = text.replace(ARROWS, '').trim();
    const alt = (el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(ARROWS, '').trim();
    const best = own && !/^\W*$/.test(own) ? own : alt;
    if (best) return best.slice(0, 80);
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '') || u.hostname;
  }

  /**
   * @param {Document} doc        the page (live, or parsed with DOMParser)
   * @param {string} base         the page's address, for relative links
   * @param {string} [currentUrl] the page being read (defaults to base); never returned
   * @param {{ sameOrigin?: boolean }} [opts]  sameOrigin defaults to true
   * @returns {{ url: string, label: string } | null}
   */
  function find(doc, base, currentUrl = base, opts = {}) {
    let current;
    try { current = new URL(currentUrl); } catch { return null; }
    const resolve = (href) => {
      let u;
      try { u = new URL(href || '', base); } catch { return null; }
      if (!/^https?:$/.test(u.protocol)) return null;
      if (opts.sameOrigin !== false && u.origin !== current.origin) return null;
      u.hash = '';
      return u.href === current.href.replace(/#.*$/, '') ? null : u.href;
    };
    let best = null;
    const consider = (el, score) => {
      const url = resolve(el.getAttribute('href'));
      if (url && (!best || score > best.score)) best = { score, url, label: label(el, url) };
    };
    for (const el of doc.querySelectorAll('link[rel][href], a[rel][href]')) {
      if (/(^|\s)next(\s|$)/i.test(el.getAttribute('rel'))) consider(el, 3);
    }
    if (!best) {
      for (const a of doc.querySelectorAll('a[href]')) {
        const own = a.textContent || '';
        let t = norm(own);
        if (!t) t = norm(a.getAttribute('aria-label') || a.getAttribute('title'));
        if (WORDS.test(t)) consider(a, 2);
        else if (t.length <= 40 && marked(a)) consider(a, 1);
        else if (FORWARD.test(own)) consider(a, 0);
      }
    }
    return best ? { url: best.url, label: best.label } : null;
  }

  const api = { find };
  root.danNextLink = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

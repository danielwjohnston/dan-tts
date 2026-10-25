// Finds a document's "next page" link: the next chapter of a book read page by page, or the
// next page of a long article. rel="next" wins; then links that say "next" or "continue"
// (including "Next: Chapter III" and "Next Chapter (3)"); then links marked next or forward by
// their own or a nearby ancestor's class or id (a pager's arrow, Wikisource's header), then a
// link that is nothing but a forward arrow. Only http(s) links to a different page, never
// comment pages, and only on the same site unless told otherwise.
(function (root) {
  const WORDS = /^(next|continue|continue reading|read next|keep reading|next (page|chapter|part|section|post|article|episode|entry|story|installment))$/;
  // "Next: Chapter III", "Next Chapter: The Trial", "Next chapter (3)", "[Next]"…
  const STARTS_NEXT = /^next( (page|chapter|part|section|episode|installment))?( .{1,60})?$/;
  // …but not "Next steps", "Up next", "What's next"
  const NOT_NEXT = /^next (steps?|up|in|on|to|at|time|week|month|year|day|level|generation|gen|big|event)\b/;
  const LEAD = /^(next( (page|chapter|part|section|post|article|episode|entry|story|installment))?|continue( reading)?|read next|keep reading)\s*[:\-–—]?\s*/i;
  const COMMENTS = /comment-page-\d+|#comments?$|\/comments?\/?$/i;
  const norm = (s) => (s || '').toLowerCase().replace(/[›»→>«‹←<|:.…,!\-–—_\s()[\]{}"'“”]+/g, ' ').trim();
  const ARROWS = /^[\s›»→>«‹←<]+|[\s›»→>«‹←<]+$/g;
  const FORWARD = /^\s*[›»→>⟩▶⏵⏭➔➜➡⇒]+\s*$/; // an arrow pointing ahead, and nothing else
  const HIDDEN = '.screen-reader-text, .sr-only, .visually-hidden, .visuallyhidden, [hidden]';
  // Words in a class or id: "nav-next", "nextChapter", "wst-header-forward-link"
  const tokens = (el) => `${el.id || ''} ${el.getAttribute('class') || ''}`.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  // Marked as "next" (or "forward") by its own or a nearby ancestor's class/id, and not as "previous".
  // A pager's next slot holds one link; a page wrapper (Next.js's #__next), an "up next" block
  // or a menu holds many, and those don't count.
  function marked(el) {
    for (let e = el, i = 0; e && i < 4 && e !== el.ownerDocument.body; e = e.parentElement, i++) {
      const t = tokens(e);
      if (t.some((x) => x === 'prev' || x === 'previous' || x === 'back')) return false;
      if (t.some((x) => x === 'next' || x === 'forward')) return e.querySelectorAll('a[href]').length <= 2;
    }
    return false;
  }

  // The visible words of a link, with screen-reader-only spans left out and spaces between parts
  function visibleText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(HIDDEN).forEach((n) => n.remove());
    clone.querySelectorAll('*').forEach((n) => { n.before(' '); n.after(' '); });
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function label(el, url) {
    let own = visibleText(el).replace(ARROWS, '').trim();
    // "Next: Chapter 3" and "Next post Chapter 3" are about Chapter 3
    const rest = own.replace(LEAD, '').trim();
    if (rest && !/^\W*$/.test(rest)) own = rest;
    const alt = (el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(ARROWS, '').trim();
    const best = own && !/^\W*$/.test(own) ? own : alt;
    if (best) return best.slice(0, 80);
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    try { return decodeURIComponent(last) || u.hostname; } catch { return last || u.hostname; }
  }

  /**
   * @param {Document} doc        the page (live, or parsed with DOMParser)
   * @param {string} base         the page's address, for relative links
   * @param {string} [currentUrl] the page being read (defaults to base); never returned
   * @param {{ sameOrigin?: boolean }} [opts]  sameOrigin defaults to true
   * @returns {{ url: string, label: string } | null}
   */
  function find(doc, base, currentUrl = base, opts = {}) {
    // Never let a strange page break reading: no link is the worst outcome
    try { return search(doc, base, currentUrl, opts); } catch (e) { console.warn('dan-tts: next-link failed', e); return null; }
  }

  function search(doc, base, currentUrl, opts) {
    let current;
    try { current = new URL(currentUrl); } catch { return null; }
    const resolve = (href) => {
      let u;
      try { u = new URL(href || '', base); } catch { return null; }
      if (!/^https?:$/.test(u.protocol)) return null;
      if (opts.sameOrigin !== false && u.origin !== current.origin) return null;
      if (COMMENTS.test(u.href)) return null;
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
        const own = visibleText(a);
        if (/\bcomments?\b/i.test(own)) continue; // "Newer comments", "12 comments"
        let t = norm(own);
        if (!t) t = norm(a.getAttribute('aria-label') || a.getAttribute('title'));
        if (WORDS.test(t) || (STARTS_NEXT.test(t) && !NOT_NEXT.test(t))) consider(a, 2);
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

// Split long text into paragraph-sized chunks for sequential synthesis.
// Paragraphs (blank-line separated) are kept whole when they fit; short ones are
// merged up to `target` chars, and oversized ones are split at sentence ends.
(function (root) {
  function splitLong(para, max) {
    const sentences = para.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) || [para];
    const out = [];
    let cur = '';
    for (const s of sentences) {
      if (cur && (cur + s).length > max) { out.push(cur.trim()); cur = ''; }
      if (s.length > max) {
        // A single run-on "sentence": fall back to splitting on whitespace
        let rest = s;
        while (rest.length > max) {
          let cut = rest.lastIndexOf(' ', max);
          if (cut <= 0) cut = max;
          out.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut);
        }
        cur = rest;
      } else {
        cur += s;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function chunkText(text, opts) {
    const max = (opts && opts.max) || 3000;
    const target = (opts && opts.target) || 1200;
    const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let cur = '';
    for (const p of paras) {
      const pieces = p.length > max ? splitLong(p, max) : [p];
      for (const piece of pieces) {
        if (cur && (cur.length + piece.length + 2 > target)) { chunks.push(cur); cur = ''; }
        cur = cur ? cur + '\n\n' + piece : piece;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  root.chunkText = chunkText;
  if (typeof module !== 'undefined') module.exports = { chunkText };
})(typeof window !== 'undefined' ? window : globalThis);

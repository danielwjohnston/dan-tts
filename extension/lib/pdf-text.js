// Rebuild readable paragraphs from pdf.js text items.
// PDFs store positioned text runs, not paragraphs: this groups runs into lines,
// drops page numbers and running headers/footers, rejoins hyphenated words, and
// splits paragraphs on vertical gaps or short sentence-ending lines.
(function (root) {
  const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const fontSize = (it) => Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;

  /** pdf.js items for one page → [{ text, x, y, size, right }] in reading order */
  function itemsToLines(items) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (!it.str && !it.hasEOL) continue;
      // Skip rotated text: margin stamps, watermarks, sideways table labels
      if (Math.abs(it.transform[1]) > Math.abs(it.transform[0]) * 0.1) continue;
      const size = fontSize(it);
      const x = it.transform[4], y = it.transform[5];
      if (cur && it.str && Math.abs(y - cur.y) <= Math.max(cur.size, size) * 0.5) {
        const gap = x - cur.right;
        if (gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
        cur.text += it.str;
        cur.right = x + (it.width || 0);
        cur.size = Math.max(cur.size, size);
      } else if (it.str) {
        if (cur) lines.push(cur);
        cur = { text: it.str, x, y, size, right: x + (it.width || 0) };
      }
      if (it.hasEOL && cur) { lines.push(cur); cur = null; }
    }
    if (cur) lines.push(cur);
    return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
  }

  const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$|^[-–—]\s*\d{1,4}\s*[-–—]$|^[ivxlcdm]{1,6}$/i;
  const shape = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

  /**
   * @param {Array<Array<{str:string, transform:number[], width?:number, height?:number, hasEOL?:boolean}>>} pages  text items per page
   * @returns {{ tag: 'h' | 'p', text: string }[]}
   */
  function pagesToBlocks(pages) {
    const pageLines = pages.map(itemsToLines);

    // Running headers/footers: the same text (ignoring numbers) at the top or bottom of many pages
    const edgeCounts = new Map();
    for (const lines of pageLines) {
      const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => shape(l.text)));
      for (const e of edges) edgeCounts.set(e, (edgeCounts.get(e) || 0) + 1);
    }
    // Two pages are enough: the same line at the top (or bottom) of both is a running header
    const repeated = new Set([...edgeCounts].filter(([, n]) => n >= 2 && n >= pageLines.length * 0.5).map(([k]) => k));

    const all = pageLines.flatMap((lines, p) => lines
      .filter((l, i) => {
        const edge = i < 2 || i >= lines.length - 2;
        return !(edge && (PAGE_NUMBER.test(l.text) || repeated.has(shape(l.text))));
      })
      .map((l) => ({ ...l, page: p })));
    if (!all.length) return [];

    const bodySize = median(all.map((l) => l.size));
    const spacings = [];
    for (let i = 1; i < all.length; i++) {
      if (all[i].page === all[i - 1].page) { const d = all[i - 1].y - all[i].y; if (d > 0) spacings.push(d); }
    }
    const lineGap = median(spacings) || bodySize * 1.2;
    const typicalWidth = median(all.map((l) => l.right - l.x));

    const blocks = [];
    let para = null;
    const flush = () => { if (para) blocks.push(para); para = null; };
    for (let i = 0; i < all.length; i++) {
      const l = all[i], prev = all[i - 1];
      const isHeading = l.size > bodySize * 1.25 && l.text.length < 120;
      if (isHeading) {
        if (para && para.tag === 'h' && prev && prev.page === l.page && prev.y - l.y < l.size * 1.6) { para.text += ' ' + l.text; continue; }
        flush();
        para = { tag: 'h', text: l.text };
        continue;
      }
      let newPara = !para || para.tag === 'h';
      if (!newPara && prev) {
        const samePage = prev.page === l.page;
        const gap = samePage ? prev.y - l.y : 0;
        const prevShort = prev.right - prev.x < typicalWidth * 0.75;
        const prevEnds = /[.!?:"”’)]$/.test(prev.text);
        if (samePage && gap > lineGap * 1.5) newPara = true;
        else if (prevShort && prevEnds) newPara = true;
      }
      if (newPara) { flush(); para = { tag: 'p', text: l.text }; continue; }
      // Rejoin words hyphenated across a line break ("con-" + "tinued")
      if (/[A-Za-z]-$/.test(para.text) && /^[a-z]/.test(l.text)) para.text = para.text.slice(0, -1) + l.text;
      else para.text += ' ' + l.text;
    }
    flush();
    return blocks;
  }

  /**
   * Clean paragraphs recognized from scanned pages (OCR output): drop page numbers and
   * running headers/footers, rejoin hyphenated line breaks, and merge paragraphs that
   * continue across a page break.
   * @param {string[][]} pages  paragraph texts per page, in reading order (lines separated by \n)
   * @returns {{ tag: 'p', text: string }[]}
   */
  function ocrPagesToBlocks(pages) {
    // Work on lines: OCR often glues a running header onto the first paragraph
    const pageLines = pages.map((paras) => paras.flatMap((t, p) => t.split('\n').map((l) => l.trim()).filter(Boolean).map((text) => ({ text, p }))));
    const counts = new Map();
    for (const lines of pageLines) {
      const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => shape(l.text)));
      for (const e of edges) counts.set(e, (counts.get(e) || 0) + 1);
    }
    const repeated = new Set([...counts].filter(([k, n]) => n >= 2 && n >= pageLines.length * 0.5 && k.length < 80).map(([k]) => k));
    const blocks = [];
    for (const lines of pageLines) {
      const kept = lines.filter((l, i) => {
        const edge = i < 2 || i >= lines.length - 2;
        return !(edge && (PAGE_NUMBER.test(l.text) || repeated.has(shape(l.text))));
      });
      // Regroup lines into their paragraphs, rejoining hyphenated line breaks
      const paras = [];
      for (const l of kept) {
        const last = paras[paras.length - 1];
        if (last && last.p === l.p) {
          last.text = /[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(l.text) ? last.text.slice(0, -1) + l.text : `${last.text} ${l.text}`;
        } else paras.push({ p: l.p, text: l.text });
      }
      paras.forEach(({ text }, i) => {
        const prev = blocks[blocks.length - 1];
        // First paragraph on a page continuing a sentence from the previous page
        if (i === 0 && prev && !/[.!?:"”’)]$/.test(prev.text) && /^[a-z]/.test(text)) {
          prev.text = /[A-Za-z]-$/.test(prev.text) ? prev.text.slice(0, -1) + text : `${prev.text} ${text}`;
        } else {
          blocks.push({ tag: 'p', text: text.replace(/\s+/g, ' ').trim() });
        }
      });
    }
    return blocks;
  }

  const api = { itemsToLines, pagesToBlocks, ocrPagesToBlocks };
  root.danPdfText = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

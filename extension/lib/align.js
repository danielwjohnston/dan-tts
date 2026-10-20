// Map TTS word boundaries back to on-page word tokens.
// The service's boundary text usually equals a source word, but not always:
// punctuation is dropped, and hyphenated or element-split words can come back
// as one boundary or several. So match forward from a cursor, tolerating
// partial matches and skipping a few tokens when needed.
(function (root) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  /**
   * @param {{text:string}[]} boundaries  boundaries for one chunk, in order
   * @param {{text:string}[]} tokens      all tokens on the page/selection
   * @param {number} start                token index where this chunk begins (exact or approximate)
   * @param {number} [lookahead=8]        how many tokens to scan for each boundary
   * @returns {{ map: number[], next: number }} token index per boundary (-1 = unmatched), and the cursor after the chunk
   */
  function alignBoundaries(boundaries, tokens, start, lookahead = 8) {
    const map = [];
    let cursor = Math.max(0, start);
    for (const b of boundaries) {
      const nb = norm(b.text);
      let found = -1;
      if (nb) {
        for (let j = cursor; j < Math.min(tokens.length, cursor + lookahead); j++) {
          const nt = norm(tokens[j].text);
          if (!nt) continue;
          if (nt === nb || nt.startsWith(nb) || nb.startsWith(nt) || nt.includes(nb)) { found = j; break; }
        }
      }
      map.push(found);
      if (found >= 0) {
        const nt = norm(tokens[found].text);
        // Stay on a token the boundary only partly covered ("dan" of "dan-tts")
        cursor = nt === nb || nt.endsWith(nb) || nb.length >= nt.length ? found + 1 : found;
      }
    }
    return { map, next: cursor };
  }

  const api = { alignBoundaries, norm };
  root.danAlign = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

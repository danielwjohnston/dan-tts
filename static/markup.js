// Markup tokens typed into plain text, lowered to what each voice provider understands.
//
//   [pause]                 a 400 ms pause;  [pause 800ms]  [pause 1.5s]   (100 ms to 5 s)
//   word[say: respelling]   speak "respelling" where "word" is written   (kernel[say: Ker-nel])
//   [spell: ABC]            spell the letters out                           (spoken "A B C")
//
// Anything else in square brackets is left alone, so citations like [1] or [citation needed]
// read as they always did. A token body stays on one line and holds no brackets, so a half-typed
// token cannot swallow the paragraphs after it. Edge voices take no SSML, so a pause becomes
// punctuation (a comma, a full stop, or a paragraph break, which the tester then synthesizes as
// its own request) and a respelling replaces the word; ElevenLabs takes an inline
// <break time="0.4s" /> tag (3 s at most) and the same respellings. Azure voices are lowered
// like Edge for now; Azure takes full SSML, so real break tags (and more) can follow once the
// server passes SSML through. strip() gives the written text with the tokens removed; nothing
// displays it yet (highlighting and captions show the spoken words), it is here for the display
// and caption path to come. The *Edit helpers at the end build the edits behind the tester's
// toolbar buttons; previewSlice() picks the text a preview reads.
(function (root) {
  const PAUSE_DEFAULT = 400, PAUSE_MIN = 100, PAUSE_MAX = 5000, ELEVEN_BREAK_MAX = 3000;
  const TOKEN = /\[pause(?:[ \t]+(\d+(?:\.\d+)?)[ \t]*(ms|s))?[ \t]*\]|\[(say|spell):[ \t]*([^\[\]\n]*?)[ \t]*\]/gi;
  // The word a respelling applies to: the run before the token, split into its core and the
  // punctuation glued to its end (kept in both the written and the spoken text)
  const WORD_BEFORE = /(\S*?)([^\p{L}\p{N}\s]*)$/u;
  const PROVIDERS = ['edge', 'elevenlabs', 'azure'];
  const str = (v) => (v == null ? '' : String(v));

  /** Which provider a voice id belongs to: "eleven:<id>" is ElevenLabs, "azure:<name>" is Azure, anything else is Edge. */
  function providerOf(voice) {
    const v = str(voice);
    return /^eleven:/i.test(v) ? 'elevenlabs' : /^azure:/i.test(v) ? 'azure' : 'edge';
  }

  /** Text → segments: {type:'text', text} | {type:'pause', ms} | {type:'say', written, spoken} | {type:'spell', letters}. */
  function parse(input) {
    const text = str(input);
    const out = [];
    let last = 0;
    const pushText = (t) => { if (t) out.push({ type: 'text', text: t }); };
    for (const m of text.matchAll(TOKEN)) {
      let before = text.slice(last, m.index);
      if (m[0].toLowerCase().startsWith('[pause')) {
        pushText(before);
        let ms = m[1] ? parseFloat(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1) : PAUSE_DEFAULT;
        ms = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, Math.round(ms)));
        out.push({ type: 'pause', ms });
      } else if (m[3].toLowerCase() === 'say') {
        const w = before.match(WORD_BEFORE);
        const run = w ? w[1] : '', tail = w ? w[2] : '';
        const lead = run.match(/^[^\p{L}\p{N}]*/u)[0]; // an opening quote or bracket stays written
        const core = run.slice(lead.length);
        pushText(before.slice(0, before.length - run.length - tail.length) + lead);
        // An empty respelling leaves the word as it is; it never deletes it from the speech
        out.push({ type: 'say', written: core, spoken: m[4] || core });
        pushText(tail);
      } else {
        pushText(before);
        out.push({ type: 'spell', letters: m[4] });
      }
      last = m.index + m[0].length;
    }
    pushText(text.slice(last));
    return out;
  }

  const hasMarkup = (text) => parse(text).some((s) => s.type !== 'text');

  /** The written text with the tokens removed. Text without tokens comes back exactly as it was. */
  function strip(input) {
    const segs = parse(input);
    if (!segs.some((s) => s.type !== 'text')) return str(input);
    let out = '';
    segs.forEach((s, i) => {
      if (s.type === 'text') out += s.text;
      else if (s.type === 'say') out += s.written;
      else if (s.type === 'spell') out += s.letters;
      else {
        // A removed pause must not leave a doubled space, or a space before the punctuation that follows
        const next = segs[i + 1];
        if (next && next.type === 'text') {
          if (/^[ \t]*[,.;:!?]/.test(next.text)) out = out.replace(/[ \t]+$/, '');
          else if (/\s$/.test(out)) next.text = next.text.replace(/^[ \t]+/, '');
        }
      }
    });
    return out;
  }

  const spellOut = (letters) => letters.replace(/\s+/g, '').split('').join(' ');

  // Edge has no break tag: a short pause is a comma, a longer one a full stop, a long one a
  // paragraph break. Nothing is added after a sentence end, an ellipsis, a clause end or a dash.
  function edgePause(prev, ms) {
    if (!prev.trim()) return '';
    const endsSentence = /[.!?…]["')\]]*\s*$/.test(prev), endsClause = /[,;:\-–—]\s*$/.test(prev);
    if (ms >= 1200) return (endsSentence ? '' : '.') + '\n\n';
    if (ms >= 600) return endsSentence || endsClause ? ' ' : '. ';
    return endsSentence || endsClause ? ' ' : ', ';
  }

  const breakTag = (ms) => `<break time="${(Math.min(ELEVEN_BREAK_MAX, ms) / 1000).toFixed(2).replace(/0$/, '')}s" />`;

  /** The text a provider should be sent. */
  function lower(input, provider) {
    if (PROVIDERS.indexOf(provider) < 0) provider = providerOf(provider);
    const segs = parse(input);
    let out = '';
    segs.forEach((s, i) => {
      if (s.type === 'text') { out += s.text; return; }
      if (s.type === 'say') { out += s.spoken; return; }
      if (s.type === 'spell') { out += spellOut(s.letters); return; }
      // A pause. Punctuation written right after it belongs to the word before it: "word [pause]." → "word."
      const next = segs[i + 1];
      const glued = next && next.type === 'text' ? next.text.match(/^[ \t]*([,.;:!?]+["')\]]*)/) : null;
      if (glued) { out = out.replace(/[ \t]+$/, '') + glued[1]; next.text = next.text.slice(glued[0].length); }
      const rest = segs.slice(i + 1).some((r) => r.type !== 'text' || r.text.trim());
      if (!rest || !out.trim()) return; // nothing is spoken after it, or before it
      if (provider === 'elevenlabs') out = out.replace(/\s+$/, '') + ` ${breakTag(s.ms)} `;
      else out = out.replace(/[ \t]+$/, '') + edgePause(out, s.ms); // Edge, and Azure until SSML goes through
    });
    return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
  }

  /* ---- Toolbar edits (the tester's insert buttons) ----
     Each returns {start, end, insert, select, note}: replace text[start, end) with insert, then select
     [s, e] in the new text. insert is missing when only the selection moves; note is a line for the
     user. The tester applies them with setRangeText, so the textarea keeps its undo history. */
  const clampPos = (text, pos) => Math.min(Math.max(0, Math.floor(Number(pos) || 0)), text.length);
  const range = (text, s, e) => { s = clampPos(text, s); e = clampPos(text, e); return s <= e ? [s, e] : [e, s]; };
  // A word as the toolbar sees it: no whitespace and no brackets, so a token next to a word is not part of it
  const WORD_CHAR = /[^\s\[\]]/, WORD_RUN = /[^\s\[\]]+/g;
  const SAY_AT = /\[say:[ \t]*([^\[\]\n]*?)[ \t]*\]/iy;
  // A token sits apart from the words around it, but closing punctuation may follow it directly
  const spaceBefore = (text, pos) => (pos > 0 && !/\s/.test(text[pos - 1]) ? ' ' : '');
  const spaceAfter = (text, pos) => (pos < text.length && !/[\s,.;:!?)\]}"'’”…]/.test(text[pos]) ? ' ' : '');

  /** The token for a pause of ms milliseconds: [pause 800ms], [pause 1.5s]. */
  function pauseToken(ms) {
    ms = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, Math.round(Number(ms) || PAUSE_DEFAULT)));
    return `[pause ${ms < 1000 ? `${ms}ms` : `${ms / 1000}s`}]`;
  }

  /** Insert a pause at the caret, spaced from the words around it; the caret lands after it. */
  function pauseEdit(input, caret, ms) {
    const text = str(input);
    const at = clampPos(text, caret);
    const insert = spaceBefore(text, at) + pauseToken(ms) + spaceAfter(text, at);
    return { start: at, end: at, insert, select: [at + insert.length, at + insert.length] };
  }

  // The whitespace-free run around pos (pos may sit at either end of it), or null
  function runAround(text, pos) {
    let s = pos, e = pos;
    while (s > 0 && WORD_CHAR.test(text[s - 1])) s--;
    while (e < text.length && WORD_CHAR.test(text[e])) e++;
    return s < e ? { start: s, end: e } : null;
  }

  // A [say: …] token starting exactly at pos, with the position of its body, or null
  function sayTokenAt(text, pos) {
    SAY_AT.lastIndex = pos;
    const m = SAY_AT.exec(text);
    if (!m) return null;
    const bodyStart = pos + m[0].match(/^\[say:[ \t]*/i)[0].length;
    return { start: pos, end: pos + m[0].length, body: [bodyStart, bodyStart + m[1].length] };
  }

  /** Respell the selected word (the last one, if several) or the word at the caret: word[say: word],
      with the respelling selected to type over. A word that already has one gets its respelling selected. */
  function sayEdit(input, selStart, selEnd) {
    const text = str(input);
    const [a, b] = range(text, selStart, selEnd);
    const spans = [...text.matchAll(TOKEN)].map((m) => ({ start: m.index, end: m.index + m[0].length, say: /^\[say/i.test(m[0]) }));
    const insideToken = (pos) => spans.find((t) => t.start < pos && pos < t.end);
    const noWord = { note: 'Put the caret on a word, or select one, to respell it.' };
    let runs = a === b
      ? [runAround(text, a)].filter(Boolean)
      : [...text.slice(a, b).matchAll(WORD_RUN)].map((m) => ({ start: a + m.index, end: a + m.index + m[0].length }));
    runs = runs.filter((r) => !insideToken(r.start)); // a token's own words are not candidates
    if (!runs.length) {
      const t = insideToken(a);
      return t && t.say ? { select: sayTokenAt(text, t.start).body, note: 'Type the new respelling.' } : noWord;
    }
    const w = runAround(text, runs[runs.length - 1].start);
    const word = text.slice(w.start, w.end);
    const lead = word.match(/^[^\p{L}\p{N}]*/u)[0]; // an opening quote stays outside
    const core = word.slice(lead.length).replace(/[^\p{L}\p{N}]+$/u, ''); // so does glued punctuation
    if (!core) return noWord;
    const coreEnd = w.start + lead.length + core.length;
    const several = runs.length > 1 ? ` Several words were selected: the last one, "${core}", is the one respelled.` : '';
    const existing = sayTokenAt(text, coreEnd) || sayTokenAt(text, w.end);
    if (existing) return { select: existing.body, note: `Type the new respelling for "${core}".` + several };
    const insert = `[say: ${core}]`;
    return { start: coreEnd, end: coreEnd, insert, select: [coreEnd + 6, coreEnd + 6 + core.length], note: `Type how "${core}" should be said.` + several };
  }

  /** Wrap the selection in [spell: …], the caret after it; with nothing selected, insert [spell: ] with the caret inside. */
  function spellEdit(input, selStart, selEnd) {
    const text = str(input);
    const [s0, e0] = range(text, selStart, selEnd);
    const sel = text.slice(s0, e0);
    // The whitespace around the selection, and punctuation glued to its end, stay outside the token
    let a = s0 + sel.match(/^\s*/)[0].length, b = e0 - sel.match(/\s*$/)[0].length;
    if (a < b) b -= text.slice(a, b).match(/[,.;:!?]*$/)[0].length;
    if (a >= b) {
      // Nothing, or only whitespace, selected: an empty token to type into, spaced like a pause
      const trail = spaceAfter(text, e0);
      const insert = spaceBefore(text, s0) + '[spell: ]' + trail;
      const caret = s0 + insert.length - trail.length - 1;
      return { start: s0, end: e0, insert, select: [caret, caret] };
    }
    const letters = text.slice(a, b);
    if (/[\[\]\n]/.test(letters)) return { note: 'Spell out takes letters on one line, with no brackets.' };
    const insert = `[spell: ${letters}]`;
    return { start: a, end: b, insert, select: [a + insert.length, a + insert.length] };
  }

  /** The first `limit` characters, for a preview: cut at a word end and never inside a token. */
  function previewSlice(input, limit) {
    const text = str(input);
    if (text.length <= limit) return text;
    let cut = limit;
    for (const m of text.matchAll(TOKEN)) {
      if (m.index >= cut) break;
      if (m.index + m[0].length > cut) { cut = m.index + m[0].length; break; } // finish the token
    }
    if (cut < text.length && /\S/.test(text[cut]) && /\S/.test(text[cut - 1])) {
      let i = cut;
      while (i > 0 && /\S/.test(text[i - 1])) i--;
      if (i > limit / 2) cut = i; // a whole word, unless that loses most of the preview
    }
    return text.slice(0, cut).replace(/\s+$/, '');
  }

  const api = {
    parse, strip, lower, hasMarkup, providerOf, PAUSE_DEFAULT, PAUSE_MIN, PAUSE_MAX,
    pauseToken, pauseEdit, sayEdit, spellEdit, previewSlice,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.danMarkup = api;
})(typeof self !== 'undefined' ? self : this);

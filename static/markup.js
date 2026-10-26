// Markup tokens typed into plain text, lowered to what each voice provider understands.
//
//   [pause]                 a 400 ms pause;  [pause 800ms]  [pause 1.5s]   (100 ms to 5 s)
//   word[say: respelling]   speak "respelling" where "word" is written   (kernel[say: Ker-nel])
//   [spell: ABC]            spell the letters out                           (spoken "A B C")
//
// Anything else in square brackets is left alone, so citations like [1] or [citation needed]
// read as they always did. A token body stays on one line and holds no brackets, so a half-typed
// token cannot swallow the paragraphs after it. Edge and OpenAI voices take no SSML, so a pause
// becomes punctuation (a comma, a full stop, or a paragraph break, which the tester then
// synthesizes as its own request) and a respelling replaces the word; ElevenLabs, Azure, Google
// and Polly take an inline <break time="0.4s" /> tag (3 s at most for ElevenLabs) and the same
// respellings. strip() gives the written text with the tokens removed; nothing displays it yet
// (highlighting and captions show the spoken words), it is here for the display and caption
// path to come.
(function (root) {
  const PAUSE_DEFAULT = 400, PAUSE_MIN = 100, PAUSE_MAX = 5000, ELEVEN_BREAK_MAX = 3000;
  const TOKEN = /\[pause(?:[ \t]+(\d+(?:\.\d+)?)[ \t]*(ms|s))?[ \t]*\]|\[(say|spell):[ \t]*([^\[\]\n]*?)[ \t]*\]/gi;
  // The word a respelling applies to: the run before the token, split into its core and the
  // punctuation glued to its end (kept in both the written and the spoken text)
  const WORD_BEFORE = /(\S*?)([^\p{L}\p{N}\s]*)$/u;
  // Voice id prefix → provider (the servers route by the same prefixes); Edge ids have no prefix
  const PREFIXES = { eleven: 'elevenlabs', azure: 'azure', google: 'google', polly: 'polly', openai: 'openai' };
  const PROVIDERS = ['edge'].concat(Object.keys(PREFIXES).map((k) => PREFIXES[k]));
  // Providers that read a <break> tag inside the text; the rest get punctuation
  const BREAK_TAGS = { elevenlabs: ELEVEN_BREAK_MAX, azure: PAUSE_MAX, google: PAUSE_MAX, polly: PAUSE_MAX };
  const str = (v) => (v == null ? '' : String(v));

  /** Which provider a voice id belongs to: "eleven:<id>" is ElevenLabs, "azure:…", "google:…", "polly:…", "openai:…" theirs, anything else Edge. */
  function providerOf(voice) {
    const m = str(voice).match(/^([a-z]+):/i);
    return (m && PREFIXES[m[1].toLowerCase()]) || 'edge';
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

  const breakTag = (ms, max) => `<break time="${(Math.min(max, ms) / 1000).toFixed(2).replace(/0$/, '')}s" />`;

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
      if (!rest) return; // nothing is spoken after it
      if (BREAK_TAGS[provider]) out = out.replace(/\s+$/, '') + ` ${breakTag(s.ms, BREAK_TAGS[provider])} `;
      else out = out.replace(/[ \t]+$/, '') + edgePause(out, s.ms);
    });
    return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
  }

  const api = { parse, strip, lower, hasMarkup, providerOf, PROVIDERS, PAUSE_DEFAULT, PAUSE_MIN, PAUSE_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.danMarkup = api;
})(typeof self !== 'undefined' ? self : this);

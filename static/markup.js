// Markup tokens typed into plain text, lowered to what each voice provider understands.
//
//   [pause]                 a 400 ms pause;  [pause 800ms]  [pause 1.5s]   (100 ms to 5 s)
//   word[say: respelling]   speak "respelling" where "word" is written   (kernel[say: Ker-nel])
//   [spell: ABC]            spell the letters out                           (spoken "A B C")
//
// Anything else in square brackets is left alone, so citations like [1] or [citation needed]
// read as they always did. Edge voices take no SSML, so a pause becomes punctuation (a comma,
// a full stop, or a paragraph break for long pauses) and a respelling replaces the word;
// ElevenLabs takes an inline <break time="0.4s" /> tag (3 s at most) and the same respellings.
// strip() gives the written text with the tokens removed, for display and captions.
(function (root) {
  const PAUSE_DEFAULT = 400, PAUSE_MIN = 100, PAUSE_MAX = 5000, ELEVEN_BREAK_MAX = 3000;
  const TOKEN = /\[pause(?:\s+(\d+(?:\.\d+)?)\s*(ms|s))?\s*\]|\[(say|spell):\s*([^\]]*?)\s*\]/gi;
  const PROVIDERS = ['edge', 'elevenlabs'];

  /** Which provider a voice id belongs to: "eleven:<id>" is ElevenLabs, anything else is Edge. */
  function providerOf(voice) {
    return /^eleven:/i.test(voice || '') ? 'elevenlabs' : 'edge';
  }

  /** Text → segments: {type:'text', text} | {type:'pause', ms} | {type:'say', written, spoken} | {type:'spell', letters}. */
  function parse(text) {
    const out = [];
    let last = 0;
    const pushText = (t) => { if (t) out.push({ type: 'text', text: t }); };
    for (const m of String(text || '').matchAll(TOKEN)) {
      let before = text.slice(last, m.index);
      if (m[0].toLowerCase().startsWith('[pause')) {
        pushText(before);
        let ms = m[1] ? parseFloat(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1) : PAUSE_DEFAULT;
        ms = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, Math.round(ms)));
        out.push({ type: 'pause', ms });
      } else if (m[3].toLowerCase() === 'say') {
        // The respelling applies to the word written right before the token
        const word = before.match(/(\S+)$/);
        if (word) before = before.slice(0, before.length - word[1].length);
        pushText(before);
        out.push({ type: 'say', written: word ? word[1] : '', spoken: m[4] });
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

  /** The written text with the tokens removed (what the reader shows and captions carry). */
  function strip(text) {
    return parse(text).map((s) => s.type === 'text' ? s.text : s.type === 'say' ? s.written : s.type === 'spell' ? s.letters : '').join('')
      .replace(/[ \t]+([,.;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
  }

  const spellOut = (letters) => letters.replace(/\s+/g, '').split('').join(' ');

  // Edge has no break tag: a short pause is a comma, a longer one a full stop, a long one a
  // paragraph break (the tester and the reader already synthesize paragraphs one at a time).
  function edgePause(prev, ms) {
    const endsSentence = /[.!?]["')\]]*\s*$/.test(prev), endsClause = /[,;:]\s*$/.test(prev);
    if (ms >= 1200) return (endsSentence ? '' : '.') + '\n\n';
    if (ms >= 600) return endsSentence || endsClause ? ' ' : '. ';
    return endsSentence || endsClause ? ' ' : ', ';
  }

  /** The text a provider should be sent. */
  function lower(text, provider) {
    if (PROVIDERS.indexOf(provider) < 0) provider = providerOf(provider);
    let out = '';
    for (const s of parse(text)) {
      if (s.type === 'text') out += s.text;
      else if (s.type === 'say') out += s.spoken;
      else if (s.type === 'spell') out += spellOut(s.letters);
      else if (provider === 'elevenlabs') out = out.replace(/\s+$/, '') + ` <break time="${(Math.min(ELEVEN_BREAK_MAX, s.ms) / 1000).toFixed(1).replace(/\.0$/, '.0')}s" /> `;
      else out = out.replace(/[ \t]+$/, '') + edgePause(out, s.ms);
    }
    return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
  }

  const api = { parse, strip, lower, hasMarkup, providerOf, PAUSE_DEFAULT, PAUSE_MIN, PAUSE_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.danMarkup = api;
})(typeof self !== 'undefined' ? self : this);

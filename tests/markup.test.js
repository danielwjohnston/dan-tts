// Run with: node --test tests/markup.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parse, strip, lower, hasMarkup, providerOf } = require('../static/markup.js');

test('plain text and ordinary brackets pass through untouched', () => {
  const t = 'Turn left [1] at the mill [citation needed].';
  assert.deepStrictEqual(parse(t), [{ type: 'text', text: t }]);
  assert.strictEqual(strip(t), t);
  assert.strictEqual(lower(t, 'edge'), t);
  assert.strictEqual(lower(t, 'elevenlabs'), t);
  assert.strictEqual(hasMarkup(t), false);
  assert.strictEqual(lower('', 'edge'), '');
});

test('pause tokens parse with defaults, units and limits', () => {
  assert.deepStrictEqual(parse('a [pause] b').filter((s) => s.type === 'pause'), [{ type: 'pause', ms: 400 }]);
  assert.deepStrictEqual(parse('[pause 800ms][pause 1.5s][pause 10ms][pause 99s][PAUSE 2 s]').map((s) => s.ms), [800, 1500, 100, 5000, 2000]);
  // Not tokens: a body with brackets or a newline, a pause with an odd unit
  assert.strictEqual(hasMarkup('x[say: a [b] c] d'), false);
  assert.strictEqual(hasMarkup('kernel[say: Ker-nel\n\nNext paragraph [1] continues.'), false);
  assert.strictEqual(hasMarkup('[pause 5 min]'), false);
  // Odd inputs never throw
  assert.deepStrictEqual(parse(undefined), []);
  assert.strictEqual(strip(null), '');
  assert.strictEqual(lower(123, 'edge'), '123');
  assert.strictEqual(hasMarkup('x [pause] y'), true);
});

test('a respelling applies to the word written just before it', () => {
  assert.deepStrictEqual(parse('the kernel[say: Ker-nel] panicked'), [
    { type: 'text', text: 'the ' },
    { type: 'say', written: 'kernel', spoken: 'Ker-nel' },
    { type: 'text', text: ' panicked' },
  ]);
  assert.strictEqual(strip('the kernel[say: Ker-nel] panicked'), 'the kernel panicked');
  assert.strictEqual(lower('the kernel[say: Ker-nel] panicked', 'edge'), 'the Ker-nel panicked');
  assert.strictEqual(lower('the kernel[say: Ker-nel] panicked', 'elevenlabs'), 'the Ker-nel panicked');
  // No word before it: the respelling is simply spoken where it stands
  assert.strictEqual(lower('[say: Hello] there', 'edge'), 'Hello there');
  assert.strictEqual(strip('[say: Hello] there'), ' there');
  // Punctuation glued to the word stays, in both the written and the spoken text
  assert.strictEqual(lower('Reboot the kernel.[say: Ker-nel] Then wait.', 'edge'), 'Reboot the Ker-nel. Then wait.');
  assert.strictEqual(strip('Reboot the kernel.[say: Ker-nel] Then wait.'), 'Reboot the kernel. Then wait.');
  assert.strictEqual(lower('the kernel,[say: Ker-nel] panicked', 'elevenlabs'), 'the Ker-nel, panicked');
  assert.strictEqual(lower('"kernel"[say: Ker-nel]', 'edge'), '"Ker-nel"');
  // An empty respelling leaves the word alone instead of deleting it from the speech
  assert.strictEqual(lower('the kernel[say:] panicked', 'edge'), 'the kernel panicked');
});

test('spelling out gives spaced letters and keeps the letters for display', () => {
  assert.strictEqual(lower('Say [spell: SSML] clearly.', 'edge'), 'Say S S M L clearly.');
  assert.strictEqual(lower('Code [spell: A1 B2].', 'elevenlabs'), 'Code A 1 B 2.');
  assert.strictEqual(strip('Say [spell: SSML] clearly.'), 'Say SSML clearly.');
});

test('Edge pauses become punctuation that fits what is already there', () => {
  assert.strictEqual(lower('Turn left [pause] at the mill.', 'edge'), 'Turn left, at the mill.');
  assert.strictEqual(lower('Turn left [pause 800ms] at the mill.', 'edge'), 'Turn left. at the mill.');
  assert.strictEqual(lower('Turn left [pause 2s] at the mill.', 'edge'), 'Turn left.\n\nat the mill.');
  assert.strictEqual(lower('Stop. [pause] Go.', 'edge'), 'Stop. Go.');            // no second full stop
  assert.strictEqual(lower('Stop. [pause 2s] Go.', 'edge'), 'Stop.\n\nGo.');
  assert.strictEqual(lower('First, [pause] second.', 'edge'), 'First, second.');  // no double comma
  assert.strictEqual(strip('Turn left [pause 2s] at the mill.'), 'Turn left at the mill.');
  // Punctuation written after the pause belongs to the word before it
  assert.strictEqual(lower('and then [pause]. Next.', 'edge'), 'and then. Next.');
  assert.strictEqual(lower('word [pause 800ms], next.', 'edge'), 'word, next.');
  assert.strictEqual(lower('Wait [pause 2s]. Next.', 'edge'), 'Wait.\n\nNext.');
  assert.strictEqual(lower('and then [pause]. Next.', 'elevenlabs'), 'and then. <break time="0.4s" /> Next.');
  // An ellipsis or a dash already pauses; a pause at the start or the end says nothing
  assert.strictEqual(lower('Wait\u2026 [pause] go.', 'edge'), 'Wait\u2026 go.');
  assert.strictEqual(lower('Wait \u2014 [pause 800ms] go.', 'edge'), 'Wait \u2014 go.');
  assert.strictEqual(lower('[pause] Hello.', 'edge'), 'Hello.');
  assert.strictEqual(lower('The end [pause]', 'edge'), 'The end');
  assert.strictEqual(lower('[pause 2s]', 'edge'), '');
  assert.strictEqual(lower('The end [pause]', 'elevenlabs'), 'The end');
  assert.strictEqual(lower('[pause 1.5s] a b', 'elevenlabs'), 'a b');
});

test('ElevenLabs pauses become break tags, capped at three seconds', () => {
  assert.strictEqual(lower('Turn left [pause] at the mill.', 'elevenlabs'), 'Turn left <break time="0.4s" /> at the mill.');
  assert.strictEqual(lower('Wait [pause 1.5s] here', 'elevenlabs'), 'Wait <break time="1.5s" /> here');
  assert.strictEqual(lower('Wait [pause 5s] here', 'elevenlabs'), 'Wait <break time="3.0s" /> here');
  assert.strictEqual(lower('Wait [pause 150ms] here', 'elevenlabs'), 'Wait <break time="0.15s" /> here');
  assert.strictEqual(lower('Wait [pause 250ms] here', 'elevenlabs'), 'Wait <break time="0.25s" /> here');
  // Angle brackets typed by the user are left as they are: only the break tag is emitted
  assert.strictEqual(lower('a < b [pause] c', 'elevenlabs'), 'a < b <break time="0.4s" /> c');
});

test('lower() accepts a voice id in place of a provider name', () => {
  assert.strictEqual(providerOf('eleven:21m00Tcm4TlvDq8ikWAM'), 'elevenlabs');
  assert.strictEqual(providerOf('en-US-AriaNeural'), 'edge');
  assert.strictEqual(lower('a [pause] b', 'eleven:21m00Tcm4TlvDq8ikWAM'), 'a <break time="0.4s" /> b');
  assert.strictEqual(lower('a [pause] b', 'en-US-AriaNeural'), 'a, b');
});

test('Azure ids are their own provider, lowered like Edge for now (punctuation pauses, no tags)', () => {
  assert.strictEqual(providerOf('azure:en-US-JennyNeural'), 'azure');
  assert.strictEqual(providerOf('AZURE:en-GB-SoniaNeural'), 'azure');
  assert.strictEqual(lower('a [pause] b', 'azure:en-US-JennyNeural'), 'a, b');
  assert.strictEqual(lower('Turn left [pause 2s] at the mill.', 'azure'), 'Turn left.\n\nat the mill.');
  assert.strictEqual(lower('the kernel[say: Ker-nel] panicked', 'azure'), 'the Ker-nel panicked');
  assert.strictEqual(lower('a < b [pause] c', 'azure'), 'a < b, c');
  assert.strictEqual(strip('a [pause] b'), 'a b');
});

test('strip() returns token-free text exactly as it was, and tidies only around removed tokens', () => {
  for (const t of ['Bonjour ! Comment ça va ?', 'End.  Next sentence.', 'a , b', 'a [pause .5s] b', '  indented\n', 'x[say: a [b] c] d']) {
    assert.strictEqual(strip(t), t);
  }
  assert.strictEqual(strip('and then [pause]. Next.'), 'and then. Next.');
  assert.strictEqual(strip('one [pause] two  spaced'), 'one two  spaced');
});

/* ---- Toolbar edits ---- */
const { pauseToken, pauseEdit, sayEdit, spellEdit, previewSlice } = require('../static/markup.js');
// Apply an edit the way the tester does, and return the new text and what is selected in it
const apply = (text, edit) => {
  const out = edit.insert == null ? text : text.slice(0, edit.start) + edit.insert + text.slice(edit.end);
  return { text: out, selected: edit.select ? out.slice(edit.select[0], edit.select[1]) : null, caret: edit.select ? edit.select[0] : null };
};

test('pauseToken writes milliseconds under a second and seconds above, within the limits', () => {
  assert.deepStrictEqual([400, 800, 1500, 3000, 1250].map(pauseToken), ['[pause 400ms]', '[pause 800ms]', '[pause 1.5s]', '[pause 3s]', '[pause 1.25s]']);
  assert.strictEqual(pauseToken(10), '[pause 100ms]');
  assert.strictEqual(pauseToken(99999), '[pause 5s]');
  assert.strictEqual(pauseToken('x'), '[pause 400ms]');
  // The tokens it writes are ones the lowering reads
  assert.strictEqual(lower('a ' + pauseToken(1500) + ' b', 'elevenlabs'), 'a <break time="1.5s" /> b');
  assert.strictEqual(lower('a ' + pauseToken(400) + ' b', 'edge'), 'a, b');
});

test('pauseEdit inserts at the caret, spaced from the words around it, and puts the caret after it', () => {
  const t = 'Turn left at the mill.';
  let r = apply(t, pauseEdit(t, 9, 800));
  assert.strictEqual(r.text, 'Turn left [pause 800ms] at the mill.');
  assert.deepStrictEqual([r.caret, r.selected], [23, '']);
  r = apply(t, pauseEdit(t, 10, 1500)); // caret before a word: a space follows the token too
  assert.strictEqual(r.text, 'Turn left [pause 1.5s] at the mill.');
  assert.strictEqual(r.caret, 23);
  assert.strictEqual(apply(t, pauseEdit(t, 21, 400)).text, 'Turn left at the mill [pause 400ms].');
  assert.strictEqual(apply(t, pauseEdit(t, t.length, 3000)).text, 'Turn left at the mill. [pause 3s]');
  assert.strictEqual(apply('', pauseEdit('', 0, 800)).text, '[pause 800ms]');
  assert.strictEqual(apply(t, pauseEdit(t, 999, 800)).text, 'Turn left at the mill. [pause 800ms]'); // a caret past the end is clamped
  assert.strictEqual(apply('Hello,', pauseEdit('Hello,', 6, 800)).text, 'Hello, [pause 800ms]');
  assert.strictEqual(lower(apply(t, pauseEdit(t, 9, 800)).text, 'edge'), 'Turn left. at the mill.');
});

test('sayEdit respells the selected word, or the word at the caret, with the respelling selected', () => {
  const t = 'Turn left at the mill.';
  const want = 'Turn left at the mill[say: mill].';
  for (const [s, e] of [[17, 21], [18, 18], [17, 17], [21, 21], [19, 22]]) {
    const edit = sayEdit(t, s, e);
    const r = apply(t, edit);
    assert.strictEqual(r.text, want, `selection ${s}-${e}`);
    assert.strictEqual(r.selected, 'mill');
    assert.strictEqual(edit.note, 'Type how "mill" should be said.');
  }
  assert.strictEqual(apply(t, sayEdit(t, 21, 17)).text, want); // a backward selection
  assert.strictEqual(lower(want, 'edge'), t); // typing nothing changes nothing
  assert.strictEqual(lower(want.replace('say: mill', 'say: mil'), 'edge'), 'Turn left at the mil.');
  // Several words selected: the last one is respelled, and the note says so
  const many = sayEdit(t, 0, 22);
  assert.strictEqual(apply(t, many).text, want);
  assert.match(many.note, /Several words were selected: the last one, "mill"/);
  // Quotes and glued punctuation stay outside the token, as the lowering expects
  const q = 'Say "kernel", then wait.';
  assert.strictEqual(apply(q, sayEdit(q, 7, 7)).text, 'Say "kernel[say: kernel]", then wait.');
  assert.strictEqual(lower(apply(q, sayEdit(q, 7, 7)).text.replace('say: kernel', 'say: Ker-nel'), 'edge'), 'Say "Ker-nel", then wait.');
  // No word: nothing changes
  assert.deepStrictEqual(sayEdit('a  b', 2, 2), { note: 'Put the caret on a word, or select one, to respell it.' });
  assert.deepStrictEqual(sayEdit('', 0, 0), { note: 'Put the caret on a word, or select one, to respell it.' });
  assert.strictEqual(sayEdit('a - b', 2, 3).insert, undefined);
});

test('sayEdit on a word that already has a respelling selects the respelling instead', () => {
  const t = 'the kernel[say: Ker-nel] panicked.';
  for (const [s, e] of [[6, 6], [4, 10], [18, 18], [16, 23], [10, 10]]) {
    const edit = sayEdit(t, s, e);
    assert.strictEqual(edit.insert, undefined, `selection ${s}-${e}`);
    assert.strictEqual(t.slice(edit.select[0], edit.select[1]), 'Ker-nel');
  }
  // Across a token: the last plain word is respelled, the token's own words are not candidates
  assert.strictEqual(apply(t, sayEdit(t, 0, t.length)).text, 'the kernel[say: Ker-nel] panicked[say: panicked].');
  // An empty respelling: the caret lands inside it
  const empty = 'kernel[say:] x';
  const edit = sayEdit(empty, 2, 2);
  assert.deepStrictEqual(edit.select, [11, 11]);
  assert.strictEqual(empty.slice(0, 11), 'kernel[say:');
  // A word inside another kind of token is not a word to respell
  assert.strictEqual(sayEdit('[spell: SSML]', 9, 9).insert, undefined);
  assert.strictEqual(sayEdit('[spell: SSML]', 9, 9).select, undefined);
});

test('spellEdit wraps the selection, or inserts an empty token with the caret inside', () => {
  const t = 'Say SSML clearly.';
  let r = apply(t, spellEdit(t, 4, 8));
  assert.strictEqual(r.text, 'Say [spell: SSML] clearly.');
  assert.deepStrictEqual([r.caret, r.selected], [17, '']);
  assert.strictEqual(lower(r.text, 'edge'), 'Say S S M L clearly.');
  // Surrounding whitespace and glued punctuation stay outside the token
  assert.strictEqual(apply(t, spellEdit(t, 3, 9)).text, 'Say [spell: SSML] clearly.');
  assert.strictEqual(apply('Say SSML.', spellEdit('Say SSML.', 4, 9)).text, 'Say [spell: SSML].');
  assert.strictEqual(apply(t, spellEdit(t, 8, 4)).text, 'Say [spell: SSML] clearly.');
  // Nothing selected: an empty token, spaced from the word before, caret before the closing bracket
  r = apply('Say', spellEdit('Say', 3, 3));
  assert.strictEqual(r.text, 'Say [spell: ]');
  assert.strictEqual(r.text.slice(0, r.caret), 'Say [spell: ');
  r = apply('Say  it', spellEdit('Say  it', 4, 4));
  assert.strictEqual(r.text, 'Say [spell: ] it');
  r = apply('Say it', spellEdit('Say it', 4, 4)); // caret before a word: a space follows the token too
  assert.strictEqual(r.text, 'Say [spell: ] it');
  assert.strictEqual(r.text.slice(0, r.caret), 'Say [spell: ');
  assert.strictEqual(apply('', spellEdit('', 0, 0)).text, '[spell: ]');
  assert.strictEqual(apply('a  b', spellEdit('a  b', 1, 3)).text, 'a [spell: ] b'); // only whitespace selected: replaced
  // A body with a line break or brackets would not be a token
  assert.deepStrictEqual(spellEdit('a\nb', 0, 3), { note: 'Spell out takes letters on one line, with no brackets.' });
  assert.strictEqual(spellEdit('x [1] y', 0, 7).insert, undefined);
});

test('previewSlice keeps whole words and whole tokens', () => {
  assert.strictEqual(previewSlice('short text', 300), 'short text');
  assert.strictEqual(previewSlice('', 300), '');
  const words = 'word '.repeat(80).trim(); // 399 chars
  const cut = previewSlice(words, 300);
  assert.ok(cut.length <= 300 && cut.length >= 290, String(cut.length));
  assert.ok(cut.endsWith('word') && !words[cut.length].trim()); // ends at a word end
  // A token across the limit is finished, not cut in half
  const tok = 'a'.repeat(295) + ' [pause 800ms] more';
  assert.strictEqual(previewSlice(tok, 300), 'a'.repeat(295) + ' [pause 800ms]');
  const say = 'a'.repeat(290) + ' kernel[say: Ker-nel] more';
  assert.strictEqual(previewSlice(say, 300), 'a'.repeat(290) + ' kernel[say: Ker-nel]');
  // One very long word: cut at the limit rather than lose most of the preview
  assert.strictEqual(previewSlice('x'.repeat(500), 300).length, 300);
  assert.strictEqual(previewSlice('ab ' + 'x'.repeat(500), 300).length, 300);
});

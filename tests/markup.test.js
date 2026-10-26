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

test('strip() returns token-free text exactly as it was, and tidies only around removed tokens', () => {
  for (const t of ['Bonjour ! Comment ça va ?', 'End.  Next sentence.', 'a , b', 'a [pause .5s] b', '  indented\n', 'x[say: a [b] c] d']) {
    assert.strictEqual(strip(t), t);
  }
  assert.strictEqual(strip('and then [pause]. Next.'), 'and then. Next.');
  assert.strictEqual(strip('one [pause] two  spaced'), 'one two  spaced');
});

test('every provider is known: break tags for the SSML providers, punctuation for Edge and OpenAI', () => {
  const { PROVIDERS } = require('../static/markup.js');
  assert.deepStrictEqual(PROVIDERS, ['edge', 'elevenlabs', 'azure', 'google', 'polly', 'openai']);
  assert.strictEqual(providerOf('azure:en-US-JennyNeural'), 'azure');
  assert.strictEqual(providerOf('google:en-US-Neural2-F'), 'google');
  assert.strictEqual(providerOf('polly:Joanna'), 'polly');
  assert.strictEqual(providerOf('openai:alloy'), 'openai');
  assert.strictEqual(providerOf('OPENAI:alloy'), 'openai');
  assert.strictEqual(providerOf('bogus:thing'), 'edge');
  for (const p of ['azure', 'google', 'polly']) {
    assert.strictEqual(lower('Turn left [pause] at the mill.', p), 'Turn left <break time="0.4s" /> at the mill.', p);
    assert.strictEqual(lower('Wait [pause 5s] here', p), 'Wait <break time="5.0s" /> here', p); // the full five seconds, not ElevenLabs’ three
  }
  assert.strictEqual(lower('Turn left [pause] at the mill.', 'openai'), 'Turn left, at the mill.');
  assert.strictEqual(lower('Turn left [pause] at the mill.', 'openai:alloy'), 'Turn left, at the mill.');
  assert.strictEqual(lower('a [pause] b', 'azure:en-US-JennyNeural'), 'a <break time="0.4s" /> b');
});

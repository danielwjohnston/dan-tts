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
  assert.strictEqual(strip('[say: Hello] there'), 'there');
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
});

test('ElevenLabs pauses become break tags, capped at three seconds', () => {
  assert.strictEqual(lower('Turn left [pause] at the mill.', 'elevenlabs'), 'Turn left <break time="0.4s" /> at the mill.');
  assert.strictEqual(lower('Wait [pause 1.5s] here', 'elevenlabs'), 'Wait <break time="1.5s" /> here');
  assert.strictEqual(lower('Wait [pause 5s] here', 'elevenlabs'), 'Wait <break time="3.0s" /> here');
  // Angle brackets typed by the user are left as they are: only the break tag is emitted
  assert.strictEqual(lower('a < b [pause] c', 'elevenlabs'), 'a < b <break time="0.4s" /> c');
});

test('lower() accepts a voice id in place of a provider name', () => {
  assert.strictEqual(providerOf('eleven:21m00Tcm4TlvDq8ikWAM'), 'elevenlabs');
  assert.strictEqual(providerOf('en-US-AriaNeural'), 'edge');
  assert.strictEqual(lower('a [pause] b', 'eleven:21m00Tcm4TlvDq8ikWAM'), 'a <break time="0.4s" /> b');
  assert.strictEqual(lower('a [pause] b', 'en-US-AriaNeural'), 'a, b');
});

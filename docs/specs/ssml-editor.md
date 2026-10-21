# Spec: SSML editor

Status: Draft
Roadmap item: Medium-Term, "SSML support"

## 1. Summary

Let people shape how text is spoken (pauses, emphasis, pronunciation, speaking rate) through a small
editor in the tester and the browser extension, without writing raw SSML by hand. The editor produces
valid SSML, previews it, and sends it to the existing synthesis path.

## 2. Background

- `app/main.py` accepts `text` in `SynthesisRequest` and passes it to `edge_tts.Communicate`.
- `engine/src/tts.js` (mirrored in `extension/engine/tts.js`) builds its own SSML envelope. It wraps the
  input in `<voice>` and `<prosody>` and runs `escapeXml()` over the text.
- Result: **SSML tags in input are escaped and spoken literally today.** The `Field` description says
  "Plain text or SSML", but that is not true in practice. Fixing this is part of this spec (see §5).

## 3. Goals

1. Insert common SSML constructs without typing tags: pause, emphasis, pronunciation, rate/pitch/volume,
   and spelled-out text.
2. Preview the result with the chosen voice before generating a full file.
3. Work in both `tester.html` (server) and the extension reader (no server), from one shared module.
4. Plain text keeps working unchanged. Existing requests and exports do not change.

## 4. Non-goals

- Visual prosody editing (pitch curves, drag-to-stress). Not supported by the voice service.
- Voice-specific style tags (`mstts:express-as`). Possible later, once the base editor exists. Each
  voice exposes different styles, so this needs its own design.
- Authoring SSML for other engines.
- Full SSML 1.1 coverage. Only the subset Edge TTS handles reliably is supported (see §6).

## 5. Behaviour

### 5.1 Input model

The editor holds **plain text with inline markup tokens**, not raw XML. Users see something like:

```
Turn left at [pause 400ms] the old mill. Say [spell: SSML] clearly.
```

Tokens are stored in the editor and converted to SSML on send. This avoids users typing `<` and `>`
and makes escaping a non-issue on the input side.

### 5.2 Supported constructs

| Construct | UI | SSML output |
|---|---|---|
| Pause | Insert pause, 100 ms to 5 s | `<break time="400ms"/>` |
| Emphasis | Select text, choose strong / moderate / reduced | `<emphasis level="strong">…</emphasis>` |
| Pronunciation | Select text, enter a phonetic spelling | `<sub alias="…">…</sub>` |
| Spell out | Select text, choose "spell out" | `<say-as interpret-as="characters">…</say-as>` |
| Speaking rate | Select text, choose a % change (−50% to +100%) | `<prosody rate="…">…</prosody>` |
| Pitch / volume | Select text, choose a change | `<prosody pitch="…" volume="…">…</prosody>` |

Constructs may nest only where the target supports it (prosody can wrap emphasis; `sub` and
`say-as` are leaves).

### 5.3 Preview

- "Preview" synthesizes the current selection, or the first 300 characters if nothing is selected.
- It uses the same voice and rate controls as the rest of the UI.
- It is rate-limited client-side to one request in flight at a time.

### 5.4 Validation

- The editor refuses to produce output that is not well-formed XML. If a user enters an invalid
  pronunciation string, it is escaped and shown as a warning, not dropped.
- Total length still respects `MAX_TEXT_CHARS` (20 000) after SSML wrapping. The counter counts the
  SSML output, not the plain text, and warns before the limit.

### 5.5 Where it appears

- **Tester** (`tester.html`): a "Markup" toggle above the text box. When on, the toolbar shows the
  constructs. Export, batch, and the standalone HTML player all use the SSML-generated audio.
- **Extension** (`extension/`): a Markup option in the reader's control bar, for pages and selections.
  Word highlighting still uses the text positions from the boundary events. See §7.

### 5.6 Persistence

- The editor's markup is saved with the text in the library entry (extension) and history (tester).
- Old entries without markup load as plain text.

## 6. Technical design

### 6.1 Shared module

Add `static/ssml.js` (plain browser module, same pattern as `static/chunk-text.js`):

- `tokensToSsml(text, tokens) → string` builds SSML and escapes every literal text node.
- `ssmlToTokens(ssml) → {text, tokens}` parses the subset back into tokens, for loading saved markup.
  Anything outside the subset is kept as plain text and flagged.
- Unit tests in `tests/ssml.test.js`, run with `node --test` (same as `chunk-text.test.js`).

The extension needs its own copy or a build step. `scripts/sync-extension.mjs` already syncs shared
files into `extension/`. Use it for this file too, rather than duplicating the logic.

### 6.2 Escaping fix (required)

Today the engines escape the whole input string, so tags are literal. Two options:

- **A (recommended):** the editor sends SSML and the engines accept it. Add a `ssml: true` option to
  the request. When it is set, the engine inserts the SSML body inside `<prosody>` without escaping.
  Plain requests keep the current escaping. The Python side passes `ssml=True` through to a
  pre-wrapped body and does not rely on `edge_tts`'s own wrapping for markup.
- **B:** keep the server strict and only accept plain text. The editor then can't express anything
  the server can't already do. Rejected.

Option A needs a check that the `<voice>` and `<prosody>` wrapper still applies correctly when the body
contains its own `<prosody>` tags. Verify this in the engine feasibility harness before building the
UI.

### 6.3 Server changes (`app/main.py`)

- Add `ssml: bool = False` to `SynthesisRequest`.
- When `ssml` is true, validate the body with an XML parser against the supported subset. Reject
  unknown elements with HTTP 422.
- Pass the body to the TTS call without escaping.
- Update the `text` field description to say what the flag does.

### 6.4 Engine changes (`engine/src/tts.js`, `extension/engine/tts.js`)

- Add an `ssml` option to `synthesize()`. When true, skip `escapeXml` on the body only.
- Keep `escapeXml` on the voice name and attribute values.
- Word boundaries: SSML `break` and `say-as` change how words map to timings. Boundaries will be
  returned for text tokens only. The highlighter needs to tolerate a missing boundary for a pause.

### 6.5 Caching and output

- Preview audio is not cached on the server.
- The export path (JSON bundle, SRT, WebVTT, standalone HTML) uses the boundaries from the SSML run.
  Caption text is the **spoken text** with markup removed, not the SSML.

## 7. Open questions

1. **Highlighting accuracy around `break` and `say-as`.** Word boundary events may not map cleanly
   to the displayed text. Test with real voices before committing to highlight-in-sync for markup text.
2. **Pronunciation coverage.** Is `sub alias` honoured by every voice in the 322-voice list, or only
   some? Sample a set of voices and record results in `samples/`.
3. **Where SSML is validated.** Browser (fast feedback) and server (trust boundary) both? Proposed:
   both, with the same subset list in `static/ssml.js`.
4. **Length counting.** Does the 20 000-character limit apply to plain or SSML text? Proposed: SSML.
5. **Extension preview cost.** Each preview is a live call to the voice service. Confirm this is
   acceptable, or limit previews per minute.

## 8. Test plan

- Unit: `tokensToSsml` escapes `& < > " '` in literal text; round-trip `ssmlToTokens(tokensToSsml(x))`.
- Unit: unknown elements are rejected by the server validator, with a 422.
- Engine: a request with `ssml: false` produces the same bytes as today for the same input (regression).
- Engine: a request with `ssml: true` and a `break` produces audio longer than the plain version.
- Manual: each construct in §5.2 with at least three voices, listened to and noted in the PR.
- Manual: extension reading a page with markup in a selection; highlighting stays on the right words.
- CI: existing `python -m pytest -q` and `node --test` suites run unchanged.

## 9. Rollout

1. **Phase 1:** fix the escaping behind `ssml: true` in the engine and server, with tests. No UI.
   Useful immediately for API users.
2. **Phase 2:** shared `static/ssml.js` module and tester UI (Markup toggle, preview, validation).
3. **Phase 3:** extension Markup option and saved markup in the library.

Each phase is a separate PR, following the pattern of recent merged PRs.

## 10. Acceptance criteria

- With `ssml: true`, a pause of 1 s audibly lengthens the output compared to none.
- With `ssml: false` (default), output is byte-identical to the current implementation for the same input.
- An SSML body containing `<script>` or any element outside the subset is rejected by the server.
- A user can produce all six constructs in §5.2 from the tester without typing a tag.
- The extension and tester produce the same SSML for the same markup.

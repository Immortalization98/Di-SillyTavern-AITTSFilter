# AI TTS Filter (working name)

A SillyTavern (1.19.0+) UI extension. Before a message is read aloud, it removes
the parts that should not be spoken (thinking blocks, calculations, status bars,
option menus, memory tables...) and then hands the rest to SillyTavern's
**built-in TTS** through the registered `/speak` command, so the configured
provider, voice map, paragraph splitting and playback are all reused.

- **Deletion only.** The message is cut into numbered segments; rules decide what
  they can, and a configurable model only answers *which segment numbers to
  skip*. The program deletes those segments and checks that the result is a
  subsequence of the original, so the text is never rewritten.
- **Read-only.** The chat and the rendered messages are never modified. The
  preview renders escaped plain text, not message HTML.
- **Model** from one of: a custom OpenAI-compatible endpoint filled in in the
  settings (URL, model, key), a Connection Manager profile, or the current chat
  connection; or rules only. Requests go through SillyTavern's backend. A custom
  key is written to SillyTavern's secret store (`api_key_custom`, label
  "AI 朗读过滤") and referred to by id; the previously active custom key is
  re-activated right after, so the chat connection keeps its key. With no key
  saved, a non-existent secret id is sent so the chat key is never used for the
  filter endpoint.
- **Narration:** automatic (off by default), takeover of the message narrate
  button (on by default, switchable), wand menu item, `/aitts [n]`,
  `/aitts-preview [n]`, `/aitts-filter text`.
- **Cache:** IndexedDB per device, keyed by text hash + filter-config hash;
  stores only skipped segment ids and categories, never chat text.
- **Preview:** shows the source with skipped parts struck through and labelled.
  A correction mode lets the user tap segments to switch read / not read, read
  and remember the corrected result, or add the message as a sample.
- **Format schemes (anchoring):** 1–N samples (default limit 3, max 10), each an
  original message plus the part to read. From them the extension learns
  fixed-shape rules (tag, content tag, line prefix, bracket, key-value line;
  layout tags like `div` are never learned, broad shapes need two samples to
  start enabled), can run a one-off AI analysis that returns a short format
  note plus rules (each checked against the samples before the user adopts
  it), can attach the samples as worked examples, and back-tests against the
  samples. Schemes bind to character cards or presets (card > preset > global
  default) and are stored in extension settings.

## Layout

```
manifest.json           extension manifest (entry src/index.js, "clean" hook)
src/core/               pure modules, tested with node --test
  segmenter.js          message -> segments (tags, code fences, comments, lines, inline brackets)
  rules.js              deterministic decisions
  prompt.js             default prompt, request batches, answer parsing
  compose.js            deletion, line tidy-up, subsequence check
  pipeline.js           segment -> rules -> model -> result (model call injected)
  hash.js               cyrb53-based hashing (no crypto.subtle needed)
  scheme-rules.js       fixed-shape format rules
  anchor.js             sample labels, body alignment, rule learning, comparison
  analysis.js           AI analysis prompt and checked parsing
src/scheme.js           format schemes: storage, binding, resolution, examples
src/scheme-ui.js        scheme list, scheme editor, "add as sample"
src/settings.js         settings and config hash
src/llm.js              model call (custom endpoint / Connection Manager profile / generateRaw)
src/endpoint.js         custom endpoint: key save/clear via the secret store, model list
src/cache.js            memory + IndexedDB cache
src/filter.js           message source, cache, pipeline, failure handling
src/speaker.js          /speak hand-off, audio unlock, queue and idle detection
src/preview.js          preview popup
src/ui.js, style.css    settings panel
dev-tools/              local test helpers only (not part of the extension)
  mock-llm.mjs          OpenAI-compatible mock: role-play replies + filter answers
  mock-tts-recorder/    TTS provider that records the text it is asked to speak
```

## Tests

```bash
node --test
```

Integration testing was done in a local SillyTavern 1.19.0 instance with
`dev-tools/mock-llm.mjs` and the `mock-tts-recorder` provider.

Accuracy samples for real models: `dev-tools/eval/samples.js`. Run them inside a
SillyTavern page where the extension is installed:

```js
const { runEval } = await import('/scripts/extensions/third-party/ai-tts-filter/dev-tools/eval/run.js');
await runEval();
```

## Notes

- Native TTS settings still apply after filtering. With "Only narrate quotes" or
  "Narrate dialogues only" on, narration and description are still not read.
- In 1.19.0, `ConnectionManagerRequestService.handleDropdown()` does not show
  profiles created after start-up when there were none at start-up, so the
  settings panel builds its own profile list.
- `/speak` jobs report `messageId: null` in TTS events, and voices are looked up
  by character name (user messages use the default voice).

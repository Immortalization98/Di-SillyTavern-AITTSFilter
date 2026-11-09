# AI TTS Filter for SillyTavern

[简体中文](README.zh-CN.md)

A SillyTavern UI extension that cleans a message **before SillyTavern's built-in TTS reads it**: thinking blocks, calculations and dice checks, status bars, option menus, memory tables, variable updates and other structured blocks are left out, while story text, dialogue and description are read with your existing TTS provider and voices.

- **Deletion only.** The message is cut into numbered segments. Rules decide what they can; a model you choose only answers *which segment numbers to skip*. The extension deletes those segments and checks that the result is a subsequence of the original, so nothing is ever rewritten or added.
- **Read-only.** The chat file, the message objects and the rendered messages (including any beautification) are never modified.
- **Uses the built-in TTS.** Text is spoken through SillyTavern's own `/speak` command, so your provider, voice map, paragraph splitting and playback settings all apply.

The user interface is in Simplified Chinese.

## Contents

- [Features](#features)
- [How it compares](#how-it-compares)
- [Requirements](#requirements)
- [Install](#install)
- [Set up](#set-up)
- [Use](#use)
- [Format schemes (anchoring)](#format-schemes-anchoring)
- [Privacy and storage](#privacy-and-storage)
- [Limitations](#limitations)
- [Development](#development)
- [Roadmap](#roadmap)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Features

- **Manual narration**: takes over the narrate button on each message (can be switched off to restore the built-in behaviour), plus a wand-menu item and slash commands `/aitts [n]`, `/aitts-preview [n]`, `/aitts-filter text`.
- **Automatic narration** (off by default) with its own queue, so messages in a row don't cut each other off; reads only the new part after *Continue*.
- **Preview** of what will be read: skipped parts are struck through and labelled (rule / model / manual). A **correction mode** lets you tap segments to switch read / not read, read the corrected result and remember it.
- **Filter model**: a custom OpenAI-compatible endpoint (URL, key, model), a Connection Manager profile, or the current chat connection — or rules only, with no model at all.
- **Cache** per device (IndexedDB) that stores only skipped segment numbers, never chat text.
- **Format schemes**: teach the extension a card's or preset's format with a few samples (see below).
- Failure handling: if the model times out or answers badly, fall back to rules only, read the original, or read nothing (your choice).

## How it compares

| Project | What it does | Difference |
| --- | --- | --- |
| Built-in TTS options (skip tags, regex, quotes only) | Fixed rules | Cannot recognise untagged status lines or calculations; "skip tags" also removes story wrappers such as `<content>` |
| SillyTavern-TTS-Regex-Presets | Switches hand-written TTS regex presets per card | You write and maintain the regex; no model, no preview |
| SillyTavern-BreezeTTS2, VoiceLoom | Their own TTS pipelines with model-based emotion or speaker tags | Replace the built-in TTS instead of filtering in front of it |

## Requirements

- SillyTavern **1.19.0** or newer.
- The built-in **TTS** extension enabled with a working provider.
- For model filtering: any OpenAI-compatible chat model. A cheap, fast, non-reasoning model is enough (in our tests a "flash" class model took about 2.5 s per message).

## Install

In SillyTavern: **Extensions → Install extension**, paste the repository URL and choose whether to install for yourself or for all users. Front-end extensions need no server restart — reload the page.

Or copy the folder to `data/<user>/extensions/Di-SillyTavern-AITTSFilter/` (yourself only) or `public/scripts/extensions/third-party/` (everyone) and reload the page.

## Set up

Open the **AI 朗读过滤** panel in the extensions settings.

1. **过滤模型 (filter model)** — choose one:
   - **自定义接口 (custom endpoint)**: enter an OpenAI-compatible URL (`…/v1`), paste the key and press **保存 (save)**, enter or pick the model.
   - **已有的连接配置**: pick a Connection Manager profile.
   - **当前聊天的连接**: use the chat connection.
   Or set **过滤方式** to rules only.
2. Leave **接管消息上的朗读按钮** on, and turn on **自动朗读新消息** if you want automatic narration.
3. Note: the built-in TTS settings still apply after filtering. With *Only narrate quotes* or *Narrate dialogues only* on, narration and description are still not read — turn them off if you want them.

## Use

- Tap the narrate button on a message, or use the wand menu **AI 朗读最新消息**.
- Open **朗读预览** (filter icon in the message menu) to see what is skipped. Tap **纠错** to correct it, then **按此朗读并记住** or **加入样例**.
- The **试运行** box in the panel filters any pasted text, handy for tuning the prompt.

## Format schemes (anchoring)

Different cards and presets produce different formats. A **format scheme** learns one from a few samples:

- A sample is an original message plus the part that should be read. Add one from the preview (**纠错 → 加入样例**) or by pasting the original and the "正文". Small differences (for example words hidden by a display regex) are listed for confirmation and accepted.
- From the samples the extension learns **fixed-shape rules** (a tag, a content tag, a line prefix such as `📍` or `结算：`, a bracket type, key–value lines). Layout tags such as `div` are never learned; broad rules need two samples before they start enabled; every rule can be switched on or off.
- **AI analysis** (one call) writes a short format note and proposes rules; each rule is checked against the samples before you adopt it.
- Optionally **attach the samples** as worked examples to every request.
- **Back-test** re-filters the samples and lists what was over- or under-deleted.
- Bind a scheme to **character cards** or **presets** and rebind at any time (card > preset > global default). Samples per scheme: 3 by default, up to 10.

## Privacy and storage

- The message text is sent to the filter model you choose, through SillyTavern's backend. If that is a different provider from your chat model, one more party sees your messages.
- A custom-endpoint key is written to **SillyTavern's own secret store** (label "AI 朗读过滤") and referred to by id; the extension settings never contain the key. Saving it does not change the key your chat connection uses. With no key saved, the chat key is never sent to the filter endpoint.
- The filter cache (browser IndexedDB, per device) holds segment numbers and categories only.
- Format scheme samples are stored in your extension settings (they follow your account) and do contain the sample messages.
- Uninstalling with clean-up removes the cache, the settings and the stored filter key.

## Limitations

- Narration starts after a message is complete (no streaming narration).
- `/speak` jobs report no message id in TTS events, and voices are looked up by character name (user messages use the default voice).
- A model can still misjudge a segment; it can only delete whole segments, never change words. Use the preview and format schemes to correct it.

## Development

```bash
node --test
```

- `src/core/` — pure modules (segmenter, rules, prompt, compose, pipeline, scheme rules, anchors, analysis) with unit tests in `tests/`.
- `dev-tools/mock-llm.mjs` — local OpenAI-compatible mock (role-play replies, filter answers, analysis answers).
- `dev-tools/mock-tts-recorder/` — a test-only TTS provider that records the text it is asked to speak.
- `dev-tools/eval/` — accuracy samples for real models; run inside a SillyTavern page:
  ```js
  const { runEval } = await import('/scripts/extensions/third-party/Di-SillyTavern-AITTSFilter/dev-tools/eval/run.js');
  await runEval();
  ```

## Roadmap

- **1.1**: turn a format scheme's skip rules into built-in TTS regex, so the learned filtering keeps working even with this extension switched off.

## Acknowledgements

Designed and written by Immortalization98 together with [Claude](https://www.anthropic.com/claude) (Anthropic), using Claude Code for implementation and testing.

## License

[MIT](LICENSE) © 2026 Immortalization98

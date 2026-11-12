# Changelog / 更新日志

## 1.1.0 — 2026-11-12

- **Feedback correction** in the preview ("提意见"), carried over from the successor extension AI Voice: say in a sentence or two what the filter got wrong, and tap parts if you like. One request to the filtering model answers which parts of this message change, rules of the scheme's fixed shapes that would decide such parts from now on, and a line for the format note. Every rule is checked first: it must hit this message and must not drop anything that is read, here or in the scheme's other samples. You see the changes, can adjust them, and choose what to keep; only then is the message read and remembered, added to (or updated in) a format scheme as a sample, and the chosen rules and note saved. Rules learned this way can be switched off one by one in the scheme. The opinion and the message are sent to the filtering model's provider. Two kinds: **solidify** (described above: rules and a note for the scheme) and **add as sample** (only this message is corrected, then kept as a sample — an anchor — of the scheme; no rules or note are added, and the scheme's "附带样例" can be switched on so new messages are filtered with the samples as examples). The kind chosen last is remembered on the device.
  **意见修正**（预览里的“提意见”，从后继扩展 AI Voice 移植）：用一两句话说过滤哪里不对，也可以顺手点几段。过滤模型一次回答三样东西：这条消息哪些片段要改，以后能自动判定同类内容的规则（只能是格式方案现有的几种），以及一句格式说明。每条规则都先检查：必须在这条消息里命中，而且不能删掉这条消息和方案其他样例里要读的内容。你看过改动、可以再调整、选好要保留哪些之后，才会朗读并记住这条消息，把它作为样例加入（或更新）格式方案，并保存选中的规则和说明。这样学到的规则在方案里可以逐条关掉。意见和这条消息会发给过滤模型的服务商。分两种：**固化**（就是上面说的，存成方案的规则和说明）和 **补充样例**（只改这条消息，改好后存为方案的样例，也就是锚点；不新增规则和说明，可以顺手打开方案的“附带样例”，让新消息过滤时参考样例）。上次选的方式记在本设备上。

## 1.0.2 — 2026-11-10

- The default max output is now 8,192 tokens (was 1,024). Thinking models count their reasoning against it, and 1,024 was often used up before any answer, so AI analysis and filtering failed. Settings still on the old 1,024 default are raised once; any other value you set is kept.
  “最大输出”默认改为 8192（原来 1024）。思考模型的思考也算在里面，1024 常常在给出正文前就用完了，AI 分析和过滤因此失败。仍是旧默认值 1024 的设置会自动升级一次；你改过的其他值保持不变。
- The default timeout is now 60 seconds (was 30), since thinking models take longer to answer. Settings still on the old 30 are raised once.
  默认超时改为 60 秒（原来 30 秒），思考模型回答得更慢。仍是旧默认值 30 的设置会自动升级一次。
- When the answer is empty or cut off, the error now says so and points to the max output setting, instead of only "no JSON in the answer".
  回答为空或被截断时，报错会直接说明，并提示调高“最大输出”，不再只显示“模型回答里没有 JSON”。

## 1.0.1 — 2026-11-10

- The length limit for a sample's original text is now a setting (default 50,000 characters, up to 200,000); 6,000 was too low for messages with CSS beautification.
  样例原文的字数上限改为可调的设置（默认 5 万字，最多 20 万）；原来的 6000 字放不下带 CSS 美化的消息。
- AI analysis collapses long "not read" blocks (for example a whole `<style>` block) into one line with a count, so long samples stay cheap to analyse.
  AI 分析时，把连续的“不读”长块（比如整段 `<style>`）合并成一行并注明段数，长样例也不会多花很多字数。

## 1.0.0 — 2026-11-10

First release. / 首个版本。

- Filters thinking, calculation, status, option, memory and variable blocks out of a message before SillyTavern's built-in TTS reads it; deletion only, the chat is never modified.
  在酒馆自带朗读之前去掉思考、计算、状态、选项、记忆、变量等结构块；只删不改，不修改聊天。
- Rules plus a model that only returns segment numbers; custom OpenAI-compatible endpoint (key kept in SillyTavern's secret store), Connection Manager profile, chat connection, or rules only.
  规则加模型，模型只返回片段编号；过滤模型可用自定义接口（密钥存在酒馆密钥库）、连接配置、聊天连接，或只用规则。
- Manual narration (narrate button takeover, wand menu, slash commands), optional automatic narration with a queue, preview with correction mode, per-device cache without chat text.
  手动朗读（接管朗读按钮、魔杖菜单、斜杠命令），可选的自动朗读与排队，带纠错模式的预览，不存原文的本机缓存。
- Format schemes: samples (original + 正文, tolerant of words hidden by display regex), learned fixed-shape rules, one-off AI analysis, optional worked examples, back-test; bound to character cards or presets.
  格式方案：样例（原文 + 正文，容忍显示正则隐藏的字）、自动学出的固定形式规则、一次性 AI 分析、可选的附带样例、回测；可绑定角色卡或预设。
- Tested with SillyTavern 1.19.0; unit tests on Node 20 / 22 / 24.
  已在 SillyTavern 1.19.0 上测试；单元测试覆盖 Node 20 / 22 / 24。

# Changelog / 更新日志

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

## Planned / 计划

- 1.1: turn a format scheme's skip rules into built-in TTS regex, so the filtering keeps working even with the extension switched off.
  1.1：把格式方案的跳过规则固化成酒馆自带朗读的正则，关闭扩展后也能继续生效。

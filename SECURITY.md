# Security policy / 安全策略

This project is a SillyTavern **UI extension**: it runs in the browser with the same rights as SillyTavern's own pages.
本项目是 SillyTavern 的**前端扩展**，在浏览器里以酒馆页面本身的权限运行。

## Reporting a vulnerability / 报告漏洞

Please **do not** open a public issue for security problems. Use GitHub's private reporting (**Security → Report a vulnerability**) or contact the repository owner.
请**不要**为安全问题公开提 issue。请使用 GitHub 的私密报告功能（**Security → Report a vulnerability**），或直接联系仓库所有者。

Please include the SillyTavern version, the extension version and steps to reproduce.
请附上酒馆版本、扩展版本和复现步骤。

## Scope / 范围

In scope: sending the chat connection's key to the filter endpoint; storing a key outside SillyTavern's secret store; script injection through message text, sample text, model output, scheme or card names; modifying chat data or rendered messages; reading another user's data.

范围内：把聊天连接的密钥发给过滤接口；把密钥存到酒馆密钥库以外的地方；通过消息原文、样例、模型输出、方案名或卡名注入脚本；修改聊天数据或页面上的消息；读取其他用户的数据。

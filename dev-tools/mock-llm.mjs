// Local-only mock of an OpenAI-compatible endpoint, for integration tests.
// - Chat requests get a role-play reply with thinking, status and calculation blocks.
// - Filter requests (recognized by the extension's system prompt) get a JSON skip list.
// Control: GET /__mode?filter=ok|broken|slow|all   GET /__log   GET /__reset
// Usage: node dev-tools/mock-llm.mjs [port=8020]
import http from 'node:http';

const port = Number(process.argv[2] || 8020);
let filterMode = 'ok';
let feedbackMode = 'ok';
let chatCounter = 0;
/** @type {any[]} */
const log = [];

const replies = [
    [
        '<thinking>',
        '用户走进了酒馆。我要先描写环境，再让店主开口，最后更新好感度。',
        '</thinking>',
        '<content>',
        '炉火噼啪作响，店主从吧台后抬起头。',
        '“欢迎光临，旅人。外面雨很大吧？”她把一杯热茶推到你面前。【好感度+5】',
        '力量检定：d20=14，加值+2，合计16，难度15，成功。',
        '你推开那扇沉重的木门，走进了后院。',
        '</content>',
        '<状态栏>',
        '时间：夜晚 | 地点：酒馆',
        'HP：100/100',
        '</状态栏>',
    ].join('\n'),
    [
        '雨声渐渐小了。',
        '“要不要留下来过夜？”她低声问。',
        '[时间：深夜 | 天气：小雨]',
        '',
        '| 物品 | 数量 |',
        '|---|---|',
        '| 热茶 | 1 |',
        '',
        '计算：住宿 2 晚 × 30 铜币 = 60 铜币',
        '———',
        '> 选项：A. 留下 B. 离开',
    ].join('\n'),
];

function isFilterRequest(body) {
    return body.messages?.some(m => m.role === 'system' && String(m.content).includes('朗读前的文本整理员'));
}

function filterAnswer(body) {
    const user = String(body.messages?.filter(m => m.role === 'user').pop()?.content ?? '');
    const skip = { status: [], calc: [], menu: [] };
    let count = 0;
    for (const line of user.split('\n')) {
        const m = line.match(/^\[(\d+)\] (.*)$/);
        if (!m) continue;
        count++;
        const n = Number(m[1]);
        const text = m[2];
        if (/检定|计算|×|=/.test(text)) skip.calc.push(n);
        else if (/^[【[]|好感|HP|时间：/.test(text)) skip.status.push(n);
        else if (/选项/.test(text)) skip.menu.push(n);
    }
    if (filterMode === 'broken') return '抱歉，我无法完成这个请求。';
    if (filterMode === 'all') return JSON.stringify({ skip: Array.from({ length: count }, (_, i) => i + 1) });
    return '```json\n' + JSON.stringify({ skip }) + '\n```';
}

http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/__mode') {
        if (url.searchParams.has('fb')) feedbackMode = url.searchParams.get('fb') || 'ok';
        else filterMode = url.searchParams.get('filter') || 'ok';
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ filterMode }));
    }
    if (url.pathname === '/__log') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(log, null, 2));
    }
    if (url.pathname === '/__reset') {
        log.length = 0;
        chatCounter = 0;
        res.writeHead(200);
        return res.end('ok');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }, { id: 'mock-filter', object: 'model' }] }));
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/v1/chat/completions')) {
        res.writeHead(404);
        return res.end();
    }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (body.messages?.some(m => m.role === 'system' && String(m.content).includes('纠错助手'))) {
            // Feedback correction: "key：value | key：value" lines that are read become status,
            // 『』 lines that are not read become read; proposes a good, a too broad and an unsafe rule.
            const user = String(body.messages.at(-1)?.content ?? '');
            const read = [];
            const status = [];
            for (const line of user.split('\n')) {
                const m = /^(\d+)(?:-\d+)?\. 【(读|不读[^】]*)】(?:（用户已改）)? (?:‹[^›]*› )?(.*)$/.exec(line);
                if (!m) continue;
                const n = Number(m[1]);
                if (m[2] === '读' && /^【?[^：|]{1,12}：[^|]*\|/.test(m[3])) status.push(n);
                if (m[2] !== '读' && m[3].startsWith('『')) read.push(n);
            }
            const content = feedbackMode === 'broken' ? '我觉得你说得对。' : JSON.stringify({
                read,
                skip: { status },
                rules: [{ type: 'kv' }, { type: 'bracket', open: '【' }, { type: 'prefix', value: '“' }],
                note: '『』包着的是角色心声，要读；“名称：数值 | 名称：数值”的行是状态栏。',
            });
            log.push({ kind: 'feedback', at: new Date().toISOString(), messages: body.messages, answer: content });
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        }
        if (body.messages?.some(m => m.role === 'system' && String(m.content).includes('格式分析员'))) {
            // Analysis of anchor samples: a fixed answer with one good and one bad rule.
            const content = JSON.stringify({
                note: '测试说明：📍 和 ❤️ 开头的行是状态栏，“结算：”开头的是计算过程。',
                rules: [{ type: 'prefix', value: '📍' }, { type: 'prefix', value: '她' }, { type: 'regex', value: '.*' }],
            });
            log.push({ kind: 'analysis', at: new Date().toISOString(), messages: body.messages, answer: content });
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        }
        if (isFilterRequest(body)) {
            const entry = {
                kind: 'filter', at: new Date().toISOString(), model: body.model, stream: body.stream,
                temperature: body.temperature, max_tokens: body.max_tokens, messages: body.messages, mode: filterMode,
            };
            log.push(entry);
            console.log(`${entry.at} filter model=${body.model} temp=${body.temperature} max=${body.max_tokens} mode=${filterMode}`);
            const delay = filterMode === 'slow' ? 40_000 : 500;
            const timer = setTimeout(() => {
                const content = filterAnswer(body);
                entry.answer = content;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
            }, delay);
            res.on('close', () => clearTimeout(timer));
            return;
        }

        const reply = replies[chatCounter++ % replies.length];
        log.push({ kind: 'chat', at: new Date().toISOString(), stream: body.stream });
        console.log(`${new Date().toISOString()} chat stream=${body.stream}`);
        if (!body.stream) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunks = reply.match(/[\s\S]{1,12}/g) ?? [];
        let i = 0;
        const timer = setInterval(() => {
            if (i < chunks.length) {
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunks[i++] } }] })}\n\n`);
            } else {
                clearInterval(timer);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        }, 40);
        res.on('close', () => clearInterval(timer));
    });
}).listen(port, '127.0.0.1', () => console.log(`mock llm on ${port}`));

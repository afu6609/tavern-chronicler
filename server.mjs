// st-claude-bridge — SillyTavern ↔ Claude Agent SDK 代理
// ST 把这里当 OpenAI 兼容后端连；回复由 Agent SDK 生成（走 Claude Code 登录态），
// 每次回复完成后，后台 agent 异步更新 ./memory 下的战役记忆文件。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9377);

// 可选模型（全名）。ST 界面里选哪个，请求就用哪个；未选或不认识时回退到 DEFAULT_MODEL。
const MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-0',
];
const DEFAULT_MODEL = process.env.BRIDGE_MODEL || 'claude-sonnet-5';
// 记忆更新任务用的模型（默认与回复模型解耦，可用便宜些的档位）
const MEMORY_MODEL = process.env.MEMORY_MODEL || DEFAULT_MODEL;
const MEMORY_ROOT = path.join(ROOT, 'memory');
const RECENT_TURNS = Number(process.env.RECENT_TURNS || 40); // 保留的最近对话轮数，更早的靠记忆文件
fs.mkdirSync(MEMORY_ROOT, { recursive: true });

// ---------- 记忆 ----------
function readMemory() {
  const files = fs.readdirSync(MEMORY_ROOT).filter(f => f.endsWith('.md')).sort();
  const parts = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(MEMORY_ROOT, f), 'utf8').trim();
    if (text) parts.push(`### ${f}\n${text}`);
  }
  if (!parts.length) return '';
  return `\n\n<campaign_memory>\n以下是由记忆管理器维护的战役档案，是比早期对话原文更权威的当前状态来源：\n\n${parts.join('\n\n')}\n</campaign_memory>`;
}

let memoryJobRunning = false;
async function updateMemory(lastUserText, replyText) {
  if (memoryJobRunning) return; // 跳过重叠任务，下一轮会补上
  memoryJobRunning = true;
  const startedAt = Date.now();
  try {
    const prompt = [
      '你是 DnD 战役的记忆管理器。根据下面这一轮最新交互，更新当前目录下的战役档案（Markdown 文件）。',
      '维护这些文件（不存在则创建）：',
      '- world_state.md：时间/地点/天气/当前任务与目标',
      '- party.md：队伍成员的 HP、状态、装备、金钱账本',
      '- npc_ledger.md：出场 NPC 的态度、承诺、已知信息',
      '- timeline.md：按事件压缩的编年史（追加，不重写历史）',
      '- foreshadowing.md：未回收的伏笔与悬念',
      '只记录本轮新增或变化的信息；保持每个文件精炼（超过约 200 行时压缩旧内容）。',
      '',
      '<latest_user_turn>', lastUserText.slice(0, 8000), '</latest_user_turn>',
      '<latest_reply>', replyText.slice(0, 16000), '</latest_reply>',
    ].join('\n');

    for await (const msg of query({
      prompt,
      options: {
        model: MEMORY_MODEL,
        cwd: MEMORY_ROOT,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',
        settingSources: [],
        maxTurns: 15,
      },
    })) {
      if (msg.type === 'result') {
        console.log(`[memory] 更新完成 (${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${msg.num_turns} turns)`);
      }
    }
  } catch (e) {
    console.error('[memory] 更新失败:', e.message);
  } finally {
    memoryJobRunning = false;
  }
}

// ---------- 提示构建 ----------
function buildPrompt(body) {
  const messages = body.messages || [];
  const systemParts = [];
  const turns = [];
  for (const m of messages) {
    const content = typeof m.content === 'string'
      ? m.content
      : (m.content || []).map(c => c.text || '').join('\n');
    if (m.role === 'system') systemParts.push(content);
    else turns.push({ role: m.role, content });
  }
  // 历史截断：早期对话交给记忆档案，正文只带最近 N 轮
  const recent = turns.slice(-RECENT_TURNS);
  const dropped = turns.length - recent.length;
  const transcript = recent
    .map(t => (t.role === 'assistant' ? `[GM]\n${t.content}` : `[玩家]\n${t.content}`))
    .join('\n\n');

  const systemPrompt = systemParts.join('\n\n') + readMemory();
  const prompt = [
    dropped > 0 ? `（更早的 ${dropped} 条对话已归档进战役记忆，见 system 中的 campaign_memory）` : '',
    '<transcript>', transcript, '</transcript>',
    '',
    '以 GM 身份直接续写下一条回复。只输出回复正文，不要输出任何解释或前缀。',
  ].filter(Boolean).join('\n');

  const lastUser = [...turns].reverse().find(t => t.role === 'user');
  return { systemPrompt, prompt, lastUserText: lastUser ? lastUser.content : '' };
}

// ---------- SDK 调用 ----------
async function* generate(model, systemPrompt, prompt) {
  const q = query({
    prompt,
    options: {
      model,
      systemPrompt,
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      includePartialMessages: true,
      cwd: MEMORY_ROOT,
    },
  });
  for await (const msg of q) {
    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        yield ev.delta.text;
      }
    } else if (msg.type === 'result' && msg.subtype !== 'success') {
      throw new Error(`SDK result: ${msg.subtype}`);
    }
  }
}

// ---------- OpenAI 兼容层 ----------
function sseChunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

async function handleChat(req, res, body) {
  const { systemPrompt, prompt, lastUserText } = buildPrompt(body);
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2);
  const stream = body.stream !== false;
  const model = MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;
  let full = '';
  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(sseChunk(id, model, { role: 'assistant', content: '' }));
      for await (const text of generate(model, systemPrompt, prompt)) {
        full += text;
        res.write(sseChunk(id, model, { content: text }));
      }
      res.write(sseChunk(id, model, {}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      for await (const text of generate(model, systemPrompt, prompt)) full += text;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    }
    console.log(`[chat] 回复 ${full.length} 字符 (${model})`);
    if (full) updateMemory(lastUserText, full); // 不阻塞，后台跑
  } catch (e) {
    console.error('[chat] 失败:', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'bridge_error' } }));
    } else {
      res.end();
    }
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map(id => ({ id, object: 'model', owned_by: 'st-claude-bridge' })) }));
    return;
  }
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { handleChat(req, res, JSON.parse(raw)); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json: ' + e.message } }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`st-claude-bridge listening on http://127.0.0.1:${PORT}/v1  (default: ${DEFAULT_MODEL}, memory model: ${MEMORY_MODEL}, memory: ${MEMORY_ROOT})`);
});

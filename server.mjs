// st-claude-bridge — SillyTavern ↔ Claude Agent SDK 代理
// ST 把这里当 OpenAI 兼容后端连；回复由 Agent SDK 生成（走 Claude Code 登录态），
// 每次回复完成后，后台 agent 异步更新对应战役目录下的记忆文件。
// 战役识别不依赖任何配置：按对话指纹（各轮内容哈希与已存档战役的重合度）自动匹配，
// 同一张卡开多个聊天也会各自落到独立档案；ST 因上下文上限截掉早期消息也不影响匹配。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
const MEMORY_ROOT = process.env.MEMORY_ROOT || path.join(ROOT, 'memory');
const CAMPAIGNS_ROOT = path.join(MEMORY_ROOT, 'campaigns');
const RECENT_TURNS = Number(process.env.RECENT_TURNS || 40); // 保留的最近对话轮数，更早的靠记忆文件
// 结尾续写指令。默认保持中性：视角/人称/角色分配完全交给预设决定，桥不越权指定身份。
const CONTINUE_PROMPT = process.env.CONTINUE_PROMPT
  || '衔接 transcript 最后一条消息，遵循 system 中的全部设定（包括视角、人称、文风与角色分配），自然地续写下一条回复。只输出回复正文，不要输出任何解释或前缀。';
fs.mkdirSync(CAMPAIGNS_ROOT, { recursive: true });

// ---------- 战役库 ----------
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const turnHash = t => sha1(t.role + '\x00' + (t.content || '').trim());

const campaigns = new Map(); // id -> campaign

function makeCampaign(id, meta, transcript) {
  const c = {
    id,
    dir: path.join(CAMPAIGNS_ROOT, id),
    meta,
    transcript,       // 完整对话 [{role, content}]，与 ST 端和解后的权威版本
    hashes: [],
    hashSet: null,
    pendingNotes: [], // 待转交记忆 agent 的修正说明（如重roll弃用的回复）
    memoryJobRunning: false,
  };
  refreshHashes(c);
  return c;
}

function refreshHashes(c) {
  c.hashes = c.transcript.map(turnHash);
  c.hashSet = new Set(c.hashes);
}

function saveCampaign(c) {
  fs.mkdirSync(c.dir, { recursive: true });
  fs.writeFileSync(
    path.join(c.dir, 'transcript.jsonl'),
    c.transcript.map(t => JSON.stringify(t)).join('\n') + (c.transcript.length ? '\n' : ''),
  );
  fs.writeFileSync(path.join(c.dir, 'meta.json'), JSON.stringify(c.meta, null, 2));
}

function loadCampaigns() {
  // v1 单战役布局迁移：根目录散落的 .md 归入 legacy 战役，由下一个 >2 轮的对话认领
  const rootMd = fs.readdirSync(MEMORY_ROOT).filter(f => f.endsWith('.md'));
  if (rootMd.length) {
    const id = 'legacy-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = path.join(CAMPAIGNS_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of rootMd) fs.renameSync(path.join(MEMORY_ROOT, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(
      { createdAt: Date.now(), lastSeen: Date.now(), adoptNextChat: true }, null, 2));
    console.log(`[campaign] 检测到旧版单战役档案，已迁移到 campaigns/${id}，将由下一个进行中的对话自动认领`);
  }
  for (const id of fs.readdirSync(CAMPAIGNS_ROOT)) {
    const dir = path.join(CAMPAIGNS_ROOT, id);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); }
      catch { meta = { createdAt: Date.now(), lastSeen: 0 }; }
      let transcript = [];
      const tp = path.join(dir, 'transcript.jsonl');
      if (fs.existsSync(tp)) {
        transcript = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      }
      campaigns.set(id, makeCampaign(id, meta, transcript));
    } catch (e) {
      console.error(`[campaign] 加载 ${id} 失败:`, e.message);
    }
  }
}

function createCampaign(firstUserText) {
  const id = 'c-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    + '-' + Math.random().toString(36).slice(2, 6);
  const c = makeCampaign(id, {
    createdAt: Date.now(),
    lastSeen: Date.now(),
    title: (firstUserText || '').slice(0, 40),
  }, []);
  campaigns.set(id, c);
  console.log(`[campaign] 新战役 ${id}`);
  return c;
}

// 指纹匹配规则：
// - 长对话（≥3 轮）：命中 min(3, 轮数-1) 条即续接。命中里必然含生成的 GM 回复，
//   等于同一聊天的唯一指纹（最后一条用户消息总是新的，所以阈值按 轮数-1 封顶）。
// - 短对话（≤2 轮，开场阶段）：要求全部命中且目标战役同样年轻（存档 ≤ 轮数+1），
//   用来区分"重roll第一条回复"和"用同一开场白开的新聊天"。
function resolveCampaign(turns) {
  const hashes = turns.map(turnHash);
  const scored = [...campaigns.values()]
    .map(c => ({ c, n: hashes.reduce((s, h) => s + (c.hashSet.has(h) ? 1 : 0), 0) }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n || (b.c.meta.lastSeen || 0) - (a.c.meta.lastSeen || 0));
  const best = scored[0];
  const ok = best && (hashes.length <= 2
    ? best.n === hashes.length && best.c.transcript.length <= hashes.length + 1
    : best.n >= Math.min(3, hashes.length - 1));
  if (ok) {
    console.log(`[campaign] 续接 ${best.c.id}（${best.n}/${hashes.length} 轮吻合）`);
    return best.c;
  }
  const legacy = [...campaigns.values()].find(c => c.meta.adoptNextChat);
  if (legacy && turns.length > 2) {
    delete legacy.meta.adoptNextChat;
    console.log(`[campaign] 旧档案 ${legacy.id} 认领当前对话`);
    return legacy;
  }
  const firstUser = turns.find(t => t.role === 'user');
  return createCampaign(firstUser && firstUser.content);
}

// 把本次请求的对话与存档和解：在存档里找 incoming[0] 的锚点（取后续连续吻合最长的那个），
// 锚点之前的存档保留（ST 截断掉的早期历史），锚点之后以 incoming 为准（覆盖被重roll的尾部）。
// 返回被覆盖掉的旧 GM 回复，供记忆 agent 修正档案。
function reconcile(campaign, incoming) {
  const stored = campaign.transcript;
  const storedH = campaign.hashes;
  const incH = incoming.map(turnHash);
  if (!stored.length) return { transcript: incoming.slice(), discarded: [] };
  let bestI = -1, bestRun = 0;
  for (let i = 0; i < stored.length; i++) {
    if (storedH[i] !== incH[0]) continue;
    let run = 0;
    while (run < incH.length && i + run < stored.length && storedH[i + run] === incH[run]) run++;
    if (run > bestRun) { bestRun = run; bestI = i; }
  }
  if (bestI === -1) {
    // 找不到锚点（如首条被编辑）：谁更长信谁
    return { transcript: incH.length >= storedH.length ? incoming.slice() : stored, discarded: [] };
  }
  const discarded = stored.slice(bestI + bestRun).filter(t => t.role === 'assistant');
  return { transcript: stored.slice(0, bestI).concat(incoming), discarded };
}

// ---------- 记忆 ----------
function readMemory(campaign) {
  if (!fs.existsSync(campaign.dir)) return '';
  const files = fs.readdirSync(campaign.dir).filter(f => f.endsWith('.md')).sort();
  const parts = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(campaign.dir, f), 'utf8').trim();
    if (text) parts.push(`### ${f}\n${text}`);
  }
  if (!parts.length) return '';
  return `\n\n<campaign_memory>\n以下是由记忆管理器维护的战役档案，是比早期对话原文更权威的当前状态来源：\n\n${parts.join('\n\n')}\n</campaign_memory>`;
}

async function updateMemory(campaign, lastUserText, replyText) {
  if (campaign.memoryJobRunning) {
    console.log(`[memory] ${campaign.id} 上一轮任务未结束，本轮跳过`);
    return;
  }
  campaign.memoryJobRunning = true;
  const notes = campaign.pendingNotes.splice(0);
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
      '完整对话原文在 transcript.jsonl（每行一条 JSON，只读，不要修改它和 meta.json），需要核对旧细节时可用 Read/Grep 查证。',
      ...(notes.length
        ? ['', '<corrections>', '以下修正优先处理：', ...notes, '</corrections>']
        : []),
      '',
      '<latest_user_turn>', lastUserText.slice(0, 8000), '</latest_user_turn>',
      '<latest_reply>', replyText.slice(0, 16000), '</latest_reply>',
    ].join('\n');

    for await (const msg of query({
      prompt,
      options: {
        model: MEMORY_MODEL,
        cwd: campaign.dir,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',
        settingSources: [],
        maxTurns: 15,
      },
    })) {
      if (msg.type === 'result') {
        console.log(`[memory] ${campaign.id} 更新完成 (${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${msg.num_turns} turns)`);
      }
    }
  } catch (e) {
    campaign.pendingNotes.unshift(...notes); // 失败不丢修正，下一轮补上
    console.error(`[memory] ${campaign.id} 更新失败:`, e.message);
  } finally {
    campaign.memoryJobRunning = false;
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
  const lastUser = [...turns].reverse().find(t => t.role === 'user');
  const lastUserText = lastUser ? lastUser.content : '';

  let campaign = null;
  if (turns.length) {
    campaign = resolveCampaign(turns);
    const { transcript, discarded } = reconcile(campaign, turns);
    campaign.transcript = transcript;
    refreshHashes(campaign);
    campaign.meta.lastSeen = Date.now();
    if (!campaign.meta.title) {
      const firstUser = turns.find(t => t.role === 'user');
      if (firstUser) campaign.meta.title = firstUser.content.slice(0, 40);
    }
    if (discarded.length) {
      fs.mkdirSync(campaign.dir, { recursive: true });
      fs.appendFileSync(
        path.join(campaign.dir, 'discarded.jsonl'),
        discarded.map(t => JSON.stringify({ ...t, discardedAt: Date.now() })).join('\n') + '\n',
      );
      const excerpt = discarded.map(t => (t.content || '').slice(0, 300)).join('\n---\n');
      campaign.pendingNotes.push(
        `玩家重新生成或编辑了对话，以下旧回复（节选）已被弃用；若档案里记录了其中已不成立的内容，请修订：\n${excerpt}`,
      );
      console.log(`[campaign] ${campaign.id} 检测到重roll/编辑，${discarded.length} 条旧回复弃用`);
    }
    saveCampaign(campaign);
  }

  // 历史截断：早期对话交给记忆档案，正文只带最近 N 轮
  const recent = turns.slice(-RECENT_TURNS);
  const dropped = turns.length - recent.length;
  const transcriptText = recent
    .map(t => (t.role === 'assistant' ? `[assistant]\n${t.content}` : `[user]\n${t.content}`))
    .join('\n\n');

  const systemPrompt = systemParts.join('\n\n') + (campaign ? readMemory(campaign) : '');
  const prompt = [
    dropped > 0 ? `（更早的 ${dropped} 条对话已归档进战役记忆，见 system 中的 campaign_memory）` : '',
    '<transcript>', transcriptText, '</transcript>',
    '',
    CONTINUE_PROMPT,
  ].filter(Boolean).join('\n');

  return { campaign, systemPrompt, prompt, lastUserText };
}

// ---------- SDK 调用 ----------
async function* generate(model, systemPrompt, prompt, cwd) {
  const q = query({
    prompt,
    options: {
      model,
      systemPrompt,
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      includePartialMessages: true,
      cwd,
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
  const { campaign, systemPrompt, prompt, lastUserText } = buildPrompt(body);
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2);
  const stream = body.stream !== false;
  const model = MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;
  const cwd = campaign ? campaign.dir : MEMORY_ROOT;
  let full = '';
  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(sseChunk(id, model, { role: 'assistant', content: '' }));
      for await (const text of generate(model, systemPrompt, prompt, cwd)) {
        full += text;
        res.write(sseChunk(id, model, { content: text }));
      }
      res.write(sseChunk(id, model, {}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      for await (const text of generate(model, systemPrompt, prompt, cwd)) full += text;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    }
    console.log(`[chat] 回复 ${full.length} 字符 (${model}${campaign ? ', ' + campaign.id : ''})`);
    if (campaign && full) {
      // 立刻归档本条回复，不等 ST 的下一次请求
      campaign.transcript.push({ role: 'assistant', content: full });
      refreshHashes(campaign);
      saveCampaign(campaign);
      updateMemory(campaign, lastUserText, full); // 不阻塞，后台跑
    }
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

loadCampaigns();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`st-claude-bridge listening on http://127.0.0.1:${PORT}/v1  (default: ${DEFAULT_MODEL}, memory model: ${MEMORY_MODEL}, campaigns: ${campaigns.size}, memory: ${MEMORY_ROOT})`);
});

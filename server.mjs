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
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9377);
const MEMORY_ROOT = process.env.MEMORY_ROOT || path.join(ROOT, 'memory');
const CAMPAIGNS_ROOT = path.join(MEMORY_ROOT, 'campaigns');
fs.mkdirSync(CAMPAIGNS_ROOT, { recursive: true });

// ---------- 日志环形缓冲与广播 ----------
// console 输出照常打到控制台，同时进环形缓冲并推给管理面板（ST 扩展）；
// 面板连上时先回放缓冲，之后实时接收。
const LOG_RING_MAX = 400;
const logRing = [];
const adminClients = new Set();
function broadcastAdmin(obj) {
  if (!adminClients.size) return;
  const s = JSON.stringify(obj);
  for (const c of adminClients) if (c.readyState === 1) c.send(s);
}
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    const text = args.map(a => (typeof a === 'string' ? a : a?.stack || String(a))).join(' ');
    logRing.push({ type: 'log', level, text, ts: Date.now() });
    if (logRing.length > LOG_RING_MAX) logRing.shift();
    broadcastAdmin(logRing[logRing.length - 1]);
  };
}

// 可选模型（全名）。ST 界面里选哪个，请求就用哪个；未选或不认识时回退到默认模型。
const MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  // [1m] 后缀 = Claude Code 的 1M 上下文变体。可用性随套餐/模型而异：
  // 选了不可用的变体会在生成时报错，换回普通版即可。长上下文按更高权重计费。
  'claude-opus-4-8[1m]',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5[1m]',
  'claude-sonnet-4-0',
];
// ---------- 运行时配置 ----------
// 优先级：memory/bridge-config.json（管理面板修改，持久化）> 环境变量 > 内置默认。
// 除 PORT / MEMORY_ROOT（进程生命周期内固定）外全部热生效：改完下一轮请求即用新值。
// schema 同时驱动校验与面板表单渲染，加配置项只改这一处。
const CONFIG_FILE = path.join(MEMORY_ROOT, 'bridge-config.json');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// type: int | str | enum；lower=存前转小写；secret=面板打码；multiline=面板用多行框；
// enum 的 values 里 '' 表示"跟随默认/不设置"。
const CONFIG_SCHEMA = {
  BRIDGE_MODEL: { group: '模型', label: '默认回复模型', type: 'enum', values: MODELS, def: 'claude-sonnet-5',
    desc: 'ST 未指定或指定了未知模型时使用' },
  CHAT_EFFORT: { group: '模型', label: '回复推理力度', type: 'enum', values: ['', ...EFFORTS], lower: true, def: '', emptyLabel: '（SDK 默认 high）',
    desc: '空 = 跟随 SDK 默认（high）。低档出字快、消耗低，高档叙事更深' },
  CONTINUE_PROMPT: { group: '模型', label: '续写指令', type: 'str', multiline: true,
    def: '衔接 transcript 最后一条消息，遵循 system 中的全部设定（包括视角、人称、文风与角色分配），自然地续写下一条回复。只输出回复正文，不要输出任何解释或前缀。',
    desc: '拼在每次请求末尾的中性续写指令，视角/人称交给预设决定' },

  RECENT_TURNS: { group: '窗口', label: '窗口轮数', type: 'int', min: 1, def: 40,
    desc: '正文保留的最近对话轮数，更早的靠记忆档案与回溯' },
  RECENT_TURNS_MAX: { group: '窗口', label: '锚定窗口上限', type: 'int', min: 0, def: 0,
    desc: '0=关闭。设为大于窗口轮数启用锚定：窗口起点固定、正文纯追加省缓存，涨到上限一次性收缩。只在两轮间隔小于缓存寿命（5 分钟）的快节奏对话中有收益' },

  RECALL_MODE: { group: '回溯', label: '回溯模式', type: 'enum', values: ['sdk', 'api', 'off'], lower: true, def: 'sdk' },
  RECALL_MODEL: { group: '回溯', label: '出词模型', type: 'str', def: 'claude-haiku-4-5-20251001',
    options: ['claude-haiku-4-5-20251001', ...MODELS],
    desc: '仅 sdk 模式生效。出词是机械任务，默认用便宜快速的 Haiku 即可' },
  RECALL_EFFORT: { group: '回溯', label: '出词推理力度', type: 'enum', values: ['', ...EFFORTS], lower: true, def: 'low', emptyLabel: '（SDK 默认 high）',
    desc: '出词是机械任务，低档即可' },
  RECALL_THINKING_BUDGET: { group: '回溯', label: '出词思考上限', type: 'int', min: 0, def: 2000,
    desc: '思考 token 硬上限，防止回忆密集轮长考超时；0=不设限的自适应' },
  RECALL_BUDGET: { group: '回溯', label: '注入字符预算', type: 'int', min: 500, def: 6000 },
  RECALL_TIMEOUT: { group: '回溯', label: '超时 (ms)', type: 'int', min: 1000, def: 30000,
    desc: '整个回溯的超时，超时放弃不阻塞回复；命中多时要两次调用，建议 ≥ 90000' },
  RECALL_API_URL: { group: '回溯', label: 'API 地址', type: 'str', def: '', desc: 'api 模式的 OpenAI 兼容端点' },
  RECALL_API_KEY: { group: '回溯', label: 'API 密钥', type: 'str', secret: true, def: '' },
  RECALL_API_MODEL: { group: '回溯', label: 'API 模型', type: 'str', def: '' },

  MEMORY_MODE: { group: '记忆', label: '记忆模式', type: 'enum', values: ['sdk', 'api'], lower: true, def: 'sdk',
    desc: 'sdk=agent 带文件工具增量编辑；api=自配端点全文件重写' },
  MEMORY_MODEL: { group: '记忆', label: '记忆模型', type: 'str', def: '', options: ['', ...MODELS], emptyLabel: '（跟随默认回复模型）',
    desc: '仅 sdk 模式生效。空 = 跟随默认回复模型，记账质量与主模型对齐；可指定便宜档位省额度' },
  MEMORY_EFFORT: { group: '记忆', label: '记忆推理力度', type: 'enum', values: ['', ...EFFORTS], lower: true, def: '', emptyLabel: '（SDK 默认 high）',
    desc: '空 = 跟随 SDK 默认（high）；medium 可显著缩短更新耗时' },
  MEMORY_MAX_TURNS: { group: '记忆', label: '工具回合上限', type: 'int', min: 4, def: 30,
    desc: '记忆 agent 的最大工具回合数，长回复+5文件读写实测可超 15' },
  MEMORY_API_URL: { group: '记忆', label: 'API 地址', type: 'str', def: '' },
  MEMORY_API_KEY: { group: '记忆', label: 'API 密钥', type: 'str', secret: true, def: '' },
  MEMORY_API_MODEL: { group: '记忆', label: 'API 模型', type: 'str', def: '' },

  DICE_MODE: { group: '掷骰', label: '掷骰模式', type: 'enum', values: ['tool', 'pool', 'off'], lower: true, def: 'tool',
    desc: 'tool=真随机掷骰工具（推荐）；pool=预掷熵池注入' },
  DICE_TRIGGER: { group: '掷骰', label: '触发方式', type: 'enum', values: ['auto', 'always'], lower: true, def: 'auto',
    desc: 'auto=检测到规则关键词才启用，非跑团场景零介入' },
  DICE_MAX_TURNS: { group: '掷骰', label: '工具回合上限', type: 'int', min: 2, def: 6,
    desc: 'tool 模式下回复 agent 的回合上限，多次检定的战斗轮建议 ≥ 10' },
};

function normalizeConfig(key, raw) {
  const s = CONFIG_SCHEMA[key];
  if (!s) return { err: `未知配置项 ${key}` };
  if (s.type === 'int') {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < (s.min ?? 0)) return { err: `需要 ≥ ${s.min ?? 0} 的整数` };
    return { value: n };
  }
  let v = String(raw ?? '').trim();
  if (s.lower) v = v.toLowerCase();
  if (key.endsWith('_API_URL')) v = v.replace(/\/+$/, '');
  if (s.type === 'enum' && !s.values.includes(v)) {
    return { err: `可选值: ${s.values.map(x => x || '(空)').join(' | ')}` };
  }
  return { value: v };
}

// 面板层之下的基线值：环境变量 > 内置默认（恢复默认设置时回落到这里）
function baselineConfig(key) {
  const envRaw = process.env[key];
  if (envRaw !== undefined && envRaw !== '') {
    const r = normalizeConfig(key, envRaw);
    if (r.err) console.warn(`[config] 环境变量 ${key}=${envRaw} 无效（${r.err}），已忽略`);
    else return r.value;
  }
  return CONFIG_SCHEMA[key].def;
}

const CFG = {};
let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { fileConfig = {}; }
if (typeof fileConfig !== 'object' || fileConfig === null || Array.isArray(fileConfig)) fileConfig = {};
for (const key of Object.keys(CONFIG_SCHEMA)) {
  let v = baselineConfig(key);
  if (Object.hasOwn(fileConfig, key)) {
    const r = normalizeConfig(key, fileConfig[key]);
    if (r.err) console.warn(`[config] bridge-config.json 的 ${key} 无效（${r.err}），已忽略`);
    else v = r.value;
  }
  CFG[key] = v;
}

// 面板改值入口：校验 → 热生效 → 持久化到 bridge-config.json → 广播给所有面板
function setConfig(key, raw) {
  const r = normalizeConfig(key, raw);
  if (r.err) return r;
  CFG[key] = r.value;
  fileConfig[key] = r.value;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(fileConfig, null, 2) + '\n'); }
  catch (e) { console.warn(`[config] bridge-config.json 写入失败: ${e.message}`); }
  console.log(`[config] ${key} = ${CONFIG_SCHEMA[key].secret ? '（已隐藏）' : JSON.stringify(r.value)}（面板修改，即时生效）`);
  broadcastAdmin({ type: 'config', config: publicConfig() });
  return { value: r.value };
}

// 恢复默认设置：清空面板覆盖层（含密钥），全部回落到 环境变量 > 内置默认
function resetConfig() {
  fileConfig = {};
  try { fs.writeFileSync(CONFIG_FILE, '{}\n'); }
  catch (e) { console.warn(`[config] bridge-config.json 写入失败: ${e.message}`); }
  for (const key of Object.keys(CONFIG_SCHEMA)) CFG[key] = baselineConfig(key);
  console.log('[config] 已恢复默认设置（面板层清空，回落到环境变量/内置默认，即时生效）');
  broadcastAdmin({ type: 'config', config: publicConfig() });
}

// 发给面板的配置快照（密钥打码，真实值只进不出）
function publicConfig() {
  const out = {};
  for (const [k, s] of Object.entries(CONFIG_SCHEMA)) out[k] = s.secret ? (CFG[k] ? '••••••' : '') : CFG[k];
  return out;
}

// api 后端配置不全时的兜底判定（配置可热改，故在使用时校验而非启动时）
function memoryModeNow() {
  if (CFG.MEMORY_MODE !== 'api') return 'sdk';
  if (!CFG.MEMORY_API_URL || !CFG.MEMORY_API_MODEL) {
    console.warn('[memory] MEMORY_MODE=api 但缺少 MEMORY_API_URL / MEMORY_API_MODEL，本轮回退 sdk');
    return 'sdk';
  }
  return 'api';
}
function recallModeNow() {
  if (CFG.RECALL_MODE === 'api' && (!CFG.RECALL_API_URL || !CFG.RECALL_API_MODEL)) {
    console.warn('[recall] RECALL_MODE=api 但缺少 RECALL_API_URL / RECALL_API_MODEL，本轮跳过回溯');
    return 'off';
  }
  return CFG.RECALL_MODE;
}

// ---------- 用量统计 ----------
const START_TS = Date.now();
const newBucket = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const usageTotals = { chat: newBucket(), memory: newBucket(), recall: newBucket() };
const kfmt = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

// 兼容 SDK（input_tokens/cache_*）与 OpenAI（prompt_tokens/completion_tokens）两种用量格式
function normalizeUsage(u) {
  if (!u) return null;
  return {
    input: u.input_tokens ?? u.prompt_tokens ?? 0,
    output: u.output_tokens ?? u.completion_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(bucket, n) {
  bucket.calls++;
  bucket.input += n.input;
  bucket.output += n.output;
  bucket.cacheRead += n.cacheRead;
  bucket.cacheWrite += n.cacheWrite;
}

// 记入全局与战役两级统计，返回可拼在日志尾部的标签
function trackUsage(pathName, campaign, rawUsage) {
  const n = normalizeUsage(rawUsage);
  if (!n) return '';
  addUsage(usageTotals[pathName], n);
  if (campaign) {
    campaign.meta.tokens ??= {};
    campaign.meta.tokens[pathName] ??= newBucket();
    addUsage(campaign.meta.tokens[pathName], n);
  }
  const cache = n.cacheRead || n.cacheWrite ? `, cache r${kfmt(n.cacheRead)}/w${kfmt(n.cacheWrite)}` : '';
  return ` [tokens: in ${kfmt(n.input)}, out ${kfmt(n.output)}${cache}]`;
}

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
  // 只有"存档比本次请求更长出的尾巴"才算被弃用——真重roll时请求会停在待重新生成的
  // 用户消息上。与 incoming 同位置但内容不同的轮次是修改/前端变换（ST 的正则脚本会
  // 改写 assistant 消息后回传，桥暂存的原始回复次轮必然被 ST 版本替换），静默以
  // incoming 为准，不算弃用。
  const discarded = stored.slice(bestI + incoming.length).filter(t => t.role === 'assistant');
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

// 通用 OpenAI 兼容单轮补全（记忆 api 模式与回溯 api 模式共用）
async function openaiChat({ url, key, model }, system, prompt) {
  const r = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`api HTTP ${r.status}`);
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || null };
}

const MEMORY_FILE_SPEC = [
  '- world_state.md：时间/地点/天气/当前任务与目标',
  '- party.md：队伍成员的 HP、状态、装备、金钱账本',
  '- npc_ledger.md：出场 NPC 的态度、承诺、已知信息',
  '- timeline.md：按事件压缩的编年史（追加，不重写历史）。每条新条目控制在 200 字内，只记骨架：时间地点、人物、事件与结果、数值变化（好感度/资源/任务状态）；不复述场景氛围与对白——细节已由轮号指针兜底，可随时按号回捞原文。条目末尾标注来源轮号如（#12-13）；合并压缩旧条目时保留全部事实要点与合并后的轮号范围，轮号不可丢弃。',
  '- foreshadowing.md：未回收的伏笔与悬念',
];
const MEMORY_RULES = '只记录本轮新增或变化的信息；保持每个文件精炼（超过约 200 行时压缩旧内容）。聊天原文中的变量标记、状态栏/前端代码、思维链推演等非叙事内容一律不要写入档案，只提炼其中的叙事事实。本轮交互的轮号已在交互块属性中直接给出，新条目照抄即可；不要重复核对、改写既有条目的轮号标注，也不要为校验轮号去通读 transcript——每轮更新应当只围绕本轮新信息，快进快出。';
const MEMORY_MD_FILES = ['world_state.md', 'party.md', 'npc_ledger.md', 'timeline.md', 'foreshadowing.md'];

function memoryExchangeBlock(lastUserText, replyText, notes, replyNo) {
  return [
    ...(notes.length
      ? ['<corrections>', '以下修正优先处理：', ...notes, '</corrections>', '']
      : []),
    `<latest_user_turn 轮号="#${replyNo - 1}">`, lastUserText.slice(0, 8000), '</latest_user_turn>',
    `<latest_reply 轮号="#${replyNo}">`, replyText.slice(0, 16000), '</latest_reply>',
  ].join('\n');
}

// sdk 模式：agent 带文件工具在战役目录内增量编辑
async function updateMemorySdk(campaign, lastUserText, replyText, notes, startedAt, replyNo) {
  const prompt = [
    '你是战役记忆管理器。根据下面这一轮最新交互，更新当前目录下的战役档案（Markdown 文件）。',
    '维护这些文件（不存在则创建）：',
    ...MEMORY_FILE_SPEC,
    MEMORY_RULES,
    '完整对话原文在 transcript.jsonl（每行一条 JSON，行号即轮号 #N，只读，不要修改它和 meta.json），需要核对旧细节时可用 Read/Grep 查证。',
    '',
    memoryExchangeBlock(lastUserText, replyText, notes, replyNo),
  ].join('\n');

  for await (const msg of query({
    prompt,
    options: {
      model: CFG.MEMORY_MODEL || CFG.BRIDGE_MODEL,
      cwd: campaign.dir,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'acceptEdits',
      settingSources: [],
      maxTurns: CFG.MEMORY_MAX_TURNS,
      ...(CFG.MEMORY_EFFORT ? { effort: CFG.MEMORY_EFFORT } : {}),
    },
  })) {
    if (msg.type === 'result') {
      const tag = trackUsage('memory', campaign, msg.usage);
      if (msg.subtype !== 'success') throw new Error(`SDK result: ${msg.subtype}`);
      console.log(`[memory] ${campaign.id} 更新完成 (sdk, ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${msg.num_turns} turns)${tag}`);
    }
  }
}

// api 模式：单轮"全文件重写"——现有档案+本轮交互进，需更新文件的全文出，桥负责落盘
async function updateMemoryApi(campaign, lastUserText, replyText, notes, startedAt, replyNo) {
  const current = MEMORY_MD_FILES.map(f => {
    const p = path.join(campaign.dir, f);
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 12000) : '（尚不存在）';
    return `===FILE: ${f}===\n${text}`;
  }).join('\n\n');
  const system = [
    '你是战役记忆管理器。根据最新一轮交互更新战役档案。档案文件及用途：',
    ...MEMORY_FILE_SPEC,
    MEMORY_RULES,
    '输出格式：仅输出有变化的文件；每个文件以单独一行 ===FILE: 文件名=== 开头，紧跟该文件更新后的完整内容；除此之外不要输出任何解释。若本轮无需任何更新，只输出 NO_UPDATE。',
  ].join('\n');
  const prompt = `<current_files>\n${current}\n</current_files>\n\n${memoryExchangeBlock(lastUserText, replyText, notes, replyNo)}`;

  const { text: out, usage } = await openaiChat({ url: CFG.MEMORY_API_URL, key: CFG.MEMORY_API_KEY, model: CFG.MEMORY_API_MODEL }, system, prompt);
  const tag = trackUsage('memory', campaign, usage);
  if (/^\s*NO_UPDATE\b/.test(out.trim())) {
    console.log(`[memory] ${campaign.id} 判定无需更新 (api, ${((Date.now() - startedAt) / 1000).toFixed(1)}s)${tag}`);
    return;
  }
  const parts = out.split(/^===FILE:\s*([A-Za-z0-9_.\-]+)\s*===\s*$/m);
  let written = 0;
  fs.mkdirSync(campaign.dir, { recursive: true });
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim();
    const content = (parts[i + 1] || '').trim();
    // 只接受白名单内的档案文件名，防止路径逃逸或误写归档
    if (!MEMORY_MD_FILES.includes(name) || !content) continue;
    fs.writeFileSync(path.join(campaign.dir, name), content + '\n');
    written++;
  }
  if (!written) throw new Error('api 输出无法解析出任何档案文件');
  console.log(`[memory] ${campaign.id} 更新完成 (api, ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${written} 个文件)${tag}`);
}

async function updateMemory(campaign, lastUserText, replyText) {
  if (campaign.memoryJobRunning) {
    console.log(`[memory] ${campaign.id} 上一轮任务未结束，本轮跳过`);
    return;
  }
  campaign.memoryJobRunning = true;
  const notes = campaign.pendingNotes.splice(0);
  const startedAt = Date.now();
  // 回复刚被 push 进 transcript，其 1-based 轮号即当前长度；极端和解（整体替换）可能
  // 让旧轮号漂移，属可接受误差——轮号指针是尽力而为的导航，不是强一致索引。
  const replyNo = campaign.transcript.length;
  try {
    if (memoryModeNow() === 'api') await updateMemoryApi(campaign, lastUserText, replyText, notes, startedAt, replyNo);
    else await updateMemorySdk(campaign, lastUserText, replyText, notes, startedAt, replyNo);
    saveCampaign(campaign); // 持久化 meta 里的用量累计
  } catch (e) {
    campaign.pendingNotes.unshift(...notes); // 失败不丢修正，下一轮补上
    console.error(`[memory] ${campaign.id} 更新失败:`, e.message);
  } finally {
    campaign.memoryJobRunning = false;
  }
}

// ---------- 定向回溯 ----------
// 设计：LLM 只负责"出检索词"和"压缩结果"（各一次单轮小调用），检索本身是进程内
// 毫秒级文本扫描——不用开放式 agent 循环，避免多回合工具往返的延迟。
// 仅当归档长度超出提示词窗口（RECENT_TURNS）时才启动；窗口内的内容本来就在 prompt 里。
// 各项参数见 CONFIG_SCHEMA 的"回溯"组，可经管理面板热改。

// 两种后端共用的"文本进文本出"单轮补全，返回 { text, usage }
async function completeText(system, prompt) {
  if (CFG.RECALL_MODE === 'api') {
    return openaiChat({ url: CFG.RECALL_API_URL, key: CFG.RECALL_API_KEY, model: CFG.RECALL_API_MODEL }, system, prompt);
  }
  let text = '';
  let usage = null;
  for await (const msg of query({
    prompt,
    options: {
      model: CFG.RECALL_MODEL, systemPrompt: system, allowedTools: [], settingSources: [], maxTurns: 1,
      ...(CFG.RECALL_EFFORT ? { effort: CFG.RECALL_EFFORT } : {}),
      ...(CFG.RECALL_THINKING_BUDGET > 0
        ? { thinking: { type: 'enabled', budgetTokens: Math.max(1024, CFG.RECALL_THINKING_BUDGET) } }
        : {}),
    },
  })) {
    if (msg.type === 'result' && msg.subtype === 'success') {
      text = msg.result || '';
      usage = msg.usage || null;
    }
  }
  return { text, usage };
}

const withTimeout = (p, ms, tag) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag} 超时 (${ms}ms)`)), ms)),
]);

// 进程内检索：只扫提示词窗口之外的早期轮次，命中轮附带前后各一轮上下文。
// turnSpecs 为轮号指针（"12" 或 "30-35"，对应 timeline 里的 #N 标注），直接按号取原文，
// 是关键词逐字匹配不到时的兜底导航。
function searchArchive(campaign, queries, turnSpecs = []) {
  const t = campaign.transcript;
  const searchable = Math.max(0, campaign._searchableTo ?? (t.length - CFG.RECENT_TURNS));
  if (!searchable) return [];
  const hit = new Set();
  for (const spec of turnSpecs) {
    const m = String(spec).match(/^#?\s*(\d+)(?:\s*[-~～—]\s*#?(\d+))?$/);
    if (!m) continue;
    let a = Number(m[1]), b = Number(m[2] || m[1]);
    if (b < a) [a, b] = [b, a];
    b = Math.min(b, a + 19); // 单个范围最多展开 20 轮，防误写大范围；总量仍受 RECALL_BUDGET 截断
    for (let n = a; n <= b; n++) {
      const i = n - 1; // 轮号 1-based → 数组下标
      if (i >= 0 && i < searchable) hit.add(i);
    }
  }
  for (const q of queries) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (let i = 0; i < searchable; i++) {
      if (re.test(t[i].content || '')) {
        if (i > 0) hit.add(i - 1);
        hit.add(i);
        if (i + 1 < searchable) hit.add(i + 1);
      }
    }
  }
  const out = [];
  let used = 0;
  for (const i of [...hit].sort((a, b) => a - b)) {
    const line = `#${i + 1} [${t[i].role}] ${(t[i].content || '').replace(/\s+/g, ' ').slice(0, 600)}`;
    if (used + line.length > CFG.RECALL_BUDGET) break;
    out.push(line);
    used += line.length;
  }
  return out;
}

async function runRecall(campaign, lastUserText) {
  const started = Date.now();
  const timelinePath = path.join(campaign.dir, 'timeline.md');
  const timeline = fs.existsSync(timelinePath)
    ? fs.readFileSync(timelinePath, 'utf8').slice(-3000)
    : '（暂无编年史）';
  const qSystem = '你是对话归档检索助手。根据剧情编年史和最新一条消息，判断这一轮是否需要从早期对话原文中查证旧细节（旧承诺、旧台词、具体数字、名字对应关系等）。只输出严格 JSON，不要输出任何其他内容：需要时 {"queries":["关键词1"],"turns":["12","30-35"]}（两个字段各 0-4 个，至少一个字段非空）；不需要时 {"queries":[]}。queries 的检索方式是对原文逐字匹配，因此关键词必须是可能在原文中原样出现的词形：单个人名、地名、物品名、独特称谓或短语。禁止把多个概念拼成话题概括（要"赫克"，不要"赫克评估主角"）；同一名字疑有多种写法时，可让每种写法各占一个关键词。turns 是编年史事件末尾标注的轮号（#N）或轮号范围，当相关事件在编年史里标了轮号、尤其是难以给出逐字关键词时，用它直接按号调取原文。注意 <searchable_range> 给出的归档边界：边界之后的轮次已在当前对话正文中、无需也无法检索，若所需信息全部在边界之后，直接输出 {"queries":[]}。';
  const searchableTo = Math.max(0, campaign._searchableTo ?? (campaign.transcript.length - CFG.RECENT_TURNS));
  const gen = await completeText(qSystem,
    `<searchable_range>\n归档可检索范围：#1 至 #${searchableTo}（#${searchableTo + 1} 起的轮次已在当前对话正文中）\n</searchable_range>\n\n<timeline>\n${timeline}\n</timeline>\n\n<latest_message>\n${lastUserText.slice(0, 2000)}\n</latest_message>`);
  let tag = trackUsage('recall', campaign, gen.usage);
  const m = gen.text.match(/\{[\s\S]*\}/);
  if (!m) { console.log(`[recall] ${campaign.id} 检索词解析失败，跳过${tag}`); return ''; }
  let queries, turnSpecs;
  try {
    const parsed = JSON.parse(m[0]);
    queries = Array.isArray(parsed.queries) ? parsed.queries : [];
    turnSpecs = Array.isArray(parsed.turns) ? parsed.turns : [];
  } catch { return ''; }
  queries = queries.filter(q => typeof q === 'string' && q.trim()).slice(0, 4);
  turnSpecs = turnSpecs.map(s => String(s).trim()).filter(Boolean).slice(0, 4);
  if (!queries.length && !turnSpecs.length) {
    console.log(`[recall] ${campaign.id} 判定无需检索 (${Date.now() - started}ms)${tag}`);
    return '';
  }
  const label = [...queries, ...turnSpecs.map(s => `#${s.replace(/^#/, '')}`)].join('、');
  const lines = searchArchive(campaign, queries, turnSpecs);
  if (!lines.length) {
    console.log(`[recall] ${campaign.id} 检索 [${label}] 无命中 (${Date.now() - started}ms)${tag}`);
    return '';
  }
  let content = lines.join('\n');
  if (content.length > 2500) { // 命中较多时再花一次调用压缩，避免注入过长
    const sSystem = '把检索到的对话片段压缩成与当前话题相关的备忘录（300字以内）。保留具体数字、名字、承诺与关键原话，并保留轮号标注（#N）。只输出备忘录正文。';
    const syn = await completeText(sSystem,
      `<latest_message>\n${lastUserText.slice(0, 1000)}\n</latest_message>\n\n<excerpts>\n${content}\n</excerpts>`);
    content = syn.text;
    tag += trackUsage('recall', campaign, syn.usage);
  }
  console.log(`[recall] ${campaign.id} 检索 [${label}] 命中 ${lines.length} 段，注入 ${content.length} 字符 (${Date.now() - started}ms)${tag}`);
  return `\n\n<archive_recall>\n以下是根据本轮话题从对话原文归档中检索到的早期内容（#N 为轮号），可用于核对旧细节：\n${content}\n</archive_recall>`;
}

// ---------- 掷骰 ----------
// 解决 LLM 掷骰不随机（骰运永远偏向剧情需要）的问题。两种机制：
//   tool：进程内 MCP 工具，模型叙事到检定点时暂停调用 roll，基于真随机结果续写成败（推荐）
//   pool：请求前预掷一批真随机数注入 system，指示模型按序消耗（零延迟，但约束靠模型自觉）
// 触发控制（兼容非跑团场景）：auto 模式下扫描 system prompt（预设+卡+世界书）中的
// 规则关键词，没有检定/骰点语境的卡完全不启用，prompt 零污染。
// 模式与触发方式见 CONFIG_SCHEMA 的"掷骰"组，可经管理面板热改。
const DICE_KEYWORDS = /\b\d{0,2}d(?:4|6|8|10|12|20|100)\b|检定|掷骰|骰点|骰子|先攻|豁免|DC\s*\d|跑团|TRPG|龙与地下城|克苏鲁的呼唤|理智检定|San值|命中骰|伤害骰/i;

function diceArmed(systemPrompt) {
  if (CFG.DICE_MODE === 'off') return false;
  if (CFG.DICE_TRIGGER === 'always') return true;
  return DICE_KEYWORDS.test(systemPrompt);
}

let diceRollCount = 0; // 本进程累计真实掷骰次数，用于事后核对回复中的骰点是否出自工具

// 解析并投掷 NdM+K（1≤N≤100，2≤M≤1000），crypto 真随机
function rollFormula(formula) {
  const m = String(formula).trim().match(/^(\d{0,3})[dD](\d{1,4})\s*([+-]\s*\d{1,4})?$/);
  if (!m) throw new Error(`无法解析骰式: ${formula}（支持 NdM+K，如 1d20+5、2d6、d100）`);
  const n = Math.min(Math.max(Number(m[1] || 1), 1), 100);
  const faces = Math.min(Math.max(Number(m[2]), 2), 1000);
  const mod = m[3] ? Number(m[3].replace(/\s/g, '')) : 0;
  const rolls = Array.from({ length: n }, () => crypto.randomInt(1, faces + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const modText = mod ? (mod > 0 ? ` +${mod}` : ` ${mod}`) : '';
  return { total, text: `${n}d${faces}${modText} = [${rolls.join(', ')}]${modText} = ${total}` };
}

const diceServer = createSdkMcpServer({
  name: 'dice',
  version: '1.0.0',
  tools: [
    tool(
      'roll',
      '真随机掷骰。仅在剧情确实需要骰点（属性/技能检定、攻击、伤害、先攻、随机表等）时调用，formula 形如 1d20+5、2d6、d100。必须以返回的结果为准叙述成败，不得自行虚构点数。',
      { formula: z.string().describe('骰式，NdM+K 格式') },
      async ({ formula }) => {
        try {
          const r = rollFormula(formula);
          diceRollCount++;
          console.log(`[dice] ${r.text}`);
          return { content: [{ type: 'text', text: r.text }] };
        } catch (e) {
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
      },
    ),
  ],
});

const DICE_TOOL_HINT = '\n\n<dice_tool>\n已接入真随机掷骰工具 roll（骰式如 1d20+5、2d20）。硬性规则：回复中出现的一切骰点数字——包括任何战斗/检定模板里的"掷骰"字段、优势/劣势取值、命中骰、伤害骰、随机表——都必须来自 roll 工具的真实返回值。先调用工具拿到点数，再据其撰写结算与叙事；严禁凭空编写任何点数，哪怕格式模板要求填写。一次需要多个点数时，在同一条消息里并行发出多个 roll 调用（优势/劣势 = roll("2d20") 后取高/取低）。纯对话与无检定的叙事场合不要调用。\n</dice_tool>';

function buildDicePool() {
  const seq = (n, faces) => Array.from({ length: n }, () => crypto.randomInt(1, faces + 1)).join(', ');
  const pool = `d20: ${seq(8, 20)}\nd12: ${seq(4, 12)}\nd10: ${seq(6, 10)}\nd8: ${seq(6, 8)}\nd6: ${seq(10, 6)}\nd4: ${seq(6, 4)}\nd100: ${seq(4, 100)}`;
  return { pool, block: `\n\n<dice_pool>\n本轮如需骰点，必须按下列真随机序列从左到右依次消耗（用几个取几个，严禁跳选或自行编造点数），并在正文中如实呈现点数：\n${pool}\n</dice_pool>` };
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

  // 历史截断：早期对话交给记忆档案。默认滑动窗口（永远最近 N 轮）；
  // 启用锚定后窗口起点固定、只在超出上限时收缩，其余轮次正文为纯追加。
  let start = Math.max(0, turns.length - CFG.RECENT_TURNS);
  if (campaign && CFG.RECENT_TURNS_MAX > CFG.RECENT_TURNS) {
    let anchor = campaign.meta.windowAnchor;
    if (!Number.isInteger(anchor) || anchor < 0 || anchor > start) anchor = start;
    if (turns.length - anchor > CFG.RECENT_TURNS_MAX) anchor = start; // 超上限，一次性收缩
    campaign.meta.windowAnchor = anchor;
    start = anchor;
  }
  const recent = turns.slice(start);
  const dropped = start;
  // 回溯的可检索边界跟随实际窗口起点，锚定期间不留"既不在窗口也搜不到"的缝隙
  if (campaign) campaign._searchableTo = dropped;
  const transcriptText = recent
    .map(t => (t.role === 'assistant' ? `[assistant]\n${t.content}` : `[user]\n${t.content}`))
    .join('\n\n');

  // 缓存友好排布：md 档案等每轮易变的内容后置到正文之后，让 system（预设）
  // 与 transcript 的长前缀保持逐字稳定——md 变化只作废末尾一小段缓存。
  const systemPrompt = systemParts.join('\n\n');
  const prompt = [
    dropped > 0 ? `（更早的 ${dropped} 条对话已归档进战役记忆，见下方 campaign_memory）` : '',
    '<transcript>', transcriptText, '</transcript>',
    campaign ? readMemory(campaign) : '',
  ].filter(Boolean).join('\n');

  return { campaign, systemPrompt, prompt, lastUserText };
}

// ---------- SDK 调用 ----------
async function* generate(model, systemPrompt, prompt, cwd, usageOut = {}, withDice = false) {
  const q = query({
    prompt,
    options: {
      model,
      systemPrompt,
      settingSources: [],
      includePartialMessages: true,
      cwd,
      ...(CFG.CHAT_EFFORT ? { effort: CFG.CHAT_EFFORT } : {}),
      // 掷骰工具启用时放开工具循环，其余场合保持纯单轮生成
      ...(withDice
        ? { mcpServers: { dice: diceServer }, allowedTools: ['mcp__dice__roll'], maxTurns: CFG.DICE_MAX_TURNS }
        : { allowedTools: [], maxTurns: 1 }),
    },
  });
  for await (const msg of q) {
    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        yield ev.delta.text;
      }
    } else if (msg.type === 'result') {
      if (msg.subtype !== 'success') throw new Error(`SDK result: ${msg.subtype}`);
      usageOut.usage = msg.usage || null;
    }
  }
}

// ---------- OpenAI 兼容层 ----------
function sseChunk(id, model, delta, finish = null, usage = null) {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

// 转成 OpenAI usage 字段（prompt_tokens 含缓存读写部分）
function toOpenaiUsage(rawUsage) {
  const n = normalizeUsage(rawUsage);
  if (!n) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = n.input + n.cacheRead + n.cacheWrite;
  return { prompt_tokens: prompt, completion_tokens: n.output, total_tokens: prompt + n.output };
}

async function handleChat(req, res, body) {
  const { campaign, systemPrompt: baseSystem, prompt, lastUserText } = buildPrompt(body);
  let systemPrompt = baseSystem;
  let promptTail = ''; // 回溯/骰池等每轮易变的注入统一后置，保住前缀缓存
  if (recallModeNow() !== 'off' && campaign && lastUserText
      && (campaign._searchableTo ?? (campaign.transcript.length - CFG.RECENT_TURNS)) > 0) {
    try {
      promptTail += await withTimeout(runRecall(campaign, lastUserText), CFG.RECALL_TIMEOUT, 'recall');
    } catch (e) {
      console.error('[recall] 失败，跳过:', e.message);
    }
  }
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2);
  const stream = body.stream !== false;
  const model = MODELS.includes(body.model) ? body.model : CFG.BRIDGE_MODEL;
  const cwd = campaign ? campaign.dir : MEMORY_ROOT;
  const usageOut = {};
  let full = '';

  // 掷骰：按 system（预设+卡+世界书）中的规则关键词决定是否启用，非跑团场景零介入
  let withDice = false;
  const diceCallsBefore = diceRollCount;
  const armed = diceArmed(baseSystem);
  if (armed && CFG.DICE_MODE === 'tool') {
    systemPrompt += DICE_TOOL_HINT;
    withDice = true;
  } else if (armed && CFG.DICE_MODE === 'pool') {
    const { pool, block } = buildDicePool();
    promptTail += block;
    console.log(`[dice] 熵池注入:\n${pool.split('\n').map(l => '        ' + l).join('\n')}`);
  }
  if (campaign && campaign._diceState !== armed) {
    const wasArmed = campaign._diceState;
    campaign._diceState = armed;
    if (armed) console.log(`[dice] ${campaign.id} 检测到规则关键词，掷骰已启用 (${CFG.DICE_MODE})`);
    else if (wasArmed) console.log(`[dice] ${campaign.id} 规则关键词消失，掷骰已停用`);
  }
  const finalPrompt = prompt + promptTail + '\n\n' + CFG.CONTINUE_PROMPT;
  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(sseChunk(id, model, { role: 'assistant', content: '' }));
      for await (const text of generate(model, systemPrompt, finalPrompt, cwd, usageOut, withDice)) {
        full += text;
        res.write(sseChunk(id, model, { content: text }));
      }
      res.write(sseChunk(id, model, {}, 'stop', toOpenaiUsage(usageOut.usage)));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      for await (const text of generate(model, systemPrompt, finalPrompt, cwd, usageOut, withDice)) full += text;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
        usage: toOpenaiUsage(usageOut.usage),
      }));
    }
    const tag = trackUsage('chat', campaign, usageOut.usage);
    console.log(`[chat] 回复 ${full.length} 字符 (${model}${campaign ? ', ' + campaign.id : ''})${tag}`);
    // 骰点对账：挂了工具却零调用、正文里又出现骰点描述 → 点数是模型编的
    if (withDice && diceRollCount === diceCallsBefore && /掷骰\s*[:：]|\bd\d{1,3}\s*[（(]\s*\d/i.test(full)) {
      console.warn('[dice] ⚠ 警告：回复包含骰点描述但未调用掷骰工具，点数疑为模型虚构');
    }
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

function statsSnapshot() {
  const all = newBucket();
  for (const b of Object.values(usageTotals)) {
    all.calls += b.calls; all.input += b.input; all.output += b.output;
    all.cacheRead += b.cacheRead; all.cacheWrite += b.cacheWrite;
  }
  return {
    uptimeSec: Math.floor((Date.now() - START_TS) / 1000),
    totals: { ...usageTotals, all },
    campaigns: [...campaigns.values()]
      .filter(c => c.meta.tokens)
      .map(c => ({ id: c.id, title: c.meta.title || '', tokens: c.meta.tokens })),
  };
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/stats' || url === '/v1/stats')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(statsSnapshot(), null, 2));
    return;
  }
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

// ---------- 管理通道（ST 扩展面板经 ws://.../admin 连入） ----------
// 面板能力：实时改 CONFIG_SCHEMA 内的配置（免环境变量免重启）、日志流、用量统计。
// 只绑本机；浏览器客户端还需 Origin 是本机页面（即 ST 前端），防止外部网页乱连。
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (req.url.split('?')[0] !== '/admin'
      || (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    adminClients.add(ws);
    ws.on('close', () => adminClients.delete(ws));
    ws.on('error', () => adminClients.delete(ws));
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === 'set') {
        const r = setConfig(m.key, m.value);
        ws.send(JSON.stringify({ type: 'setResult', key: m.key, ok: !r.err, error: r.err }));
      } else if (m.type === 'reset') {
        resetConfig();
      } else if (m.type === 'stats') {
        ws.send(JSON.stringify({ type: 'stats', stats: statsSnapshot() }));
      }
    });
    ws.send(JSON.stringify({
      type: 'hello',
      schema: CONFIG_SCHEMA,
      config: publicConfig(),
      info: { port: PORT, memoryRoot: MEMORY_ROOT, pid: process.pid, campaigns: campaigns.size, uptimeSec: Math.floor((Date.now() - START_TS) / 1000) },
      logs: logRing,
    }));
  });
});

loadCampaigns();
server.listen(PORT, '127.0.0.1', () => {
  const recallDesc = CFG.RECALL_MODE === 'off' ? 'off'
    : CFG.RECALL_MODE === 'api' ? `api(${CFG.RECALL_API_MODEL})` : `sdk(${CFG.RECALL_MODEL})`;
  const memoryDesc = CFG.MEMORY_MODE === 'api' ? `api(${CFG.MEMORY_API_MODEL})` : `sdk(${CFG.MEMORY_MODEL || CFG.BRIDGE_MODEL})`;
  const diceDesc = CFG.DICE_MODE === 'off' ? 'off' : `${CFG.DICE_MODE}/${CFG.DICE_TRIGGER}`;
  console.log(`st-claude-bridge listening on http://127.0.0.1:${PORT}/v1  (default: ${CFG.BRIDGE_MODEL}, memory: ${memoryDesc}, recall: ${recallDesc}, dice: ${diceDesc}, campaigns: ${campaigns.size}, root: ${MEMORY_ROOT}, admin: ws://127.0.0.1:${PORT}/admin)`);
});

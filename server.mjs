// st-claude-bridge — SillyTavern ↔ LLM 代理（双通道）
// ST 把这里当 OpenAI 兼容后端连。回复通道二选一（CHAT_MODE）：
//   sdk = Claude Agent SDK（走 Claude Code 订阅登录态，零 API 费用）
//   api = 任意 OpenAI 兼容端点（GPT/Grok 等，自备 key）——无 Claude 订阅也能用全套记忆系统
// 每次回复完成后，后台记忆任务异步更新对应战役目录下的 Markdown 档案（sdk/agent/api 三种后端）。
// 战役识别：聊天键（ST 扩展随请求盖章）优先，对话指纹（各轮内容哈希重合度）回退。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WebSocketServer } from 'ws';

// Agent SDK 按需加载：只有 sdk 通道用到；纯 api 部署可以不装它
// （package.json 里列为 optionalDependencies，安装失败不影响启动）。
let _sdk = null;
async function loadSdk() {
  if (!_sdk) {
    try { _sdk = await import('@anthropic-ai/claude-agent-sdk'); }
    catch { throw new Error('未安装 @anthropic-ai/claude-agent-sdk，无法使用 sdk 通道；请改用 api/agent 模式，或 npm install 补装'); }
  }
  return _sdk;
}

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
  CHAT_MODE: { group: '模型', label: '回复通道', type: 'enum', values: ['sdk', 'api'], lower: true, def: 'sdk',
    desc: 'sdk=Claude Code 订阅登录态（零 API 费用）；api=任意 OpenAI 兼容端点（GPT/Grok 等，下面三项生效），无 Claude 订阅也能用全套记忆系统' },
  CHAT_API_URL: { group: '模型', label: '回复 API 地址', type: 'str', def: '',
    desc: 'api 通道的 OpenAI 兼容端点，如 https://api.openai.com/v1、https://api.x.ai/v1 或中转地址' },
  CHAT_API_KEY: { group: '模型', label: '回复 API 密钥', type: 'str', secret: true, def: '' },
  CHAT_API_MODEL: { group: '模型', label: '回复 API 模型', type: 'str', def: '',
    desc: '留空 = 跟随 ST 请求里填的模型名；填了则强制覆盖' },
  BRIDGE_MODEL: { group: '模型', label: '默认回复模型', type: 'enum', values: MODELS, def: 'claude-sonnet-5',
    desc: 'sdk 通道下，ST 未指定或指定了未知模型时使用' },
  CHAT_EFFORT: { group: '模型', label: '回复推理力度', type: 'enum', values: ['', ...EFFORTS], lower: true, def: '', emptyLabel: '（SDK 默认 high）',
    desc: '仅 sdk 通道生效。空 = 跟随 SDK 默认（high）。低档出字快、消耗低，高档叙事更深' },
  CONTINUE_PROMPT: { group: '模型', label: '续写指令', type: 'str', multiline: true,
    def: '衔接 transcript 最后一条消息，遵循 system 中的全部设定（包括视角、人称、文风与角色分配），自然地续写下一条回复。只输出回复正文，不要输出任何解释或前缀。',
    desc: '拼在每次请求末尾的中性续写指令，视角/人称交给预设决定' },

  RECENT_TURNS: { group: '窗口', label: '窗口轮数', type: 'int', min: 1, def: 25,
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
  RECALL_BM25: { group: '回溯', label: 'BM25 模糊排序', type: 'enum', values: ['on', 'off'], lower: true, def: 'on',
    desc: '给关键词检索叠一层中文 1/2-gram BM25 打分：命中超预算时按相关度取舍，字面失配时模糊兜底（纯本地计数，零额外调用）' },
  RECALL_TIMEOUT: { group: '回溯', label: '超时 (ms)', type: 'int', min: 1000, def: 120000,
    desc: '整个回溯的超时，超时放弃不阻塞回复。命中多时要出词+压缩两次调用（各约 20-60s），调小会掐掉恰恰最有价值的回溯' },
  RECALL_API_URL: { group: '回溯', label: 'API 地址', type: 'str', def: '', desc: 'api 模式的 OpenAI 兼容端点' },
  RECALL_API_KEY: { group: '回溯', label: 'API 密钥', type: 'str', secret: true, def: '' },
  RECALL_API_MODEL: { group: '回溯', label: 'API 模型', type: 'str', def: '' },

  MEMORY_MODE: { group: '记忆', label: '记忆模式', type: 'enum', values: ['sdk', 'agent', 'api'], lower: true, def: 'sdk',
    desc: 'sdk=订阅 agent 带文件工具增量编辑；agent=自配端点的函数调用 agent（同样增量编辑，需模型支持工具调用，GPT/Grok 前沿模型适用）；api=自配端点全文件重写（不依赖工具调用，兼容性最强）。agent/api 共用下方 API 三项' },
  MEMORY_MODEL: { group: '记忆', label: '记忆模型', type: 'str', def: '', options: ['', ...MODELS], emptyLabel: '（跟随默认回复模型）',
    desc: '仅 sdk 模式生效。空 = 跟随默认回复模型，记账质量与主模型对齐；可指定便宜档位省额度' },
  MEMORY_EFFORT: { group: '记忆', label: '记忆推理力度', type: 'enum', values: ['', ...EFFORTS], lower: true, def: 'medium', emptyLabel: '（SDK 默认 high）',
    desc: '默认 medium：比 high 显著缩短更新耗时，档案质量实测无损' },
  MEMORY_MAX_TURNS: { group: '记忆', label: '工具回合上限', type: 'int', min: 4, def: 30,
    desc: '记忆 agent 的最大工具回合数，长回复+5文件读写实测可超 15' },
  CATCHUP_BATCH: { group: '记忆', label: '补课批大小', type: 'int', min: 5, def: 15,
    desc: '导入旧对话后"补课"时，每批喂给记忆 agent 的轮数；批越大总批次越少，单批耗时越长' },
  MEMORY_API_URL: { group: '记忆', label: 'API 地址', type: 'str', def: '' },
  MEMORY_API_KEY: { group: '记忆', label: 'API 密钥', type: 'str', secret: true, def: '' },
  MEMORY_API_MODEL: { group: '记忆', label: 'API 模型', type: 'str', def: '' },

  DICE_MODE: { group: '掷骰', label: '掷骰模式', type: 'enum', values: ['tool', 'pool', 'off'], lower: true, def: 'tool',
    desc: 'tool=真随机掷骰工具（推荐）；pool=预掷熵池注入' },
  DICE_TRIGGER: { group: '掷骰', label: '触发方式', type: 'enum', values: ['auto', 'always'], lower: true, def: 'auto',
    desc: 'auto=检测到规则关键词才启用，非跑团场景零介入' },
  DICE_MAX_TURNS: { group: '掷骰', label: '工具回合上限', type: 'int', min: 2, def: 12,
    desc: 'tool 模式下回复 agent 的回合上限；默认 12 足够覆盖多次检定的战斗轮' },
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
  if (CFG.MEMORY_MODE !== 'api' && CFG.MEMORY_MODE !== 'agent') return 'sdk';
  if (!CFG.MEMORY_API_URL || !CFG.MEMORY_API_MODEL) {
    console.warn(`[memory] MEMORY_MODE=${CFG.MEMORY_MODE} 但缺少 MEMORY_API_URL / MEMORY_API_MODEL，本轮回退 sdk`);
    return 'sdk';
  }
  return CFG.MEMORY_MODE;
}
function recallModeNow() {
  if (CFG.RECALL_MODE === 'api' && (!CFG.RECALL_API_URL || !CFG.RECALL_API_MODEL)) {
    console.warn('[recall] RECALL_MODE=api 但缺少 RECALL_API_URL / RECALL_API_MODEL，本轮跳过回溯');
    return 'off';
  }
  return CFG.RECALL_MODE;
}
function chatModeNow() {
  if (CFG.CHAT_MODE !== 'api') return 'sdk';
  if (!CFG.CHAT_API_URL) {
    console.warn('[chat] CHAT_MODE=api 但未配置 CHAT_API_URL，本轮回退 sdk');
    return 'sdk';
  }
  return 'api';
}

// ---------- 用量统计 ----------
const START_TS = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newBucket = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const usageTotals = { chat: newBucket(), memory: newBucket(), recall: newBucket() };
const kfmt = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

// 缓存命中率 = 缓存读 ÷ 提示词总量（新输入+缓存读+缓存写），无提示词时为 null
function hitPct(n) {
  const total = n.input + n.cacheRead + n.cacheWrite;
  return total > 0 ? Math.round((n.cacheRead / total) * 100) : null;
}

// 发给面板的累计命中率摘要（进程生命周期内的平均）
function usageSummary() {
  const out = {};
  for (const [k, b] of Object.entries(usageTotals)) out[k] = { calls: b.calls, hit: hitPct(b) };
  return out;
}

// 兼容 SDK（input_tokens/cache_*）与 OpenAI（prompt_tokens/completion_tokens）两种用量格式
function normalizeUsage(u) {
  if (!u) return null;
  // OpenAI/xAI 系：prompt_tokens 含缓存命中部分（prompt_tokens_details.cached_tokens），
  // 拆出来对齐我们的口径（input=全新输入，prompt 总量 = input + cacheRead + cacheWrite）
  const cachedOpenai = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: u.input_tokens ?? (u.prompt_tokens != null ? Math.max(0, u.prompt_tokens - cachedOpenai) : 0),
    output: u.output_tokens ?? u.completion_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? cachedOpenai,
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
  broadcastAdmin({ type: 'usage', usage: usageSummary() });
  const p = hitPct(n);
  const cache = n.cacheRead || n.cacheWrite
    ? `, cache r${kfmt(n.cacheRead)}/w${kfmt(n.cacheWrite)}${p == null ? '' : `, 命中 ${p}%`}`
    : '';
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

function createCampaign(firstUserText, chatKey = '') {
  const id = 'c-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    + '-' + Math.random().toString(36).slice(2, 6);
  const c = makeCampaign(id, {
    createdAt: Date.now(),
    lastSeen: Date.now(),
    title: (firstUserText || '').slice(0, 40),
    ...(chatKey ? { chatKey } : {}),
  }, []);
  campaigns.set(id, c);
  console.log(`[campaign] 新战役 ${id}${chatKey ? `（绑定聊天键 ${chatKey}）` : ''}`);
  return c;
}

// 聊天键归一化：ST 扩展盖章送达的"角色卡标识::聊天文件名"（群聊为 g:群id::聊天id）
const normChatKey = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

// 把指纹匹配到的战役与聊天键绑定。只在战役尚无聊天键时认领——已有不同键说明
// 聊天文件被改名/分支/复制（新旧文件内容指纹相同），维持指纹匹配、不抢绑定，
// 避免两个文件反复互抢同一个键。
function bindChatKey(c, chatKey) {
  if (!chatKey) return '';
  if (!c.meta.chatKey) { c.meta.chatKey = chatKey; return '，绑定聊天键'; }
  if (c.meta.chatKey !== chatKey) return '，聊天键有变（改名/分支？维持指纹匹配）';
  return '';
}

// 战役识别，两级：
// 1. 聊天键（有则优先）：扩展随请求盖章的聊天文件标识，一个对话文件绑定一份记忆，
//    不受预设改变历史形态（压缩/脚手架）的影响。
// 2. 内容指纹（回退，面板未装/其他前端也能用）：
//    - 长对话（≥3 轮）：命中 min(3, 轮数-1) 条即续接。命中里必然含生成的 GM 回复，
//      等于同一聊天的唯一指纹（最后一条用户消息总是新的，所以阈值按 轮数-1 封顶）。
//    - 短对话（≤2 轮，开场阶段）：要求全部命中且目标战役同样年轻（存档 ≤ 轮数+1），
//      用来区分"重roll第一条回复"和"用同一开场白开的新聊天"。
function resolveCampaign(turns, chatKey = '') {
  if (chatKey) {
    const bound = [...campaigns.values()].find(c => c.meta.chatKey === chatKey);
    if (bound) {
      console.log(`[campaign] 续接 ${bound.id}（聊天键绑定）`);
      return bound;
    }
  }
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
    console.log(`[campaign] 续接 ${best.c.id}（${best.n}/${hashes.length} 轮吻合${bindChatKey(best.c, chatKey)}）`);
    return best.c;
  }
  const legacy = [...campaigns.values()].find(c => c.meta.adoptNextChat);
  if (legacy && turns.length > 2) {
    delete legacy.meta.adoptNextChat;
    console.log(`[campaign] 旧档案 ${legacy.id} 认领当前对话${bindChatKey(legacy, chatKey)}`);
    return legacy;
  }
  const firstUser = turns.find(t => t.role === 'user');
  return createCampaign(firstUser && firstUser.content, chatKey);
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

// ---------- 旧对话导入（面板经 /admin 通道触发） ----------
// 扩展从 ST 前端取当前对话全楼层发来。已有匹配战役则并入（把只见过滑动窗口的
// 存档补全成完整历史），否则新建战役。合并时若检测到早期楼层补全导致轮号整体
// 偏移，自动修正 timeline 里的 #N 标注（原文件先备份）。
function computeImportOffset(campaign, importedHashes) {
  const firstPos = new Map();
  importedHashes.forEach((h, j) => { if (!firstPos.has(h)) firstPos.set(h, j); });
  const votes = new Map();
  campaign.hashes.forEach((h, i) => {
    const j = firstPos.get(h);
    if (j !== undefined) votes.set(j - i, (votes.get(j - i) || 0) + 1);
  });
  let best = null, bestVotes = 0, total = 0;
  for (const [off, v] of votes) { total += v; if (v > bestVotes) { bestVotes = v; best = off; } }
  // 需要 ≥3 票且占多数、且方向是"导入比存档多出前缀"，否则认为无法确定偏移
  if (best === null || best < 0 || bestVotes < 3 || bestVotes * 2 < total) return null;
  return best;
}

function shiftTimeline(campaign, offset) {
  const p = path.join(campaign.dir, 'timeline.md');
  if (!fs.existsSync(p) || offset <= 0) return;
  const text = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(path.join(campaign.dir, 'timeline.pre-import.bak'), text);
  // 轮号标注既有单号（#12）也有范围（#12-13，单个 # 带范围），一次性匹配整体平移
  fs.writeFileSync(p, text.replace(/#(\d+)((?:\s*[-~～—]\s*)?)(\d*)/g, (_, a, sep, b) =>
    '#' + (Number(a) + offset) + (b ? sep + (Number(b) + offset) : sep)));
  console.log(`[campaign] ${campaign.id} timeline 轮号整体 +${offset}（原文件备份为 timeline.pre-import.bak）`);
}

// 面板发来的消息列表 → 规整轮次；与全部战役做指纹匹配，命中 ≥3 视为同一战役
function normalizeImportTurns(m) {
  return (Array.isArray(m.turns) ? m.turns : [])
    .filter(t => t && (t.role === 'user' || t.role === 'assistant')
      && typeof t.content === 'string' && t.content.trim())
    .map(t => ({ role: t.role, content: t.content }));
}

function findMatchingCampaign(hashes) {
  let best = null;
  for (const c of campaigns.values()) {
    const n = hashes.reduce((s, h) => s + (c.hashSet.has(h) ? 1 : 0), 0);
    if (n >= 3 && (!best || n > best.n)) best = { c, n };
  }
  return best;
}

// 战役概要（面板管理卡片用）
function campaignBrief(c) {
  const files = MEMORY_MD_FILES.filter(f => fs.existsSync(path.join(c.dir, f)))
    .map(f => ({ name: f, size: fs.statSync(path.join(c.dir, f)).size }));
  return {
    campaignId: c.id,
    title: c.meta.title || '',
    turns: c.transcript.length,
    lastSeen: c.meta.lastSeen || null,
    catchupTo: c.meta.catchupTo ?? null,
    catchupTarget: c.meta.catchupTarget ?? null,
    busy: !!(c.memoryJobRunning || c._catchupRunning),
    chatKey: c.meta.chatKey || '',
    files,
  };
}

function importCampaign(m) {
  const turns = normalizeImportTurns(m);
  if (turns.length < 3) return { ok: false, error: '有效消息不足 3 条，无法导入' };
  const chatKey = normChatKey(m.chatKey);
  const hashes = turns.map(turnHash);
  const best = findMatchingCampaign(hashes);

  if (best) {
    const c = best.c;
    if (c.memoryJobRunning || c._catchupRunning) {
      return { ok: false, error: `匹配到战役 ${c.id}，但其记忆任务正在运行，请稍后再试` };
    }
    if (turns.length < c.transcript.length) {
      return { ok: false, error: `匹配到战役 ${c.id}（已存档 ${c.transcript.length} 轮），导入内容只有 ${turns.length} 轮，为防误覆盖已取消` };
    }
    const offset = computeImportOffset(c, hashes);
    if (offset && offset > 0) shiftTimeline(c, offset);
    bindChatKey(c, chatKey);
    c.transcript = turns;
    refreshHashes(c);
    c.meta.lastSeen = Date.now();
    // 补课范围推进：偏移 >0 说明补全了早期楼层，未覆盖区从头开始、上界整体平移；
    // 偏移 =0 是纯尾部对齐，补课进度不动；偏移无法确定时不动，交给用户核对
    if (offset && offset > 0) {
      const prevPending = Math.max(0, (c.meta.catchupTarget ?? 0) - (c.meta.catchupTo ?? 0));
      c.meta.catchupTarget = offset + (prevPending > 0 ? (c.meta.catchupTarget ?? 0) : 0);
      c.meta.catchupTo = 0;
    }
    saveCampaign(c);
    console.log(`[campaign] ${c.id} 导入并入：现共 ${turns.length} 轮`
      + (offset ? `，补全早期 ${offset} 轮` : offset === 0 ? '，无新增早期楼层' : '，轮号偏移无法确定（timeline 标注请自行核对）'));
    return {
      ok: true, campaignId: c.id, turns: turns.length, merged: true, offset,
      catchupRemaining: Math.max(0, Number(c.meta.catchupTarget ?? 0) - Number(c.meta.catchupTo ?? 0)),
    };
  }

  const c = createCampaign(turns.find(t => t.role === 'user')?.content, chatKey);
  c.transcript = turns;
  refreshHashes(c);
  if (m.title && String(m.title).trim()) c.meta.title = String(m.title).trim().slice(0, 60);
  c.meta.catchupTo = 0;
  c.meta.catchupTarget = turns.length;
  saveCampaign(c);
  console.log(`[campaign] ${c.id} 导入完成：${turns.length} 轮（${c.meta.title || '无标题'}）`);
  return { ok: true, campaignId: c.id, turns: turns.length, merged: false, catchupRemaining: turns.length };
}

// ---------- 战役管理（面板经 /admin 触发；约定一个对话文件绑定一份记忆档案） ----------
// 定位：聊天键优先、内容指纹回退，返回管理卡片所需概要
function locateCampaign(m) {
  const chatKey = normChatKey(m.chatKey);
  if (chatKey) {
    const bound = [...campaigns.values()].find(c => c.meta.chatKey === chatKey);
    if (bound) return { ok: true, found: true, via: 'chatKey', ...campaignBrief(bound) };
  }
  const turns = normalizeImportTurns(m);
  if (turns.length < 3) return { ok: true, found: false, reason: '当前对话有效消息不足 3 条' };
  const best = findMatchingCampaign(turns.map(turnHash));
  if (!best) return { ok: true, found: false };
  return { ok: true, found: true, via: 'fingerprint', ...campaignBrief(best.c) };
}

function getCampaignOr(m) {
  const c = campaigns.get(String(m.campaignId || ''));
  if (!c) throw new Error('战役不存在');
  return c;
}

// 读五个档案 md 的全文（供面板编辑器）
function readMemoryFiles(m) {
  const c = getCampaignOr(m);
  const files = MEMORY_MD_FILES.map(f => {
    const p = path.join(c.dir, f);
    return { name: f, content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' };
  });
  return { ok: true, campaignId: c.id, files };
}

// 面板保存单个档案 md（白名单限定，记忆任务运行中拒绝以免和 agent 写入冲突）
function saveMemoryFile(m) {
  const c = getCampaignOr(m);
  if (c.memoryJobRunning || c._catchupRunning) throw new Error('记忆任务运行中，稍后再保存');
  const name = String(m.name || '');
  if (!MEMORY_MD_FILES.includes(name)) throw new Error('不在档案文件白名单内');
  backupMemoryFiles(c, 'manual');
  fs.mkdirSync(c.dir, { recursive: true });
  fs.writeFileSync(path.join(c.dir, name), String(m.content ?? ''));
  console.log(`[campaign] ${c.id} ${name} 已由面板编辑保存（${Buffer.byteLength(String(m.content ?? ''))} 字节）`);
  return { ok: true, campaignId: c.id, name };
}

// 删除 = 移入 memory/trash/（软删除，可手动恢复）
function deleteCampaign(m) {
  const c = getCampaignOr(m);
  if (c.memoryJobRunning || c._catchupRunning) throw new Error('记忆任务运行中，稍后再删除');
  const trashDir = path.join(MEMORY_ROOT, 'trash');
  fs.mkdirSync(trashDir, { recursive: true });
  const dest = path.join(trashDir, `${c.id}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`);
  fs.renameSync(c.dir, dest);
  fs.rmSync(path.join(MEMORY_ROOT, 'backups', c.id), { recursive: true, force: true }); // 滚动备份随战役一并清理
  campaigns.delete(c.id);
  console.log(`[campaign] ${c.id} 已删除（移入 ${dest}，可手动恢复）`);
  return { ok: true, campaignId: c.id, trash: dest };
}

// 重建档案：现有 md 备份为 *.pre-rebuild.bak 后清空，从头补课重新生成
function rebuildCampaign(m) {
  const c = getCampaignOr(m);
  if (c.memoryJobRunning || c._catchupRunning) throw new Error('记忆任务运行中，稍后再重建');
  if (!c.transcript.length) throw new Error('战役没有对话原文，无法重建');
  for (const f of MEMORY_MD_FILES) {
    const p = path.join(c.dir, f);
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, p + '.pre-rebuild.bak');
      fs.unlinkSync(p);
    }
  }
  c.meta.catchupTo = 0;
  c.meta.catchupTarget = c.transcript.length;
  saveCampaign(c);
  console.log(`[campaign] ${c.id} 档案已清空（备份 *.pre-rebuild.bak），开始重建（${c.transcript.length} 轮）`);
  runCatchup(c); // 后台跑，进度经 catchup 广播
  return { ok: true, campaignId: c.id, turns: c.transcript.length };
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

// ---------- OpenAI 兼容上游调用 ----------
const API_TIMEOUT_MS = 600_000;      // 非流式单发总时长（记忆 agent 高推理档一轮可能数分钟）
const API_IDLE_TIMEOUT_MS = 300_000; // 流式：连续这么久无任何数据块视为死流

// 带状态码的上游错误，供下游映射成合适的响应码（429 透传、其余 4xx/5xx → 502）
function httpError(status, detail) {
  const err = new Error(`api HTTP ${status}${detail ? `：${String(detail).slice(0, 300)}` : ''}`);
  err.status = status;
  return err;
}

// content 可能是 string 或多模态数组，统一取纯文本
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

// 超时 + 外部取消（客户端断开）合成一个 AbortSignal；reset() 用于流式空闲计时
function apiAbort(timeoutMs, external, label) {
  const ac = new AbortController();
  const fire = () => ac.abort(Object.assign(new Error(label), { status: 504 }));
  let timer = setTimeout(fire, timeoutMs);
  const onExt = () => ac.abort(new Error('客户端已断开，上游请求取消'));
  external?.addEventListener('abort', onExt, { once: true });
  return {
    signal: ac.signal,
    reset: () => { clearTimeout(timer); timer = setTimeout(fire, timeoutMs); },
    done: () => { clearTimeout(timer); external?.removeEventListener('abort', onExt); },
  };
}
const abortReason = (signal) =>
  (signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || '请求被取消')));

// openaiRaw：任意 payload 的 POST /chat/completions（记忆 agent 循环、api 出词共用）
async function openaiRaw({ url, key }, payload, { signal = null } = {}) {
  const ab = apiAbort(API_TIMEOUT_MS, signal, `上游 ${API_TIMEOUT_MS / 1000}s 无响应`);
  try {
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: ab.signal,
    });
    if (!r.ok) throw httpError(r.status, await r.text().catch(() => ''));
    return await r.json();
  } catch (e) {
    throw ab.signal.aborted ? abortReason(ab.signal) : e;
  } finally {
    ab.done();
  }
}

// 流式补全：按 SSE 事件边界解析（多行 data:、CRLF、EOF 尾行无换行都能处理），逐段
// 回调 onDelta，返回 { text, usage, finish }。容错反代常见变体：200 但回 JSON 错误体/
// 整段 completion、不支持 stream_options（自动降级重试）、发完 [DONE] 不断连（主动收工）、
// reasoning 增量（只算活跃度不透传）。onOpen 在确认上游可读后才触发，调用方此时再向
// 下游发 200，避免上游一开始就报错时只能回半截空 SSE。
async function openaiChatStream({ url, key }, payload, onDelta, { onOpen = null, signal = null } = {}) {
  const ab = apiAbort(API_IDLE_TIMEOUT_MS, signal, `上游流 ${API_IDLE_TIMEOUT_MS / 1000}s 无数据`);
  try {
    const doFetch = (withUsage) => fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(withUsage
        ? { ...payload, stream: true, stream_options: { include_usage: true } }
        : { ...payload, stream: true }),
      signal: ab.signal,
    });
    let r = await doFetch(true);
    if (r.status === 400) {
      const detail = await r.text().catch(() => '');
      if (!/stream_options/i.test(detail)) throw httpError(400, detail);
      console.warn('[chat] 上游不支持 stream_options，已降级重试（本轮用量可能记不上）');
      r = await doFetch(false);
    }
    if (!r.ok) throw httpError(r.status, await r.text().catch(() => ''));

    const ctype = r.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream')) {
      // 声明了 stream 却回整段 JSON：可能是错误对象，也可能是无视 stream 的普通 completion
      const raw = await r.text();
      let j = null;
      try { j = JSON.parse(raw); } catch { /* 非 JSON 走下面的兜底报错 */ }
      if (j?.error) throw new Error(`上游错误：${String(j.error.message || JSON.stringify(j.error)).slice(0, 300)}`);
      if (!j?.choices) throw new Error(`上游返回了非 SSE 响应（${ctype || '无 content-type'}）：${raw.slice(0, 200)}`);
      const whole = contentText(j.choices[0]?.message?.content);
      onOpen?.();
      if (whole) onDelta(whole);
      return { text: whole, usage: j.usage || null, finish: j.choices[0]?.finish_reason || 'stop' };
    }

    onOpen?.();
    let text = '';
    let usage = null;
    let finish = null;
    let sawDone = false;
    let sawReasoning = false;
    let evErr = null;
    const handleEvent = (data) => {
      if (data === '[DONE]') { sawDone = true; return; }
      let j;
      try { j = JSON.parse(data); } catch { return; }
      if (j.error) {
        evErr = new Error(`上游流内错误：${String(j.error.message || JSON.stringify(j.error)).slice(0, 300)}`);
        sawDone = true;
        return;
      }
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (ch?.finish_reason) finish = ch.finish_reason;
      const d = ch?.delta || {};
      if (d.reasoning_content || d.reasoning || d.thinking) sawReasoning = true;
      const piece = contentText(d.content);
      if (piece) { text += piece; onDelta(piece); }
    };
    let buf = '';
    let evData = [];
    const feed = (s) => {
      buf += s;
      let nl;
      while (!sawDone && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (evData.length) { handleEvent(evData.join('\n')); evData = []; }
        } else if (line.startsWith('data:')) {
          evData.push(line.slice(5).replace(/^ /, ''));
        } // 其余字段（event:/id:/注释心跳）忽略
      }
    };
    const decoder = new TextDecoder();
    for await (const chunk of r.body) {
      ab.reset(); // 任何数据（含 reasoning 增量、心跳）都算活着
      feed(decoder.decode(chunk, { stream: true }));
      if (sawDone) break; // 收到 [DONE] 或错误事件即收工，不陪发完不断连的反代干等
    }
    if (!sawDone) feed(decoder.decode() + '\n\n'); // EOF：冲洗解码器、补处理无换行尾行与未派发事件
    if (evErr) throw evErr;
    if (!text && sawReasoning) throw new Error('上游只返回了思维增量、未产出正文（反代可能未透传正文字段）');
    if (!text && !sawDone && !finish) throw new Error('上游流异常结束：未收到任何内容或终止标记');
    return { text, usage, finish: finish || 'stop' };
  } catch (e) {
    throw ab.signal.aborted ? abortReason(ab.signal) : e;
  } finally {
    ab.done();
  }
}

// 通用单轮补全（记忆 api 模式与回溯 api 模式共用）
async function openaiChat({ url, key, model }, system, prompt) {
  const j = await openaiRaw({ url, key }, {
    model,
    stream: false,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
  });
  return { text: contentText(j.choices?.[0]?.message?.content), usage: j.usage || null };
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

// 记忆任务每次动笔前把现有档案滚动备份到 memory/backups/<战役id>/<时间戳>-<来源>/，
// 环形保留最近 10 份——agent 万一改坏文件（或某批补课跑偏）可手工拷回。放在战役目录
// 之外是刻意的：sdk 模式记忆 agent 的 cwd 在战役目录内，别让它 Glob 到旧备份产生混淆。
const BACKUP_KEEP = 10;
function backupMemoryFiles(campaign, reason) {
  try {
    const files = MEMORY_MD_FILES.filter(f => fs.existsSync(path.join(campaign.dir, f)));
    if (!files.length) return;
    const root = path.join(MEMORY_ROOT, 'backups', campaign.id);
    const dir = path.join(root, `${new Date().toISOString().replace(/[-:TZ.]/g, '')}-${reason}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(campaign.dir, f), path.join(dir, f));
    const all = fs.readdirSync(root).sort();
    for (const d of all.slice(0, Math.max(0, all.length - BACKUP_KEEP)))
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
  } catch (e) {
    console.warn(`[memory] ${campaign.id} 档案滚动备份失败（不阻塞更新）:`, e.message);
  }
}

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

  const { query } = await loadSdk();
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
  const written = writeMemoryFiles(campaign, out);
  console.log(`[memory] ${campaign.id} 更新完成 (api, ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${written} 个文件)${tag}`);
}

// 解析"全文件重写"协议输出并落盘，返回写入的文件数（api 模式与补课 api 模式共用）
function writeMemoryFiles(campaign, out) {
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
  return written;
}

// ---------- 记忆 agent（API 函数调用循环，MEMORY_MODE=agent） ----------
// 面向无 Claude 订阅的部署：任意支持工具调用的 OpenAI 兼容端点（GPT/Grok 等前沿模型），
// 与 sdk 模式一样做增量编辑。工具围栏：只可写五个档案 md、transcript 只读，
// 全部操作锁死在战役目录内。不支持工具调用的模型请用 api（全文件重写）模式。
const AGENT_TOOLS = [
  { type: 'function', function: { name: 'read_file',
    description: '读取战役档案或对话归档。name 为五个档案 md 之一或 transcript.jsonl；读 transcript 时可用 from/to（1-based 轮号）限定范围，缺省返回最后 30 轮。',
    parameters: { type: 'object', properties: {
      name: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' },
    }, required: ['name'] } } },
  { type: 'function', function: { name: 'write_file',
    description: '整体重写一个档案 md（内容完全替换，新建也用它）。',
    parameters: { type: 'object', properties: {
      name: { type: 'string' }, content: { type: 'string' },
    }, required: ['name', 'content'] } } },
  { type: 'function', function: { name: 'edit_file',
    description: '在档案 md 中做精确替换：old_string 必须与文件现有内容逐字一致（含空白与换行），替换第一处出现。',
    parameters: { type: 'object', properties: {
      name: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
    }, required: ['name', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'search_transcript',
    description: '在对话归档全文中逐字检索关键词，返回命中轮的轮号与上下文节选（最多 8 处）。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

function agentToolExec(campaign, name, args) {
  if (name === 'read_file') {
    const f = String(args.name || '');
    if (f === 'transcript.jsonl') {
      const t = campaign.transcript;
      const from = Math.max(1, Number(args.from) || Math.max(1, t.length - 29));
      const to = Math.min(t.length, Number(args.to) || t.length);
      if (from > to) return '（范围为空）';
      return t.slice(from - 1, to).map((x, i) => `#${from + i} [${x.role}] ${(x.content || '').slice(0, 2000)}`).join('\n');
    }
    if (!MEMORY_MD_FILES.includes(f)) return `错误：${f} 不在可读白名单（五个档案 md 或 transcript.jsonl）`;
    const p = path.join(campaign.dir, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 30000) : '（尚不存在）';
  }
  if (name === 'write_file') {
    const f = String(args.name || '');
    if (!MEMORY_MD_FILES.includes(f)) return `错误：${f} 不在档案白名单，禁止写入`;
    // 缺 content 直接拒绝：不规范上游漏传参数时不能把档案清成空文件
    if (typeof args.content !== 'string' || !args.content) return '错误：write_file 缺少 content（整体重写必须给出完整新内容）';
    fs.mkdirSync(campaign.dir, { recursive: true });
    fs.writeFileSync(path.join(campaign.dir, f), args.content);
    return `已写入 ${f}（${Buffer.byteLength(args.content)} 字节）`;
  }
  if (name === 'edit_file') {
    const f = String(args.name || '');
    if (!MEMORY_MD_FILES.includes(f)) return `错误：${f} 不在档案白名单，禁止写入`;
    const p = path.join(campaign.dir, f);
    if (!fs.existsSync(p)) return `错误：${f} 尚不存在，请用 write_file 创建`;
    const text = fs.readFileSync(p, 'utf8');
    const old = String(args.old_string ?? '');
    if (!old || !text.includes(old)) return '错误：old_string 未在文件中找到（须与现文逐字一致）';
    // 漏传 new_string 时不能默默当成删除；要删须显式传空字符串
    if (typeof args.new_string !== 'string') return '错误：edit_file 缺少 new_string（删除内容请显式传空字符串）';
    fs.writeFileSync(p, text.replace(old, args.new_string));
    return `已替换 ${f} 中的一处内容`;
  }
  if (name === 'search_transcript') {
    const q = String(args.query || '').trim();
    if (!q) return '错误：query 为空';
    const hits = [];
    for (let i = 0; i < campaign.transcript.length && hits.length < 8; i++) {
      const c = campaign.transcript[i].content || '';
      const at = c.indexOf(q);
      if (at >= 0) hits.push(`#${i + 1} [${campaign.transcript[i].role}] …${c.slice(Math.max(0, at - 80), at + 220).replace(/\s+/g, ' ')}…`);
    }
    return hits.length ? hits.join('\n') : '无命中';
  }
  return `错误：未知工具 ${name}`;
}

// 函数调用循环：每回合一次上游调用，执行其 tool_calls 后把结果塞回，直到模型
// 不再调用工具（视为完成）或超出 MEMORY_MAX_TURNS。用量跨回合累计成一份。
async function runMemoryAgent(campaign, system, userContent) {
  const cfg = { url: CFG.MEMORY_API_URL, key: CFG.MEMORY_API_KEY };
  const messages = [{ role: 'system', content: system }, { role: 'user', content: userContent }];
  const total = { prompt: 0, completion: 0, cached: 0 };
  for (let round = 1; round <= CFG.MEMORY_MAX_TURNS; round++) {
    const r = await openaiRaw(cfg, { model: CFG.MEMORY_API_MODEL, messages, tools: AGENT_TOOLS, stream: false });
    const u = r.usage || {};
    total.prompt += u.prompt_tokens || 0;
    total.completion += u.completion_tokens || 0;
    total.cached += u.prompt_tokens_details?.cached_tokens || 0;
    const msg = r.choices?.[0]?.message;
    if (!msg) throw new Error('agent 响应缺少 message');
    messages.push(msg);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) {
      // 没调工具但是被 token 上限截断的，不能当"正常收尾"接受
      if (r.choices?.[0]?.finish_reason === 'length') throw new Error('agent 响应被截断（finish_reason=length）');
      return {
        rounds: round,
        usage: { prompt_tokens: total.prompt, completion_tokens: total.completion,
          prompt_tokens_details: { cached_tokens: total.cached } },
      };
    }
    for (const call of calls) {
      let result;
      try {
        // 有些兼容端点把 arguments 直接给成对象而非 JSON 字符串
        const rawArgs = call.function?.arguments;
        const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}')
          : (rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
        result = agentToolExec(campaign, call.function?.name, args);
      } catch (e) { result = `错误：${e.message}`; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }
  throw new Error(`agent 超出工具回合上限 ${CFG.MEMORY_MAX_TURNS}`);
}

const AGENT_TOOL_GUIDE = '当前档案全文已在用户消息的 <current_files> 中给出，不必再读一遍：小改动用 edit_file 精确替换（old_string 须与现文逐字一致），新建或大改用 write_file 整体重写；需要核对更早剧情时用 search_transcript 或 read_file("transcript.jsonl")。完成全部更新后以纯文本收尾（不再调用工具即视为完成）；若本轮无需任何更新，直接说明即可。';

function currentFilesBlock(campaign) {
  return MEMORY_MD_FILES.map(f => {
    const p = path.join(campaign.dir, f);
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 12000) : '（尚不存在）';
    return `===FILE: ${f}===\n${text}`;
  }).join('\n\n');
}

async function updateMemoryAgent(campaign, lastUserText, replyText, notes, startedAt, replyNo) {
  const system = [
    '你是战役记忆管理器。根据最新一轮交互，用文件工具增量更新战役档案。档案文件及用途：',
    ...MEMORY_FILE_SPEC,
    MEMORY_RULES,
    AGENT_TOOL_GUIDE,
  ].join('\n');
  const prompt = `<current_files>\n${currentFilesBlock(campaign)}\n</current_files>\n\n${memoryExchangeBlock(lastUserText, replyText, notes, replyNo)}`;
  const { usage, rounds } = await runMemoryAgent(campaign, system, prompt);
  const tag = trackUsage('memory', campaign, usage);
  console.log(`[memory] ${campaign.id} 更新完成 (agent, ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${rounds} rounds)${tag}`);
}

// 本轮交互未能记账（任务失败/被跳过）时，降级为修正说明挂账：下一次更新的
// <corrections> 块里带轮号和节选要求补记，sdk 模式的 agent 还能按轮号自行
// Read transcript.jsonl 核对全文。挂账上限防连续失败时膨胀。
function queueMissedExchange(campaign, replyNo, lastUserText, replyText, why) {
  if (campaign.pendingNotes.length >= 8) return;
  campaign.pendingNotes.push(
    `第#${replyNo - 1}-#${replyNo} 轮交互${why}未入档，请补记该轮的叙事事实（若档案已含该轮内容则忽略；`
    + `完整原文在 transcript.jsonl 第 ${replyNo - 1}-${replyNo} 行）。节选：\n`
    + `[用户] ${String(lastUserText || '').slice(0, 600)}\n[回复] ${String(replyText || '').slice(0, 2000)}`,
  );
}

async function updateMemory(campaign, lastUserText, replyText) {
  if (campaign.memoryJobRunning) {
    console.log(`[memory] ${campaign.id} 上一轮任务未结束，本轮跳过（已挂账补记）`);
    queueMissedExchange(campaign, campaign.transcript.length, lastUserText, replyText, '因上一任务未结束被跳过');
    return;
  }
  campaign.memoryJobRunning = true;
  backupMemoryFiles(campaign, 'auto');
  const notes = campaign.pendingNotes.splice(0);
  const startedAt = Date.now();
  // 回复刚被 push 进 transcript，其 1-based 轮号即当前长度；极端和解（整体替换）可能
  // 让旧轮号漂移，属可接受误差——轮号指针是尽力而为的导航，不是强一致索引。
  const replyNo = campaign.transcript.length;
  try {
    const mode = memoryModeNow();
    if (mode === 'api') await updateMemoryApi(campaign, lastUserText, replyText, notes, startedAt, replyNo);
    else if (mode === 'agent') await updateMemoryAgent(campaign, lastUserText, replyText, notes, startedAt, replyNo);
    else await updateMemorySdk(campaign, lastUserText, replyText, notes, startedAt, replyNo);
    saveCampaign(campaign); // 持久化 meta 里的用量累计
  } catch (e) {
    campaign.pendingNotes.unshift(...notes); // 失败不丢修正，下一轮补上
    queueMissedExchange(campaign, replyNo, lastUserText, replyText, '因任务失败'); // 交互本身也补记
    console.error(`[memory] ${campaign.id} 更新失败:`, e.message);
  } finally {
    campaign.memoryJobRunning = false;
  }
}

// ---------- 补课（导入旧对话后的档案回填） ----------
// 分批把已归档但未记账的早期轮次喂给记忆 agent，构建 timeline（含轮号标注）等
// 档案。批间落盘 meta.catchupTo，中断后重新触发即可续跑；每批复用 memoryJobRunning
// 互斥，与在线对话的常规记忆更新互不重入（补课批运行期间，当轮更新会照常跳过）。
const CATCHUP_RULES = '补课规则：timeline 按时间顺序为这批轮次补写条目（骨架格式，每条 200 字内只记骨架：时间地点、人物、事件与结果、数值变化；条目末尾标注来源轮号如（#12-13），轮号已在每条消息的属性中直接给出，照抄即可）。world_state/party/npc_ledger/foreshadowing 更新到这批轮次为止的最新状态（后续批次会继续推进，不必预判）。聊天原文中的变量标记、状态栏/前端代码、思维链推演等非叙事内容一律不要写入档案。不要为核对而去通读 transcript 的其他部分——快进快出。';

function catchupBlock(campaign, from, to) {
  const lines = [];
  for (let i = from; i < to; i++) {
    const t = campaign.transcript[i];
    lines.push(`<turn 轮号="#${i + 1}" role="${t.role}">`, (t.content || '').slice(0, 6000), '</turn>');
  }
  return `<archived_turns range="#${from + 1}-#${to}">\n${lines.join('\n')}\n</archived_turns>`;
}

async function catchupBatchSdk(campaign, from, to) {
  const prompt = [
    '你是战役记忆管理器。这是一次"补课"：战役对话原文已完整归档，但档案尚未覆盖下面这批早期轮次。请通读这批原文，把其中的叙事事实补入当前目录下的战役档案（Markdown 文件）。',
    '维护这些文件（不存在则创建）：',
    ...MEMORY_FILE_SPEC,
    CATCHUP_RULES,
    '',
    catchupBlock(campaign, from, to),
  ].join('\n');
  const { query } = await loadSdk();
  let tag = '';
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
      tag = trackUsage('memory', campaign, msg.usage);
      if (msg.subtype !== 'success') throw new Error(`SDK result: ${msg.subtype}`);
    }
  }
  return tag;
}

async function catchupBatchAgent(campaign, from, to) {
  const system = [
    '你是战役记忆管理器。这是一次"补课"：战役对话原文已完整归档，但档案尚未覆盖这批早期轮次。请通读原文，用文件工具把其中的叙事事实补入战役档案。档案文件及用途：',
    ...MEMORY_FILE_SPEC,
    CATCHUP_RULES,
    AGENT_TOOL_GUIDE,
  ].join('\n');
  const prompt = `<current_files>\n${currentFilesBlock(campaign)}\n</current_files>\n\n${catchupBlock(campaign, from, to)}`;
  const { usage, rounds } = await runMemoryAgent(campaign, system, prompt);
  return trackUsage('memory', campaign, usage) + ` (${rounds} rounds)`;
}

async function catchupBatchApi(campaign, from, to) {
  const current = currentFilesBlock(campaign);
  const system = [
    '你是战役记忆管理器。这是一次"补课"：战役对话原文已完整归档，但档案尚未覆盖这批早期轮次。档案文件及用途：',
    ...MEMORY_FILE_SPEC,
    CATCHUP_RULES,
    '输出格式：仅输出有变化的文件；每个文件以单独一行 ===FILE: 文件名=== 开头，紧跟该文件更新后的完整内容；除此之外不要输出任何解释。若这批轮次无需任何更新，只输出 NO_UPDATE。',
  ].join('\n');
  const prompt = `<current_files>\n${current}\n</current_files>\n\n${catchupBlock(campaign, from, to)}`;
  const { text: out, usage } = await openaiChat({ url: CFG.MEMORY_API_URL, key: CFG.MEMORY_API_KEY, model: CFG.MEMORY_API_MODEL }, system, prompt);
  const tag = trackUsage('memory', campaign, usage);
  if (!/^\s*NO_UPDATE\b/.test(out.trim())) writeMemoryFiles(campaign, out);
  return tag;
}

async function runCatchup(campaign) {
  if (campaign._catchupRunning) {
    broadcastAdmin({ type: 'catchup', campaignId: campaign.id, status: 'error', error: '补课已在进行中' });
    return;
  }
  const target = Math.min(Number(campaign.meta.catchupTarget ?? campaign.transcript.length), campaign.transcript.length);
  let from = Math.max(0, Number(campaign.meta.catchupTo ?? 0));
  if (from >= target) {
    console.log(`[memory] ${campaign.id} 补课：无待覆盖轮次（已至 #${from}/#${target}）`);
    broadcastAdmin({ type: 'catchup', campaignId: campaign.id, status: 'done', done: from, total: target });
    return;
  }
  campaign._catchupRunning = true;
  console.log(`[memory] ${campaign.id} 补课开始：#${from + 1}-#${target}，每批 ${CFG.CATCHUP_BATCH} 轮`);
  try {
    while (from < target) {
      const to = Math.min(from + CFG.CATCHUP_BATCH, target);
      while (campaign.memoryJobRunning) await sleep(3000); // 等常规记忆更新让位
      campaign.memoryJobRunning = true;
      backupMemoryFiles(campaign, 'catchup');
      const startedAt = Date.now();
      try {
        const mode = memoryModeNow();
        const tag = mode === 'api' ? await catchupBatchApi(campaign, from, to)
          : mode === 'agent' ? await catchupBatchAgent(campaign, from, to)
            : await catchupBatchSdk(campaign, from, to);
        console.log(`[memory] ${campaign.id} 补课 #${from + 1}-#${to} 完成 (${((Date.now() - startedAt) / 1000).toFixed(1)}s)${tag}`);
      } finally {
        campaign.memoryJobRunning = false;
      }
      from = to;
      campaign.meta.catchupTo = from;
      saveCampaign(campaign);
      broadcastAdmin({ type: 'catchup', campaignId: campaign.id, status: 'running', done: from, total: target });
    }
    console.log(`[memory] ${campaign.id} 补课完成：档案已覆盖 #1-#${target}`);
    broadcastAdmin({ type: 'catchup', campaignId: campaign.id, status: 'done', done: target, total: target });
  } catch (e) {
    console.error(`[memory] ${campaign.id} 补课中断（已完成到 #${from}，再次触发补课即可续跑）:`, e.message);
    broadcastAdmin({ type: 'catchup', campaignId: campaign.id, status: 'error', error: e.message, done: from, total: target });
  } finally {
    campaign._catchupRunning = false;
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
  const { query } = await loadSdk();
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

// ---------- BM25（中文 1/2-gram 免词典分词） ----------
// 给关键词字面检索补两块短板：①命中超预算时按相关度取舍，而非按轮号先到先得；
// ②字面失配时模糊兜底——出词给"星陨匕首"、原文写"星陨石匕首"，靠双字碎片重叠仍能搭上。
// 分词不用词典：汉字逐字（unigram）+ 相邻双字（bigram），拉丁字母/数字按整词；
// IDF 自动把"的/了"这类常见字压成近零权重，稀有双字（专有名词碎片）权重最高，
// 相当于免费得到一个能认自造名词的"伪分词"。打分是经典 Okapi BM25 三件套：
// 词频饱和（k1）、稀有词加权（IDF）、长文惩罚（b）。
const BM25_K1 = 1.5, BM25_B = 0.75;

function bmTokens(text) {
  const tokens = [];
  const re = /[a-z0-9_]+|[㐀-鿿]+/gi;
  const s = String(text || '').toLowerCase();
  let m;
  while ((m = re.exec(s)) !== null) {
    if (/[㐀-鿿]/.test(m[0])) {
      const chars = [...m[0]];
      tokens.push(...chars);
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    } else tokens.push(m[0]);
  }
  return tokens;
}

// 对可检索范围内的每一轮打 BM25 分。语料就是这些轮次本身、每次现算：几百轮也只是
// 几十毫秒的纯计数（相对出词模型的秒级调用可忽略），不值得为省它维护持久索引
// （重roll 截尾、导入和解整体替换的失效处理反而更容易出错）。
function bm25Scores(transcript, searchable, queryTokens) {
  // 双字/整词是"强 token"：一轮至少命中一个强 token 才有资格得分，
  // 只靠单字重叠的命中全是噪音。查询里一个强 token 都没有时直接不打分。
  const strong = queryTokens.filter(tok => [...tok].length >= 2);
  const scores = new Float64Array(searchable);
  if (!strong.length) return scores;
  const querySet = new Set(queryTokens);
  const docs = [];
  const df = new Map(); // 只统计查询 token 的文档频次（IDF 只用得到它们）
  let totalLen = 0;
  for (let i = 0; i < searchable; i++) {
    const tf = new Map();
    const toks = bmTokens(transcript[i].content);
    for (const tok of toks) tf.set(tok, (tf.get(tok) || 0) + 1);
    for (const tok of tf.keys()) if (querySet.has(tok)) df.set(tok, (df.get(tok) || 0) + 1);
    docs.push({ tf, len: toks.length });
    totalLen += toks.length;
  }
  const avgLen = totalLen / Math.max(1, searchable) || 1;
  for (let i = 0; i < searchable; i++) {
    const d = docs[i];
    if (!strong.some(tok => d.tf.has(tok))) continue;
    let score = 0;
    for (const tok of queryTokens) {
      const tf = d.tf.get(tok) || 0;
      if (!tf) continue;
      const n = df.get(tok) || 0;
      const idf = Math.log(1 + (searchable - n + 0.5) / (n + 0.5));
      score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * d.len / avgLen));
    }
    scores[i] = score;
  }
  return scores;
}

// 进程内检索：只扫提示词窗口之外的早期轮次。四级候选按优先级取舍：
//   pinned（轮号指针直取）> literal（关键词字面命中，命中轮±1 作 neighbor 陪同）> fuzzy（BM25 模糊兜底）
// 同级内按 BM25 相关度排序，预算吃紧时留最相关的；最终按轮号升序呈现。
// RECALL_BM25=off 时退回纯字面匹配（不打分、无模糊），级内按轮号先后。
function selectArchiveHits(campaign, queries, turnSpecs = []) {
  const t0 = Date.now();
  const t = campaign.transcript;
  const searchable = Math.max(0, campaign._searchableTo ?? (t.length - CFG.RECENT_TURNS));
  const empty = { searchable, hits: [], counts: { pinned: 0, literal: 0, neighbor: 0, fuzzy: 0 }, tookMs: 0 };
  if (!searchable) return empty;
  const RANK = { pinned: 3, literal: 2, neighbor: 1, fuzzy: 0 };
  const cand = new Map(); // i -> { i, kind, score }
  const put = (i, kind, score = 0) => {
    const prev = cand.get(i);
    if (!prev) { cand.set(i, { i, kind, score }); return; }
    if (RANK[kind] > RANK[prev.kind]) prev.kind = kind;
    if (score > prev.score) prev.score = score;
  };
  for (const spec of turnSpecs) {
    const m = String(spec).match(/^#?\s*(\d+)(?:\s*[-~～—]\s*#?(\d+))?$/);
    if (!m) continue;
    let a = Number(m[1]), b = Number(m[2] || m[1]);
    if (b < a) [a, b] = [b, a];
    b = Math.min(b, a + 19); // 单个范围最多展开 20 轮，防误写大范围；总量仍受 RECALL_BUDGET 截断
    for (let n = a; n <= b; n++) {
      const i = n - 1; // 轮号 1-based → 数组下标
      if (i >= 0 && i < searchable) put(i, 'pinned');
    }
  }
  const useBm25 = CFG.RECALL_BM25 === 'on' && queries.length > 0;
  const queryTokens = useBm25 ? [...new Set(queries.flatMap(q => bmTokens(q)))] : [];
  const scores = useBm25 ? bm25Scores(t, searchable, queryTokens) : null;
  for (const q of queries) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (let i = 0; i < searchable; i++) {
      if (re.test(t[i].content || '')) {
        const s = scores ? scores[i] : 0;
        put(i, 'literal', s);
        if (i > 0) put(i - 1, 'neighbor', s);
        if (i + 1 < searchable) put(i + 1, 'neighbor', s);
      }
    }
  }
  if (scores) {
    // 模糊兜底：全库最高分的 30% 作相对门槛（无字面命中时门槛自然落在模糊命中自身的量级），
    // 最多补 6 轮，不带邻轮（模糊命中是推测性的，不值得花双倍预算）。
    let top = 0;
    for (let i = 0; i < searchable; i++) if (scores[i] > top) top = scores[i];
    const fuzzy = [];
    for (let i = 0; i < searchable; i++)
      if (scores[i] > 0 && scores[i] >= top * 0.3 && !cand.has(i)) fuzzy.push(i);
    fuzzy.sort((a, b) => scores[b] - scores[a]);
    for (const i of fuzzy.slice(0, 6)) put(i, 'fuzzy', scores[i]);
  }
  const ordered = [...cand.values()].sort((a, b) =>
    RANK[b.kind] - RANK[a.kind] || b.score - a.score || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const c of ordered) {
    const line = `#${c.i + 1} [${t[c.i].role}] ${(t[c.i].content || '').replace(/\s+/g, ' ').slice(0, 600)}`;
    if (used + line.length > CFG.RECALL_BUDGET) break;
    picked.push({ ...c, line });
    used += line.length;
  }
  picked.sort((a, b) => a.i - b.i);
  const counts = { pinned: 0, literal: 0, neighbor: 0, fuzzy: 0 };
  for (const c of picked) counts[c.kind]++;
  return { searchable, hits: picked, counts, tookMs: Date.now() - t0 };
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
  const sel = selectArchiveHits(campaign, queries, turnSpecs);
  if (!sel.hits.length) {
    console.log(`[recall] ${campaign.id} 检索 [${label}] 无命中 (${Date.now() - started}ms)${tag}`);
    return '';
  }
  const c = sel.counts;
  const breakdown = [c.literal && `字面 ${c.literal}`, c.neighbor && `邻轮 ${c.neighbor}`,
    c.pinned && `指针 ${c.pinned}`, c.fuzzy && `模糊 ${c.fuzzy}`].filter(Boolean).join('、');
  let content = sel.hits.map(h => h.line).join('\n');
  if (content.length > 2500) { // 命中较多时再花一次调用压缩，避免注入过长
    const sSystem = '把检索到的对话片段压缩成与当前话题相关的备忘录（300字以内）。保留具体数字、名字、承诺与关键原话，并保留轮号标注（#N）。只输出备忘录正文。';
    const syn = await completeText(sSystem,
      `<latest_message>\n${lastUserText.slice(0, 1000)}\n</latest_message>\n\n<excerpts>\n${content}\n</excerpts>`);
    content = syn.text;
    tag += trackUsage('recall', campaign, syn.usage);
  }
  console.log(`[recall] ${campaign.id} 检索 [${label}] 命中 ${sel.hits.length} 段（${breakdown}），注入 ${content.length} 字符 (${Date.now() - started}ms)${tag}`);
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

// 骰子 MCP 服务器懒构建（依赖 Agent SDK，仅 sdk 通道的 tool 模式用到）
let _diceServer = null;
async function getDiceServer() {
  if (_diceServer) return _diceServer;
  const { tool, createSdkMcpServer } = await loadSdk();
  _diceServer = createSdkMcpServer({
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
  return _diceServer;
}

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

  // 聊天键：ST 扩展经 custom_include_body 随请求盖章的当前聊天文件标识，
  // 战役识别的第一优先级（见 resolveCampaign）
  const chatKey = normChatKey(body.tavern_chat_key);
  // 压缩形态防呆：clewd/squash 类预设会把全部历史压成一条巨型消息，轮次结构已不可信。
  // 此时不关联战役——不归档、不记忆、不回溯，纯转发生成，避免把预设脚手架写进档案。
  const malformed = turns.some(t => (t.content || '').length > 60000);
  if (malformed && turns.length) {
    console.warn('[campaign] 检测到超长单条消息（疑似预设压缩历史/clewd 形态），本请求不关联战役：归档、记忆、回溯均停用');
  }
  let campaign = null;
  if (turns.length && !malformed) {
    campaign = resolveCampaign(turns, chatKey);
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
  const droppedNote = dropped > 0 ? `（更早的 ${dropped} 条对话已归档进战役记忆，见下方 campaign_memory）` : '';
  const memoryText = campaign ? readMemory(campaign) : '';
  const prompt = [droppedNote, '<transcript>', transcriptText, '</transcript>', memoryText]
    .filter(Boolean).join('\n');

  // recent/droppedNote/memoryText 供 api 通道组装原生 messages 数组（sdk 通道用拼好的 prompt）
  return { campaign, systemPrompt, prompt, recent, droppedNote, memoryText, lastUserText };
}

// ---------- SDK 调用 ----------
async function* generate(model, systemPrompt, prompt, cwd, usageOut = {}, withDice = false) {
  const { query } = await loadSdk();
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
        ? { mcpServers: { dice: await getDiceServer() }, allowedTools: ['mcp__dice__roll'], maxTurns: CFG.DICE_MAX_TURNS }
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

// 转发 ST 请求里的常用生成参数（api 通道用；SDK 通道由 Claude Code 自管）
function pickGenParams(body) {
  const out = {};
  for (const k of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty',
    'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'stop']) {
    if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
  }
  // 两种 token 上限并存时只发新式的，部分端点会拒绝同时出现
  if (out.max_tokens !== undefined && out.max_completion_tokens !== undefined) delete out.max_tokens;
  return out;
}

async function handleChat(req, res, body) {
  const { campaign, systemPrompt: baseSystem, prompt, recent, droppedNote, memoryText, lastUserText } = buildPrompt(body);
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
  const chatApi = chatModeNow() === 'api';
  const model = chatApi
    ? (CFG.CHAT_API_MODEL || body.model || 'api-model')
    : (MODELS.includes(body.model) ? body.model : CFG.BRIDGE_MODEL);
  const cwd = campaign ? campaign.dir : MEMORY_ROOT;
  const usageOut = {};
  let full = '';

  // 掷骰：按 system（预设+卡+世界书）中的规则关键词决定是否启用，非跑团场景零介入。
  // api 通道暂不支持工具掷骰（MCP 是 SDK 专属），tool 配置自动降级为熵池。
  let withDice = false;
  const diceCallsBefore = diceRollCount;
  const armed = diceArmed(baseSystem);
  if (armed && CFG.DICE_MODE === 'tool' && !chatApi) {
    systemPrompt += DICE_TOOL_HINT;
    withDice = true;
  } else if (armed && (CFG.DICE_MODE === 'pool' || (CFG.DICE_MODE === 'tool' && chatApi))) {
    if (CFG.DICE_MODE === 'tool') console.log('[dice] api 通道不支持工具掷骰，本轮降级为熵池注入');
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

  // api 通道：把窗口内轮次还原成原生 messages（GPT/Grok 的标准形态），
  // 归档说明/md 档案/回溯/骰池/续写指令合并进最后的 user 消息（保持"易变内容后置"）
  let apiPayload = null;
  if (chatApi) {
    const tailContent = [droppedNote, memoryText, promptTail].filter(Boolean).join('\n')
      + (droppedNote || memoryText || promptTail ? '\n\n' : '') + CFG.CONTINUE_PROMPT;
    const native = recent.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.content }));
    if (native.length && native[native.length - 1].role === 'user') {
      native[native.length - 1] = { role: 'user', content: native[native.length - 1].content + '\n\n' + tailContent };
    } else {
      native.push({ role: 'user', content: tailContent });
    }
    apiPayload = {
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...native],
      ...pickGenParams(body),
    };
  }
  const apiCfg = { url: CFG.CHAT_API_URL, key: CFG.CHAT_API_KEY };
  // 客户端断开（ST 停止生成/关页）时取消上游 fetch，省 token 也防悬挂
  const clientGone = new AbortController();
  if (chatApi) res.once('close', () => { if (!res.writableEnded) clientGone.abort(); });

  let finishOut = 'stop';
  const openSse = () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(sseChunk(id, model, { role: 'assistant', content: '' }));
  };
  try {
    if (stream) {
      if (chatApi) {
        // onOpen：确认上游可读后才向 ST 发 200，上游一上来就报错时能回真实错误码
        const r = await openaiChatStream(apiCfg, apiPayload, (text) => {
          full += text;
          res.write(sseChunk(id, model, { content: text }));
        }, { onOpen: openSse, signal: clientGone.signal });
        usageOut.usage = r.usage;
        finishOut = r.finish;
      } else {
        openSse();
        for await (const text of generate(model, systemPrompt, finalPrompt, cwd, usageOut, withDice)) {
          full += text;
          res.write(sseChunk(id, model, { content: text }));
        }
      }
      res.write(sseChunk(id, model, {}, finishOut, toOpenaiUsage(usageOut.usage)));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      if (chatApi) {
        const r = await openaiRaw(apiCfg, { ...apiPayload, stream: false }, { signal: clientGone.signal });
        full = contentText(r.choices?.[0]?.message?.content);
        finishOut = r.choices?.[0]?.finish_reason || 'stop';
        usageOut.usage = r.usage || null;
      } else {
        for await (const text of generate(model, systemPrompt, finalPrompt, cwd, usageOut, withDice)) full += text;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: finishOut }],
        usage: toOpenaiUsage(usageOut.usage),
      }));
    }
    if (finishOut !== 'stop') console.warn(`[chat] ⚠ 上游终止原因异常: ${finishOut}（length=被 token 上限截断，content_filter=被内容过滤）`);
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
      // 上游 429 透传（ST 可据此退避），超时 504，其余上游错误 502，桥内部错误 500
      const status = e.status === 429 ? 429 : e.status === 504 ? 504 : e.status ? 502 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'bridge_error' } }));
    } else if (!res.writableEnded) {
      // 已在流中：补一个结构化错误事件再收尾，别让 ST 只见半截静默 SSE
      if (stream) {
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'bridge_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
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
    hitRates: usageSummary(),
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
    let tooBig = false;
    req.on('error', () => {}); // 客户端上传中途断开时别抛未处理异常
    req.on('data', c => {
      if (tooBig) return;
      raw += c;
      if (raw.length > 64 * 1024 * 1024) {
        tooBig = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'request body too large (>64MiB)' } }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      let body;
      try { body = JSON.parse(raw); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json: ' + e.message } }));
        return;
      }
      // handleChat 自带 try/catch；这里兜底 buildPrompt 等前段的异常，别让请求悬空
      handleChat(req, res, body).catch(e => {
        console.error('[chat] 未捕获异常:', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message, type: 'bridge_error' } }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
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
      } else if (m.type === 'import') {
        let result;
        try { result = importCampaign(m); }
        catch (e) { result = { ok: false, error: e.message }; }
        ws.send(JSON.stringify({ type: 'importResult', ...result }));
      } else if (m.type === 'recallProbe') {
        // 检索调试探针：跳过出词模型，直接用给定关键词/轮号跑本地检索，返回带分数的命中明细
        let result;
        try {
          const c = getCampaignOr(m);
          const queries = (Array.isArray(m.queries) ? m.queries : [])
            .filter(q => typeof q === 'string' && q.trim()).slice(0, 8);
          const turns = (Array.isArray(m.turns) ? m.turns : []).map(s => String(s).trim()).filter(Boolean).slice(0, 8);
          const sel = selectArchiveHits(c, queries, turns);
          result = {
            ok: true, campaignId: c.id, searchable: sel.searchable, tookMs: sel.tookMs, counts: sel.counts,
            hits: sel.hits.map(h => ({ turn: h.i + 1, kind: h.kind, score: Math.round(h.score * 100) / 100, preview: h.line.slice(0, 120) })),
          };
        } catch (e) { result = { ok: false, error: e.message }; }
        ws.send(JSON.stringify({ type: 'recallProbeResult', ...result }));
      } else if (['locate', 'memoryFiles', 'saveMemoryFile', 'deleteCampaign', 'rebuild'].includes(m.type)) {
        const handlers = {
          locate: locateCampaign, memoryFiles: readMemoryFiles,
          saveMemoryFile, deleteCampaign, rebuild: rebuildCampaign,
        };
        let result;
        try { result = handlers[m.type](m); }
        catch (e) { result = { ok: false, error: e.message }; }
        ws.send(JSON.stringify({ type: m.type + 'Result', ...result }));
      } else if (m.type === 'catchup') {
        const campaign = campaigns.get(String(m.campaignId || ''));
        if (!campaign) {
          ws.send(JSON.stringify({ type: 'catchup', status: 'error', error: '战役不存在', campaignId: m.campaignId }));
        } else {
          runCatchup(campaign); // 后台跑，进度经 broadcast 推送
        }
      }
    });
    ws.send(JSON.stringify({
      type: 'hello',
      schema: CONFIG_SCHEMA,
      config: publicConfig(),
      info: { port: PORT, memoryRoot: MEMORY_ROOT, pid: process.pid, campaigns: campaigns.size, uptimeSec: Math.floor((Date.now() - START_TS) / 1000) },
      usage: usageSummary(),
      logs: logRing,
    }));
  });
});

loadCampaigns();
server.listen(PORT, '127.0.0.1', () => {
  const recallDesc = CFG.RECALL_MODE === 'off' ? 'off'
    : CFG.RECALL_MODE === 'api' ? `api(${CFG.RECALL_API_MODEL})` : `sdk(${CFG.RECALL_MODEL})`;
  const chatDesc = CFG.CHAT_MODE === 'api' ? `api(${CFG.CHAT_API_MODEL || '跟随请求'})` : `sdk(${CFG.BRIDGE_MODEL})`;
  const memoryDesc = CFG.MEMORY_MODE === 'sdk' ? `sdk(${CFG.MEMORY_MODEL || CFG.BRIDGE_MODEL})` : `${CFG.MEMORY_MODE}(${CFG.MEMORY_API_MODEL})`;
  const diceDesc = CFG.DICE_MODE === 'off' ? 'off' : `${CFG.DICE_MODE}/${CFG.DICE_TRIGGER}`;
  console.log(`st-claude-bridge listening on http://127.0.0.1:${PORT}/v1  (chat: ${chatDesc}, memory: ${memoryDesc}, recall: ${recallDesc}, dice: ${diceDesc}, campaigns: ${campaigns.size}, root: ${MEMORY_ROOT}, admin: ws://127.0.0.1:${PORT}/admin)`);
});

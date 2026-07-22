import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';

const require = createRequire(import.meta.url);
const LOGIN_CACHE_MS = 60_000;
const SDK_DEVELOPER_INSTRUCTIONS = [
  'You are the Codex backend for a SillyTavern bridge.',
  'Follow the task supplied on stdin and any system instructions embedded in it exactly.',
  'Return only what the task asks for; do not add task explanations unless requested.',
].join(' ');
let loginCache = { command: '', checkedAt: 0, ok: false, detail: '' };

// Codex 模式的合同是“只用 ChatGPT 登录态”。即便桥进程环境里恰好存在
// OpenAI/Azure key，也不让 SDK 子进程继承，避免认证优先级变化时意外转成按量 API。
export function chatGptOnlyEnv(env = process.env) {
  const clean = { ...env };
  for (const key of [
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY',
    'OPENAI_BASE_URL', 'CODEX_BASE_URL', 'AZURE_OPENAI_ENDPOINT',
    'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID',
  ]) delete clean[key];
  // Windows 从资源管理器或批处理启动 Node 时可能没有 HOME。Codex 在这种环境下
  // 不一定能定位到刚由桌面版/CLI 写入的 %USERPROFILE%\.codex\auth.json。
  if (process.platform === 'win32' && !String(clean.CODEX_HOME || '').trim()) {
    const profile = String(clean.USERPROFILE || '').trim()
      || (clean.HOMEDRIVE && clean.HOMEPATH
        ? `${clean.HOMEDRIVE}${clean.HOMEPATH}`
        : '');
    if (profile) clean.CODEX_HOME = path.win32.join(profile, '.codex');
  }
  return clean;
}

function resolveBundledCodexLaunch() {
  try {
    return {
      executable: process.execPath,
      prefix: [require.resolve('@openai/codex/bin/codex.js')],
    };
  } catch {
    return null;
  }
}

function findOnPath(name, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['.ps1', '.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* 继续找 */ }
    }
  }
  return '';
}

// 登录检查沿用用户可见的 codex 命令；实际生成由 SDK 自带的同版本 Codex runtime 执行。
export function resolveCodexLaunch(command = 'codex', env = process.env) {
  let resolved = command;
  const hasDir = /[\\/]/.test(command);
  if (!hasDir) {
    const onPath = findOnPath(command, env);
    if (!onPath && command.toLowerCase() === 'codex') {
      const bundled = resolveBundledCodexLaunch();
      if (bundled) return bundled;
    }
    resolved = onPath || command;
  }
  const ext = path.extname(resolved).toLowerCase();
  if (process.platform === 'win32' && ext === '.ps1') {
    return {
      executable: env.CODEX_POWERSHELL || 'powershell.exe',
      prefix: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolved],
    };
  }
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return { executable: env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c', resolved] };
  }
  return { executable: resolved, prefix: [] };
}

export function buildCodexSdkOptions(env = process.env, { mcpServers } = {}) {
  return {
    env: chatGptOnlyEnv(env),
    // apiKey 故意不传。官方 SDK 仅在显式传入 apiKey 时才注入 CODEX_API_KEY。
    config: {
      forced_login_method: 'chatgpt',
      model_provider: 'openai',
      history: { persistence: 'none' },
      developer_instructions: SDK_DEVELOPER_INSTRUCTIONS,
      ...(mcpServers ? { mcp_servers: mcpServers } : {}),
    },
  };
}

export function buildCodexThreadOptions({ cwd, model = '', effort = '', sandbox = 'read-only' }) {
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: sandbox,
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    ...(model ? { model } : {}),
    ...(effort ? { modelReasoningEffort: effort } : {}),
  };
}

export function buildDiceMcpServers({ serverPath, maxCalls = 12, nodePath = process.execPath }) {
  return {
    dice: {
      command: nodePath,
      args: [serverPath],
      env: { DICE_MAX_CALLS: String(maxCalls) },
      enabled: true,
      required: true,
      enabled_tools: ['roll'],
      default_tools_approval_mode: 'approve',
      tools: { roll: { approval_mode: 'approve' } },
      startup_timeout_sec: 10,
      tool_timeout_sec: 10,
    },
  };
}

export function parseCodexEvent(event) {
  if (!event || typeof event !== 'object') return {};
  if ((event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
      && event.item?.type === 'agent_message') {
    return {
      itemId: String(event.item.id || 'agent-message'),
      textSnapshot: String(event.item.text || ''),
    };
  }
  if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
    const content = Array.isArray(event.item.result?.content) ? event.item.result.content : [];
    return {
      mcpTool: {
        server: String(event.item.server || ''),
        tool: String(event.item.tool || ''),
        arguments: event.item.arguments,
        text: content.filter(x => x?.type === 'text').map(x => x.text).join('\n'),
        error: String(event.item.error?.message || ''),
        status: String(event.item.status || ''),
      },
    };
  }
  if (event.type === 'turn.completed') {
    const u = event.usage || {};
    const prompt = Number(u.input_tokens ?? u.total_input_tokens ?? 0) || 0;
    const cached = Number(u.cached_input_tokens ?? 0) || 0;
    const completion = Number(u.output_tokens ?? u.total_output_tokens ?? 0) || 0;
    return {
      usage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: cached },
      },
    };
  }
  if (event.type === 'turn.failed' || event.type === 'error') {
    const detail = event.error?.message || event.message || event.error || event.type;
    return { error: String(detail) };
  }
  return {};
}

function spawnCapture(launch, args, { cwd, env, input = '', timeoutMs = 30_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.executable, [...launch.prefix, ...args], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(result);
    };
    const stop = (reason) => {
      try { child.kill(); } catch { /* 已退出 */ }
      const e = new Error(reason);
      e.name = reason === 'codex 已取消' ? 'AbortError' : 'CodexTimeoutError';
      finish(e);
    };
    const onAbort = () => stop('codex 已取消');
    const timer = setTimeout(() => stop(`codex 超时 (${timeoutMs}ms)`), timeoutMs);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', e => finish(new Error(`无法启动 Codex 登录检查：${e.message}`)));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-12_000); });
    child.on('close', code => finish(null, { code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function assertChatGptLogin(command = 'codex', { env = process.env, force = false } = {}) {
  const now = Date.now();
  if (!force && loginCache.command === command && now - loginCache.checkedAt < LOGIN_CACHE_MS) {
    if (loginCache.ok) return;
    throw new Error(loginCache.detail);
  }
  const safeEnv = chatGptOnlyEnv(env);
  const launch = resolveCodexLaunch(command, safeEnv);
  const r = await spawnCapture(launch, ['login', 'status'], { env: safeEnv, timeoutMs: 15_000 });
  const detail = `${r.stdout}\n${r.stderr}`.trim();
  const ok = r.code === 0 && /chatgpt/i.test(detail);
  const message = ok ? '' : (
    'Codex 模式要求 ChatGPT 登录态，但当前 Codex CLI 未以 ChatGPT 登录。'
    + '请先运行 `codex logout`，再运行 `codex login` 并选择使用 ChatGPT 登录；API Key 请使用现有 api 模式。'
    + (detail ? `（状态：${detail.slice(0, 300)}）` : '')
  );
  loginCache = { command, checkedAt: now, ok, detail: message };
  if (!ok) throw new Error(message);
}

function makeTurnSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timeoutHit = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timeoutHit = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timeoutHit: () => timeoutHit,
    cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

export async function runCodex({
  command = 'codex', prompt, cwd, model = '', effort = '', sandbox = 'read-only',
  timeoutMs = 600_000, signal, onText = () => {}, onMcpTool = () => {},
  mcpServers, env = process.env,
}) {
  const sdkOptions = buildCodexSdkOptions(env, { mcpServers });
  await assertChatGptLogin(command, { env: sdkOptions.env });

  const codex = new Codex(sdkOptions);
  const thread = codex.startThread(buildCodexThreadOptions({ cwd, model, effort, sandbox }));
  const turnSignal = makeTurnSignal(signal, timeoutMs);
  const snapshots = new Map();
  let text = '';
  let usage = null;
  let eventError = '';

  try {
    const streamed = await thread.runStreamed(String(prompt || ''), { signal: turnSignal.signal });
    for await (const event of streamed.events) {
      const parsed = parseCodexEvent(event);
      if (parsed.textSnapshot !== undefined) {
        const previous = snapshots.get(parsed.itemId) || '';
        const next = parsed.textSnapshot;
        const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
        snapshots.set(parsed.itemId, next);
        if (delta) {
          text += delta;
          onText(delta);
        }
      }
      if (parsed.mcpTool) onMcpTool(parsed.mcpTool);
      if (parsed.usage) usage = parsed.usage;
      if (parsed.error) eventError = parsed.error;
    }
  } catch (error) {
    if (turnSignal.timeoutHit()) {
      const e = new Error(`codex 超时 (${timeoutMs}ms)`);
      e.name = 'CodexTimeoutError';
      throw e;
    }
    if (signal?.aborted || error?.name === 'AbortError') {
      const e = new Error('codex 已取消');
      e.name = 'AbortError';
      throw e;
    }
    throw new Error(`Codex SDK 运行失败：${String(error?.message || error).slice(0, 2000)}`);
  } finally {
    turnSignal.cleanup();
  }

  if (eventError) throw new Error(`Codex SDK 运行失败：${eventError.slice(0, 2000)}`);
  if (!text.trim()) throw new Error('Codex SDK 未返回 agent_message');
  return { text, usage };
}

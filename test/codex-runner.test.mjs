import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexSdkOptions,
  buildCodexThreadOptions,
  buildDiceMcpServers,
  chatGptOnlyEnv,
  parseCodexEvent,
  resolveCodexLaunch,
} from '../codex-runner.mjs';

test('Codex SDK 线程锁定工作区、禁审批和网络', () => {
  const options = buildCodexThreadOptions({
    cwd: 'D:\\rp campaign',
    model: 'gpt-test',
    effort: 'high',
    sandbox: 'read-only',
  });
  assert.deepEqual(options, {
    workingDirectory: 'D:\\rp campaign',
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    model: 'gpt-test',
    modelReasoningEffort: 'high',
  });
});

test('Codex SDK 强制 ChatGPT + OpenAI provider，且不传 apiKey', () => {
  const options = buildCodexSdkOptions({ PATH: 'bin', OPENAI_API_KEY: 'secret' });
  assert.equal(options.apiKey, undefined);
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.config.forced_login_method, 'chatgpt');
  assert.equal(options.config.model_provider, 'openai');
  assert.equal(options.config.history.persistence, 'none');
});

test('Codex 骰子 MCP 仅暴露 roll，且不需要交互审批', () => {
  const servers = buildDiceMcpServers({
    serverPath: 'D:\\bridge\\dice-mcp-server.mjs',
    maxCalls: 7,
    nodePath: 'node.exe',
  });
  assert.deepEqual(servers, {
    dice: {
      command: 'node.exe',
      args: ['D:\\bridge\\dice-mcp-server.mjs'],
      env: { DICE_MAX_CALLS: '7' },
      enabled: true,
      required: true,
      enabled_tools: ['roll'],
      default_tools_approval_mode: 'approve',
      tools: { roll: { approval_mode: 'approve' } },
      startup_timeout_sec: 10,
      tool_timeout_sec: 10,
    },
  });
  const options = buildCodexSdkOptions({}, { mcpServers: servers });
  assert.deepEqual(options.config.mcp_servers, servers);
});

test('Codex SDK agent_message 事件被解析为正文快照', () => {
  assert.deepEqual(parseCodexEvent({
    type: 'item.completed',
    item: { id: 'item-1', type: 'agent_message', text: '下一幕开始。' },
  }), { itemId: 'item-1', textSnapshot: '下一幕开始。' });
});

test('Codex token 用量被转换为 OpenAI 兼容格式', () => {
  assert.deepEqual(parseCodexEvent({
    type: 'turn.completed',
    usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 30 },
  }), {
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  });
});

test('Codex 失败事件保留上游原因', () => {
  assert.deepEqual(parseCodexEvent({
    type: 'turn.failed', error: { message: 'model unavailable' },
  }), { error: 'model unavailable' });
});

test('Codex SDK 骰子工具完成事件保留结果用于日志和对账', () => {
  assert.deepEqual(parseCodexEvent({
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call', server: 'dice', tool: 'roll', status: 'completed',
      arguments: { formula: '1d20+3' },
      result: { content: [{ type: 'text', text: '1d20 +3 = [7] +3 = 10' }] },
    },
  }), {
    mcpTool: {
      server: 'dice', tool: 'roll', status: 'completed',
      arguments: { formula: '1d20+3' }, text: '1d20 +3 = [7] +3 = 10', error: '',
    },
  });
});

test('Codex 订阅子进程不继承按量 API 凭据', () => {
  const env = chatGptOnlyEnv({
    PATH: 'bin', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret2',
    AZURE_OPENAI_API_KEY: 'secret3', OPENAI_BASE_URL: 'https://proxy.example', KEEP_ME: 'yes',
  });
  assert.equal(env.PATH, 'bin');
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.AZURE_OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
});

test('Windows 缺少 HOME 时自动使用用户目录中的 Codex 登录态', {
  skip: process.platform !== 'win32',
}, () => {
  const env = chatGptOnlyEnv({ USERPROFILE: 'C:\\Users\\Tester', HOME: '' });
  assert.equal(env.CODEX_HOME, 'C:\\Users\\Tester\\.codex');
});

test('PATH 中没有全局 Codex 时使用 SDK 自带的同版本 CLI 检查登录', () => {
  const launch = resolveCodexLaunch('codex', { PATH: '' });
  assert.equal(launch.executable, process.execPath);
  assert.equal(launch.prefix.length, 1);
  assert.match(launch.prefix[0], /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
});

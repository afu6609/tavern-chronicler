import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('服务以推荐的 Codex 三路径默认配置启动，启动时不触发模型调用', async () => {
  const memoryRoot = await mkdtemp(path.join(tmpdir(), 'st-bridge-test-'));
  const port = await freePort();
  const env = { ...process.env };
  for (const key of [
    'CHAT_MODE', 'CODEX_CHAT_MODEL', 'CHAT_EFFORT',
    'MEMORY_MODE', 'CODEX_MEMORY_MODEL', 'MEMORY_EFFORT',
    'RECALL_MODE', 'CODEX_RECALL_MODEL', 'RECALL_EFFORT',
  ]) delete env[key];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...env,
      PORT: String(port),
      MEMORY_ROOT: memoryRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`启动超时：${output}`)), 10_000);
      const accept = chunk => {
        output += chunk;
        if (output.includes('st-claude-bridge listening')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', accept);
      child.stderr.on('data', accept);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`服务提前退出 (${code})：${output}`)));
    });
    assert.match(output, /chat: codex\(gpt-5\.6-sol\)/);
    assert.match(output, /memory: codex\(gpt-5\.6-terra\)/);
    assert.match(output, /recall: codex\(gpt-5\.6-luna\)/);
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(response.status, 200);
    const models = await response.json();
    assert.deepEqual(models.data.map(x => x.id), [
      'codex-default',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.3-codex-spark',
    ]);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

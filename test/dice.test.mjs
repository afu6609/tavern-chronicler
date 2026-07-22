import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { rollFormula } from '../dice.mjs';

test('共享骰子核心正确解析骰式和修正值', () => {
  const sequence = [4, 2];
  const bounds = [];
  const result = rollFormula('2d6 + 3', (min, max) => {
    bounds.push([min, max]);
    return sequence.shift();
  });
  assert.deepEqual(bounds, [[1, 7], [1, 7]]);
  assert.deepEqual(result, {
    total: 9,
    rolls: [4, 2],
    formula: '2d6 +3',
    text: '2d6 +3 = [4, 2] +3 = 9',
  });
  assert.throws(() => rollFormula('随便投一个'), /无法解析骰式/);
});

test('Codex STDIO MCP 与 Claude 暴露同名 roll 工具并返回真实骰式结果', async () => {
  const serverPath = fileURLToPath(new URL('../dice-mcp-server.mjs', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, DICE_MAX_CALLS: '2' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'dice-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ['roll']);
    assert.equal(listed.tools[0].annotations?.readOnlyHint, true);

    const first = await client.callTool({ name: 'roll', arguments: { formula: '2d6+1' } });
    assert.equal(first.isError, undefined);
    assert.match(first.content[0].text, /^2d6 \+1 = \[(?:[1-6], ){1}[1-6]\] \+1 = \d+$/);

    await client.callTool({ name: 'roll', arguments: { formula: 'd20' } });
    const overLimit = await client.callTool({ name: 'roll', arguments: { formula: 'd20' } });
    assert.equal(overLimit.isError, true);
    assert.match(overLimit.content[0].text, /调用已达到上限 2/);
  } finally {
    await client.close();
  }
});

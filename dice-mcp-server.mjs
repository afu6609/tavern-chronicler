import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DICE_SERVER_INSTRUCTIONS, DICE_TOOL_DESCRIPTION, rollFormula } from './dice.mjs';

const configuredLimit = Number(process.env.DICE_MAX_CALLS || 12);
const maxCalls = Number.isFinite(configuredLimit) ? Math.max(1, Math.floor(configuredLimit)) : 12;
let callCount = 0;

const server = new McpServer(
  { name: 'st-bridge-dice', version: '1.0.0' },
  { instructions: DICE_SERVER_INSTRUCTIONS },
);

server.registerTool('roll', {
  title: '真随机掷骰',
  description: DICE_TOOL_DESCRIPTION,
  inputSchema: { formula: z.string().describe('骰式，NdM+K 格式') },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async ({ formula }) => {
  if (callCount >= maxCalls) {
    return {
      content: [{ type: 'text', text: `本轮 roll 调用已达到上限 ${maxCalls}` }],
      isError: true,
    };
  }
  callCount++;
  try {
    const result = rollFormula(formula);
    return { content: [{ type: 'text', text: result.text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());

#!/usr/bin/env node
// Fake `claude -p --output-format stream-json`: calls the kb MCP endpoint named in
// --mcp-config like Claude Code would, then streams an answer citing [1].
// FAKE_CLAUDE_MODE: answer (default) | sleep | login. FAKE_CLAUDE_REPORT: a file that
// receives { args, stdin, env } with the names of the credential variables it saw.
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'answer';
const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const delta = (text) =>
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  });

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;

if (process.env.FAKE_CLAUDE_REPORT) {
  const seen = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
  ].filter((name) => name in process.env);
  writeFileSync(
    process.env.FAKE_CLAUDE_REPORT,
    JSON.stringify({ args, stdin, env: seen }),
  );
}

emit({ type: 'system', subtype: 'init', model: 'claude-fake-1', tools: [] });

if (mode === 'login') {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Not logged in · Please run /login',
  });
  process.exit(1);
}
if (mode === 'sleep') {
  delta('Pensando');
  setInterval(() => undefined, 1000);
} else {
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  const client = new Client({ name: 'fake-claude', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.mcpServers.kb.url)),
  );
  const { tools } = await client.listTools();
  if (tools.length > 0)
    await client.callTool({
      name: tools[0].name,
      arguments: { query: 'ritmo' },
    });
  await client.close();
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        name: 'mcp__kb__search_collection',
        input: {},
      },
    },
  });
  delta('Segundo o acervo, ');
  delta('tudo flui [1].');
  emit({ type: 'assistant', message: { content: [] } });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.12,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

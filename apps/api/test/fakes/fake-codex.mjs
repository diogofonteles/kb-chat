#!/usr/bin/env node
// Fake `codex exec --json`: calls the kb MCP endpoint given by `-c mcp_servers.kb.url=...`,
// then prints the JSONL events of one turn. FAKE_CODEX_MODE: answer (default) | fail.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
for await (const chunk of process.stdin) void chunk;

emit({ type: 'thread.started', thread_id: 't1' });
emit({ type: 'turn.started' });
if (process.env.FAKE_CODEX_MODE === 'fail') {
  emit({ type: 'turn.failed', error: { message: 'Please run codex login' } });
  process.exit(1);
}
const setting = args[args.indexOf('-c') + 1];
const url = JSON.parse(setting.slice(setting.indexOf('=') + 1));
const client = new Client({ name: 'fake-codex', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();
emit({
  type: 'item.started',
  item: {
    id: 'i1',
    type: 'mcp_tool_call',
    server: 'kb',
    tool: tools[0].name,
    status: 'in_progress',
  },
});
await client.callTool({ name: tools[0].name, arguments: { query: 'ritmo' } });
await client.close();
emit({
  type: 'item.completed',
  item: { id: 'i2', type: 'agent_message', text: 'Tudo flui [1].' },
});
emit({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
});

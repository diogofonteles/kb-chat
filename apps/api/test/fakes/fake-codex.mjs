#!/usr/bin/env node
// Fake `codex exec --json`: calls the kb MCP endpoint given by `-c mcp_servers.kb.url=...`
// with the bearer token from the variable named by `mcp_servers.kb.bearer_token_env_var`,
// then prints the JSONL events of one turn. $HOME/fake-cli.json { mode, report } — mode: answer (default) | fail.
// report: a file that receives { args, env } (names) and CODEX_HOME.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The CLI gets only allowlisted variables, so the test settings come from $HOME.
const fake = (() => {
  try {
    return JSON.parse(
      readFileSync(join(process.env.HOME ?? '', 'fake-cli.json'), 'utf8'),
    );
  } catch {
    return {};
  }
})();
const args = process.argv.slice(2);
const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
for await (const chunk of process.stdin) void chunk;

emit({ type: 'thread.started', thread_id: 't1' });
emit({ type: 'turn.started' });
if (fake.mode === 'fail') {
  emit({ type: 'turn.failed', error: { message: 'Please run codex login' } });
  process.exit(1);
}
const setting = (key) => {
  const prefix = `mcp_servers.kb.${key}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return JSON.parse(found.slice(prefix.length));
};
if (fake.report)
  writeFileSync(
    fake.report,
    JSON.stringify({
      args,
      envNames: Object.keys(process.env),
      codexHome: process.env.CODEX_HOME,
    }),
  );
const token = process.env[setting('bearer_token_env_var')];
const client = new Client({ name: 'fake-codex', version: '0.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(setting('url')), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
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

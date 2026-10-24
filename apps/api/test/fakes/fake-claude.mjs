#!/usr/bin/env node
// Fake `claude -p --output-format stream-json`: calls the kb MCP endpoint named in
// --mcp-config like Claude Code would, then streams an answer citing [1].
// $HOME/fake-cli.json { mode, report } — mode: answer (default) | sleep | stubborn (ignores SIGTERM) | login. report: a file that
// receives { args, stdin, env } with the names of the credential variables it saw.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
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
const mode = fake.mode ?? 'answer';
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

if (fake.report) {
  const configPath = args[args.indexOf('--mcp-config') + 1];
  const seen = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
  ].filter((name) => name in process.env);
  writeFileSync(
    fake.report,
    JSON.stringify({
      args,
      stdin,
      env: seen,
      envNames: Object.keys(process.env),
      configMode: statSync(configPath).mode & 0o777,
    }),
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
const stop = (reason) =>
  emit({
    type: 'stream_event',
    event: { type: 'message_delta', delta: { stop_reason: reason } },
  });

if (mode === 'stubborn') process.on('SIGTERM', () => undefined);
if (mode === 'sleep' || mode === 'stubborn') {
  // Past the narration hold, so it streams before the reader stops it.
  delta('Pensando no acervo. '.repeat(50));
  setInterval(() => undefined, 1000);
} else {
  // Narration before the tool call, as Claude writes it: never shown (ADR 0006).
  delta('Vou procurar no acervo. ');
  stop('tool_use');
  const configPath = args[args.indexOf('--mcp-config') + 1];
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
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
  delta('Tenho tudo o que preciso. ');
  delta('Segundo o acervo, ');
  delta('tudo flui [1].');
  stop('end_turn');
  emit({ type: 'assistant', message: { content: [] } });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.12,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

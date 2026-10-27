#!/usr/bin/env node
// Fake `codex exec --json`: calls the kb MCP endpoint given by `-c mcp_servers.kb.url=...`
// with the bearer token from the variable named by `mcp_servers.kb.bearer_token_env_var`,
// then prints the JSONL events of one turn. $HOME/fake-cli.json { mode, report } — mode: answer (default) | fail
// (logged out) | error (a model error) | plan (calls plan_sweep, KBC-030)
// | sleep (starts, then waits to be stopped). report: a file that receives { args, env } (names), CODEX_HOME
// and the process id. `codex login status` answers "Logged in" (exit 0), or exits 1 with mode fail.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SWEEP_PLAN, logRun, sweepReply } from './fake-sweep.mjs';

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
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write(
    fake.mode === 'fail' ? 'Not logged in\n' : 'Logged in using ChatGPT\n',
  );
  process.exit(fake.mode === 'fail' ? 1 : 0);
}
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
logRun(fake, { args, stdin: stdin.slice(0, 2000) });

emit({ type: 'thread.started', thread_id: 't1' });
emit({ type: 'turn.started' });
if (fake.mode === 'error') {
  emit({ type: 'turn.failed', error: { message: 'The model is overloaded' } });
  process.exit(1);
}
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
      pid: process.pid,
      cwd: process.cwd(),
    }),
  );
if (fake.mode === 'sleep') {
  emit({
    type: 'item.completed',
    item: { id: 'i0', type: 'agent_message', text: 'Pensando.' },
  });
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}
// A sweep's batch or answer (KBC-030): the rules lead stdin; no tool is called.
const sweep = sweepReply(stdin);
if (sweep !== null) {
  emit({
    type: 'item.completed',
    item: { id: 'i9', type: 'agent_message', text: sweep },
  });
  emit({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  process.exit(0);
}
const token = process.env[setting('bearer_token_env_var')];
const client = new Client({ name: 'fake-codex', version: '0.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(setting('url')), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
const { tools } = await client.listTools();
// A connection test ("Testar conexão") has no tools: it only proves the login and MCP.
if (tools.length > 0) {
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
}
if (fake.mode === 'plan' && tools.some((tool) => tool.name === 'plan_sweep'))
  await client.callTool({ name: 'plan_sweep', arguments: SWEEP_PLAN });
await client.close();
emit({
  type: 'item.completed',
  item: { id: 'i2', type: 'agent_message', text: 'Tudo flui [1].' },
});
emit({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
});

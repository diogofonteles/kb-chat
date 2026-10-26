import { loadRunnerConfig } from './codex-runner/runner-config.js';
import { startCodexRunner } from './codex-runner/runner-server.js';

// The Codex sandbox runner (KBC-027, ADR 0020): the `codex` service's process, in its own
// container, with only CODEX_HOME mounted.
const config = loadRunnerConfig();
const runner = await startCodexRunner({
  bin: config.CODEX_BIN,
  codexHome: config.CODEX_HOME,
  mcpUrl: config.CODEX_MCP_URL,
  allowedClients: config.CODEX_RUNNER_CLIENTS,
  host: config.CODEX_RUNNER_HOST,
  port: config.CODEX_RUNNER_PORT,
  env: { PATH: config.PATH, LANG: config.LANG },
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => void runner.close().then(() => process.exit(0)));

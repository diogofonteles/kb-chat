import { describe, expect, it } from 'vitest';
import { loadRunnerConfig } from './runner-config.js';

describe('loadRunnerConfig (ADR 0020)', () => {
  it('needs CODEX_HOME and defaults the rest', () => {
    expect(() => loadRunnerConfig({})).toThrow(/CODEX_HOME/);
    const base = {
      CODEX_HOME: '/codex-home',
      CODEX_MCP_URL: 'http://172.30.0.2:3000/mcp/turn',
    };
    expect(() => loadRunnerConfig({ CODEX_HOME: '/codex-home' })).toThrow(
      /CODEX_MCP_URL/,
    );
    expect(
      loadRunnerConfig({ ...base, CODEX_RUNNER_CLIENTS: '172.30.0.2' })
        .CODEX_RUNNER_CLIENTS,
    ).toEqual(['172.30.0.2']);
    expect(loadRunnerConfig(base).CODEX_RUNNER_REAP).toBe(false);
    expect(
      loadRunnerConfig({ ...base, CODEX_RUNNER_REAP: 'on' }).CODEX_RUNNER_REAP,
    ).toBe(true);
    expect(loadRunnerConfig(base)).toMatchObject({
      CODEX_BIN: 'codex',
      CODEX_RUNNER_HOST: '0.0.0.0',
      CODEX_RUNNER_PORT: 8790,
      LANG: 'C.UTF-8',
    });
  });
});

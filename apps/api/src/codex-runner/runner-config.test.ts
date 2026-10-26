import { describe, expect, it } from 'vitest';
import { loadRunnerConfig } from './runner-config.js';

describe('loadRunnerConfig (ADR 0020)', () => {
  it('needs CODEX_HOME and defaults the rest', () => {
    expect(() => loadRunnerConfig({})).toThrow(/CODEX_HOME/);
    expect(loadRunnerConfig({ CODEX_HOME: '/codex-home' })).toMatchObject({
      CODEX_BIN: 'codex',
      CODEX_RUNNER_HOST: '0.0.0.0',
      CODEX_RUNNER_PORT: 8790,
      LANG: 'C.UTF-8',
    });
  });
});

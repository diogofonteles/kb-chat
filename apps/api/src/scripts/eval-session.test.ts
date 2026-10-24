import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKES_DIR, FIXTURE_VAULT } from '../../test/fixture-paths.js';
import { loadConfig } from '../config.js';
import { openEvalSession, runEvalTurn } from './eval-session.js';

async function evalConfig(env: Record<string, string> = {}) {
  return loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    KB_CHAT_STATE_DIR: await mkdtemp(join(tmpdir(), 'kbchat-eval-')),
    // Nothing listens here: the eval must not depend on a running API.
    PORT: '9',
    ...env,
  });
}

describe('agent-eval session', () => {
  it('serves the kb tools to a subscription CLI on its own MCP endpoint', async () => {
    const config = await evalConfig({
      CLAUDE_BIN: join(FAKES_DIR, 'fake-claude.mjs'),
    });
    const session = await openEvalSession({
      config,
      env: { PATH: process.env.PATH ?? '' },
      profile: 'deep',
    });
    try {
      expect(session.provider).toBe('claude-subscription');
      expect(session.runner.model).toBe('opus');
      const turn = await runEvalTurn(session.runner, {
        topic: 'hermetismo',
        question: 'o que é o ritmo?',
        history: [],
        profile: 'deep',
      });
      // The fake CLI's search reached the real tools: a kb step and a numbered source.
      expect(turn.error).toBeNull();
      expect(turn.steps[0]).toMatch(/^Buscando “ritmo”/);
      expect(turn.sources.size).toBeGreaterThan(0);
      expect(turn.answer).toBe('Segundo o acervo, tudo flui [1].');
      expect(turn.firstStepMs).not.toBeNull();
      expect(turn.firstTokenMs).toBeGreaterThanOrEqual(turn.firstStepMs ?? 0);
    } finally {
      await session.close();
    }
  });

  it('times a per-token turn and keeps only the text the reader ends up seeing', async () => {
    const session = await openEvalSession({
      config: await evalConfig({ KB_CHAT_LLM: 'stub' }),
      env: {},
      profile: 'fast',
    });
    try {
      const turn = await runEvalTurn(session.runner, {
        topic: 'hermetismo',
        question: 'pitagóricos',
        history: [],
        profile: 'fast',
      });
      expect(turn.retracts).toBe(1);
      expect(turn.answer).toMatch(/\[1\]\.$/);
      expect(turn.answer).not.toContain('confiro');
      expect(turn.usd).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});

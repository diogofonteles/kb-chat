import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemorySettingsStore } from '../adapters/memory-settings-store.js';
import { StubLlmAdapter } from '../adapters/stub-llm-adapter.js';
import { loadConfig } from '../config.js';
import {
  applySettingsUpdate,
  DEFAULT_SETTINGS,
  SettingsService,
} from '../modules/settings/index.js';
import type { LlmPort } from '../ports/llm.js';
import { findExecutable } from './command-locator.js';
import { testConnection } from './connection-test.js';
import { createAiProviders } from './create-ai-providers.js';
import { DisabledResearchRunner, DynamicLlm } from './dynamic-ports.js';

const config = (env: Record<string, string> = {}) =>
  loadConfig({ KB_VAULT: '/nonexistent', LOG_LEVEL: 'silent', ...env });

describe('findExecutable', () => {
  it('finds a command on PATH or by path, never a plain file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'kbchat-bin-'));
    await writeFile(join(folder, 'claude'), '#!/bin/sh\n');
    await writeFile(join(folder, 'notes'), 'x');
    await chmod(join(folder, 'claude'), 0o755);
    expect(await findExecutable('claude', `/nope:${folder}`)).toBe(
      join(folder, 'claude'),
    );
    expect(await findExecutable('notes', folder)).toBeNull();
    expect(await findExecutable('codex', folder)).toBeNull();
    expect(await findExecutable(join(folder, 'claude'), '')).toBe(
      join(folder, 'claude'),
    );
    expect(await findExecutable(folder, '')).toBeNull();
  });
});

describe('settings per principal', () => {
  it('keeps each principal apart and merges partial updates (ADR 0007/0008 seam)', async () => {
    const settings = new SettingsService({
      store: new MemorySettingsStore(),
      defaultDailyCapUsd: 1,
    });
    await settings.update('owner', {
      ai: { provider: 'openai', keys: { openai: 'sk-owner-1111' } },
    });
    expect((await settings.view('guest')).exists).toBe(false);
    expect(settings.key('owner', 'openai')).toBe('sk-owner-1111');
    expect(settings.key('guest', 'openai')).toBeUndefined();
    const merged = applySettingsUpdate(DEFAULT_SETTINGS, {
      preferences: { defaultTopic: 'a' },
      ai: { model: 'm' },
    });
    expect(
      applySettingsUpdate(merged, {
        preferences: { defaultTopic: null },
        ai: { model: null },
      }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it('treats an invalid file as defaults without logging its content', async () => {
    const warnings: string[] = [];
    const store = new MemorySettingsStore();
    await store.write('owner', { ai: { keys: { openai: 42 } } });
    const settings = new SettingsService({
      store,
      defaultDailyCapUsd: 3,
      warn: (m) => warnings.push(m),
    });
    expect(await settings.view('owner')).toMatchObject({
      exists: true,
      ai: { dailyCapUsd: 3 },
    });
    expect(warnings.join()).not.toContain('42');
  });
});

describe('ProviderRegistry', () => {
  it('uses OpenRouter from the environment while Settings choose nothing (AC-6, BR-4)', async () => {
    const ai = await createAiProviders({
      config: config({ OPENROUTER_API_KEY: 'sk-or-env-0000' }),
      store: new MemorySettingsStore(),
      principal: 'owner',
      env: {},
    });
    expect(ai.registry.active('owner')).toBe('openrouter');
    expect(ai.llm.configured()).toBe(true);
    expect(ai.llm.model).toBe('deepseek/deepseek-v4-flash');
    expect(ai.llm.billing).toBe('per-token');
    await ai.settings.update('owner', { ai: { provider: 'none' } });
    expect(ai.llm.configured()).toBe(false);
  });

  it('picks the Anthropic default model and a saved model only for its provider', async () => {
    const ai = await createAiProviders({
      config: config({ ANTHROPIC_API_KEY: 'sk-ant-env-1111' }),
      store: new MemorySettingsStore(),
      principal: 'owner',
      env: {},
    });
    expect(ai.registry.choice('owner')).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    });
    await ai.settings.update('owner', {
      ai: { provider: 'openai', model: 'gpt-5.5' },
    });
    expect(ai.registry.choice('owner', { provider: 'anthropic' }).model).toBe(
      'claude-opus-5-5',
    );
    expect(ai.registry.choice('owner').model).toBe('gpt-5.5');
    expect(ai.registry.llm('owner')).toBe(ai.registry.llm('owner'));
  });

  it('builds subscription runners and refuses research without the tool loop', async () => {
    const ai = await createAiProviders({
      config: config({ KB_CHAT_LLM: 'stub' }),
      store: new MemorySettingsStore(),
      principal: 'owner',
      env: {},
    });
    expect(ai.registry.researchRunner('owner')).toBeInstanceOf(
      DisabledResearchRunner,
    );
    expect(ai.research.configured()).toBe(false);
    await ai.settings.update('owner', {
      ai: { provider: 'claude-subscription', model: 'opus' },
    });
    expect(ai.research.billing).toBe('subscription');
    expect(ai.research.model).toBe('opus');
    await ai.settings.update('owner', {
      ai: { provider: 'chatgpt-subscription' },
    });
    expect(ai.research.model).toBe('codex');
    expect(ai.registry.dailyCapUsd('owner')).toBe(1);
  });

  it('runs the per-token tool loop it is given (bound to KBC-008 after the merge)', async () => {
    const loop = new DisabledResearchRunner();
    const ai = await createAiProviders({
      config: config({ KB_CHAT_LLM: 'stub' }),
      store: new MemorySettingsStore(),
      principal: 'owner',
      env: {},
      perTokenRunner: () => loop,
    });
    // The stub has no streamAgent until KBC-008 adds it: without tool calling, no loop.
    expect(ai.registry.researchRunner('owner')).toBeInstanceOf(
      DisabledResearchRunner,
    );
  });
});

describe('default provider order (BR-4)', () => {
  const fakeClaudeFolder = async () => {
    const folder = await mkdtemp(join(tmpdir(), 'kbchat-path-'));
    await writeFile(join(folder, 'claude'), '#!/bin/sh\n');
    await chmod(join(folder, 'claude'), 0o755);
    return folder;
  };
  const activeWith = async (env: Record<string, string>, pathEnv: string) => {
    const ai = await createAiProviders({
      config: config(env),
      store: new MemorySettingsStore(),
      principal: 'owner',
      env: { PATH: pathEnv },
    });
    return ai;
  };

  it('resolves Settings > stub > claude on PATH > env keys > none', async () => {
    const withClaude = await fakeClaudeFolder();
    const keys = {
      OPENROUTER_API_KEY: 'sk-or-1',
      ANTHROPIC_API_KEY: 'sk-ant-1',
    };
    expect(
      (
        await activeWith({ ...keys, KB_CHAT_LLM: 'stub' }, withClaude)
      ).registry.active('owner'),
    ).toBe('stub');
    expect((await activeWith(keys, withClaude)).registry.active('owner')).toBe(
      'claude-subscription',
    );
    expect((await activeWith(keys, '/nope')).registry.active('owner')).toBe(
      'openrouter',
    );
    expect(
      (await activeWith({ ANTHROPIC_API_KEY: 'k' }, '')).registry.active(
        'owner',
      ),
    ).toBe('anthropic');
    expect(
      (await activeWith({ OPENAI_API_KEY: 'k' }, '')).registry.active('owner'),
    ).toBe('openai');
    expect((await activeWith({}, '')).registry.active('owner')).toBe('none');
    const chosen = await activeWith(keys, withClaude);
    await chosen.settings.update('owner', { ai: { provider: 'openai' } });
    expect(chosen.registry.active('owner')).toBe('openai');
  });

  it('notices claude installed after boot on the next provider list', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'kbchat-path-'));
    const ai = await activeWith({}, folder);
    expect(ai.registry.active('owner')).toBe('none');
    await writeFile(join(folder, 'claude'), '#!/bin/sh\n');
    await chmod(join(folder, 'claude'), 0o755);
    expect((await ai.registry.list('owner')).active).toBe(
      'claude-subscription',
    );
  });
});

describe('DynamicLlm', () => {
  it('delegates every call to the current provider', async () => {
    let current: LlmPort = new StubLlmAdapter({ answer: 'a' });
    const llm = new DynamicLlm(() => current);
    expect(await llm.price()).toEqual({ input: 1e-6, output: 1e-6 });
    expect(await llm.balance()).toBe(10);
    current = new StubLlmAdapter({ configured: false });
    expect(llm.configured()).toBe(false);
    expect(() =>
      llm.streamAgent([], [], {
        maxTokens: 1,
        signal: new AbortController().signal,
      }),
    ).toThrow('does not support tool calling');
  });
});

describe('testConnection', () => {
  const base = {
    choice: { provider: 'openrouter' as const, model: 'm', key: 'k' },
    locate: async () => null,
    runner: () => new DisabledResearchRunner(),
  };

  it('answers "sem resposta" (PROVIDER_TIMEOUT) when the provider stalls (NFR-1)', async () => {
    const stalled: LlmPort = {
      ...new StubLlmAdapter(),
      model: 'm',
      billing: 'per-token',
      configured: () => true,
      price: async () => ({ input: 0, output: 0 }),
      balance: async () => null,
      async *stream(_messages, options) {
        yield* [];
        await new Promise((resolve) =>
          options.signal.addEventListener('abort', resolve),
        );
        throw new Error('aborted');
      },
    };
    const result = await testConnection({
      ...base,
      signal: new AbortController().signal,
      timeoutMs: 20,
      llm: () => stalled,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'PROVIDER_TIMEOUT',
      model: 'm',
    });
  });

  it('reports other failures as PROVIDER_UNAVAILABLE', async () => {
    const failing = new StubLlmAdapter();
    failing.stream = async function* () {
      yield* [];
      throw new Error('boom');
    };
    const result = await testConnection({
      ...base,
      signal: new AbortController().signal,
      llm: () => failing,
    });
    expect(result.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('maps a subscription CLI error code', async () => {
    const result = await testConnection({
      ...base,
      choice: {
        provider: 'claude-subscription',
        model: undefined,
        key: undefined,
      },
      signal: new AbortController().signal,
      locate: async () => '/bin/claude',
      llm: () => new StubLlmAdapter(),
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'LLM_NOT_CONFIGURED',
      model: 'claude-subscription',
    });
  });
});

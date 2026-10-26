import { describe, expect, it } from 'vitest';
import { resolveAiSource } from './ai-access.js';

const base = {
  chosen: null,
  appAi: 'house',
  enforced: false,
  appAvailable: true,
} as const;

describe('resolveAiSource (KBC-022 AC-13, ADR 0016)', () => {
  it('serves the assigned app AI to a person who chose nothing', () => {
    expect(resolveAiSource(base)).toEqual({ source: 'app', appAi: 'house' });
    expect(resolveAiSource({ ...base, chosen: 'app' })).toEqual({
      source: 'app',
      appAi: 'house',
    });
  });

  it('lets the person’s own AI win unless the master enforced the app AI', () => {
    expect(resolveAiSource({ ...base, chosen: 'openrouter' })).toEqual({
      source: 'own',
      provider: 'openrouter',
    });
    expect(
      resolveAiSource({ ...base, chosen: 'openrouter', enforced: true }),
    ).toEqual({
      source: 'app',
      appAi: 'house',
    });
  });

  it('answers nothing with no app AI, an unavailable one, or "Nenhum" chosen', () => {
    expect(resolveAiSource({ ...base, appAi: 'none' })).toEqual({
      source: 'none',
    });
    expect(resolveAiSource({ ...base, appAvailable: false })).toEqual({
      source: 'none',
    });
    expect(resolveAiSource({ ...base, chosen: 'none' })).toEqual({
      source: 'none',
    });
    expect(
      resolveAiSource({
        ...base,
        appAi: 'none',
        enforced: true,
        chosen: 'anthropic',
      }),
    ).toEqual({
      source: 'own',
      provider: 'anthropic',
    });
  });
});

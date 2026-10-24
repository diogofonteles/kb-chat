import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  it('redacts every provider key and token field (ND-14)', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const secrets = {
      ANTHROPIC_API_KEY: 'sk-ant-secret-1',
      OPENAI_API_KEY: 'sk-openai-secret-2',
      OPENROUTER_API_KEY: 'sk-or-secret-3',
      key: 'sk-typed-secret-4',
      token: 'turn-token-secret-5',
    };
    createLogger('info', sink).info({ config: secrets }, 'boot');
    const log = lines.join('');
    for (const value of Object.values(secrets))
      expect(log).not.toContain(value);
    expect(log).toContain('[Redacted]');
  });
});

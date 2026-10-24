import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults and expands the home directory', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      PORT: 3000,
      KB_CHAT_SEARCH: 'qmd',
      ALLOWED_HOSTS: ['localhost', '127.0.0.1'],
    });
    expect(config.KB_VAULT.startsWith(homedir())).toBe(true);
  });

  it('parses a host list and fails on an invalid value', () => {
    expect(loadConfig({ ALLOWED_HOSTS: 'a, b' }).ALLOWED_HOSTS).toEqual([
      'a',
      'b',
    ]);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid configuration/);
  });
});

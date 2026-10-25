import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assertDeliveryConfigured, loadConfig } from './config.js';

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

  it('listens on loopback unless HOST says otherwise, and trusts no proxy by default', () => {
    expect(loadConfig({})).toMatchObject({ HOST: '127.0.0.1' });
    expect(loadConfig({}).TRUST_PROXY).toBeUndefined();
    expect(
      loadConfig({ HOST: '0.0.0.0', TRUST_PROXY: 'uniquelocal' }),
    ).toMatchObject({ HOST: '0.0.0.0', TRUST_PROXY: 'uniquelocal' });
    expect(() => loadConfig({ HOST: 'example.com' })).toThrow(
      /Invalid configuration/,
    );
  });
});

describe('assertDeliveryConfigured (KBC-014 FR-7, AC-13)', () => {
  const production = { NODE_ENV: 'production' };

  it('stops a production API without Resend', () => {
    expect(() => assertDeliveryConfigured(loadConfig(production))).toThrow(
      'set RESEND_API_KEY and KB_CHAT_EMAIL_FROM',
    );
    expect(() =>
      assertDeliveryConfigured(
        loadConfig({ ...production, RESEND_API_KEY: 'k' }),
      ),
    ).toThrow('set KB_CHAT_EMAIL_FROM');
  });

  it('refuses the SMS log adapter in production', () => {
    const config = loadConfig({
      ...production,
      RESEND_API_KEY: 'k',
      KB_CHAT_EMAIL_FROM: 'kb-chat <a@example.com>',
      KB_CHAT_SMS: 'log',
    });
    expect(() => assertDeliveryConfigured(config)).toThrow(/not in production/);
  });

  it('lets development run on the log adapters', () => {
    const config = loadConfig({ KB_CHAT_SMS: 'log' });
    expect(config.NODE_ENV).toBe('development');
    expect(() => assertDeliveryConfigured(config)).not.toThrow();
    expect(() =>
      assertDeliveryConfigured(
        loadConfig({
          ...production,
          RESEND_API_KEY: 'k',
          KB_CHAT_EMAIL_FROM: 'kb-chat <a@example.com>',
        }),
      ),
    ).not.toThrow();
  });
});

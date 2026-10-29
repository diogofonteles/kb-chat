import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertAiConfigured,
  assertDeliveryConfigured,
  loadConfig,
} from './config.js';

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

  it('bounds media creation at 30 per minute unless MEDIA_CREATE_RATE_LIMIT says otherwise', () => {
    expect(loadConfig({}).MEDIA_CREATE_RATE_LIMIT).toBe(30);
    expect(
      loadConfig({ MEDIA_CREATE_RATE_LIMIT: '5' }).MEDIA_CREATE_RATE_LIMIT,
    ).toBe(5);
    expect(() => loadConfig({ MEDIA_CREATE_RATE_LIMIT: '0' })).toThrow();
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

describe('SMTP settings (KBC-015 AC-5)', () => {
  it('defaults to Gmail on 465', () => {
    expect(loadConfig({})).toMatchObject({
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: 465,
    });
    expect(loadConfig({ SMTP_PORT: '587' }).SMTP_PORT).toBe(587);
  });

  it('refuses half of the SMTP pair in any environment', () => {
    expect(() => loadConfig({ SMTP_USER: 'kbchat@gmail.com' })).toThrow(
      /SMTP_PASSWORD/,
    );
    expect(() => loadConfig({ SMTP_PASSWORD: 'app-password' })).toThrow(
      /SMTP_USER/,
    );
    expect(() =>
      loadConfig({ SMTP_PASSWORD: 'app-password', NODE_ENV: 'production' }),
    ).toThrow(/Invalid configuration/);
  });

  it('reads blank email settings as unset (compose passes NAME= as "")', () => {
    const config = loadConfig({
      SMTP_HOST: '',
      SMTP_PORT: '',
      SMTP_USER: '',
      SMTP_PASSWORD: '',
      RESEND_API_KEY: '',
      KB_CHAT_EMAIL_FROM: '',
    });
    expect(config).toMatchObject({
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: 465,
    });
    expect(config.SMTP_USER).toBeUndefined();
    expect(config.RESEND_API_KEY).toBeUndefined();
    expect(() =>
      loadConfig({ SMTP_USER: 'kbchat@gmail.com', SMTP_PASSWORD: '' }),
    ).toThrow(/SMTP_PASSWORD/);
  });

  it('refuses an SMTP_USER that is not an email address', () => {
    expect(() =>
      loadConfig({ SMTP_USER: 'kbchat', SMTP_PASSWORD: 'app-password' }),
    ).toThrow(/Invalid configuration/);
  });

  it('never echoes the SMTP password in a configuration error', () => {
    expect(() =>
      loadConfig({ SMTP_PASSWORD: 'app-password-secret', PORT: 'abc' }),
    ).toThrow(/Invalid configuration/);
    expect(() =>
      loadConfig({ SMTP_PASSWORD: 'app-password-secret', PORT: 'abc' }),
    ).not.toThrow(/app-password-secret/);
  });
});

describe('assertDeliveryConfigured (KBC-014 FR-7, KBC-015 AC-6)', () => {
  const production = { NODE_ENV: 'production' };
  const smtp = { SMTP_USER: 'kbchat@gmail.com', SMTP_PASSWORD: 'app-password' };
  const resend = {
    RESEND_API_KEY: 'k',
    KB_CHAT_EMAIL_FROM: 'kb-chat <a@example.com>',
  };
  const bothPaths =
    'set SMTP_USER and SMTP_PASSWORD (Gmail), or RESEND_API_KEY and KB_CHAT_EMAIL_FROM';

  it('stops a production API without a complete email provider', () => {
    expect(() => assertDeliveryConfigured(loadConfig(production))).toThrow(
      bothPaths,
    );
    expect(() =>
      assertDeliveryConfigured(
        loadConfig({ ...production, RESEND_API_KEY: 'k' }),
      ),
    ).toThrow(bothPaths);
  });

  it('starts production with only the Gmail SMTP pair, or only Resend', () => {
    expect(() =>
      assertDeliveryConfigured(loadConfig({ ...production, ...smtp })),
    ).not.toThrow();
    expect(() =>
      assertDeliveryConfigured(loadConfig({ ...production, ...resend })),
    ).not.toThrow();
  });

  it('treats an API listening beyond loopback as production, NODE_ENV or not', () => {
    expect(() =>
      assertDeliveryConfigured(loadConfig({ HOST: '0.0.0.0' })),
    ).toThrow(bothPaths);
  });

  it('refuses the SMS log adapter in production', () => {
    const config = loadConfig({ ...production, ...smtp, KB_CHAT_SMS: 'log' });
    expect(() => assertDeliveryConfigured(config)).toThrow(/not in production/);
  });

  it('lets development run on the log adapters', () => {
    const config = loadConfig({ KB_CHAT_SMS: 'log' });
    expect(config.NODE_ENV).toBe('development');
    expect(() => assertDeliveryConfigured(config)).not.toThrow();
  });
});

describe('AI in production (KBC-022 AC-10)', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const production = { NODE_ENV: 'production', KB_CHAT_SECRETS_KEY: key };

  it('starts in production with a secrets key and no AI defaults', () => {
    expect(() => assertAiConfigured(loadConfig(production))).not.toThrow();
    expect(loadConfig({}).KB_CHAT_AI_DEFAULTS).toBe('off');
  });

  it('refuses production without KB_CHAT_SECRETS_KEY', () => {
    expect(() =>
      assertAiConfigured(loadConfig({ NODE_ENV: 'production' })),
    ).toThrow(/KB_CHAT_SECRETS_KEY/);
    expect(() => assertAiConfigured(loadConfig({ HOST: '0.0.0.0' }))).toThrow(
      /KB_CHAT_SECRETS_KEY/,
    );
  });

  it('refuses the local AI defaults and the stub in production', () => {
    expect(() =>
      assertAiConfigured(
        loadConfig({ ...production, KB_CHAT_AI_DEFAULTS: 'local' }),
      ),
    ).toThrow(/KB_CHAT_AI_DEFAULTS/);
    expect(() =>
      assertAiConfigured(loadConfig({ ...production, KB_CHAT_LLM: 'stub' })),
    ).toThrow(/stub/);
  });

  it('refuses Codex in production outside its sandbox runner (KBC-027 AC-6)', () => {
    expect(() =>
      assertAiConfigured(loadConfig({ ...production, KB_CHAT_CODEX: 'on' })),
    ).toThrow(/KB_CHAT_CODEX_RUNNER_URL/);
    const sandboxed = loadConfig({
      ...production,
      KB_CHAT_CODEX: 'on',
      KB_CHAT_CODEX_RUNNER_URL: 'http://172.30.0.10:8790',
      KB_CHAT_MCP_PEERS: '172.30.0.10',
    });
    expect(() => assertAiConfigured(sandboxed)).not.toThrow();
    expect(sandboxed.KB_CHAT_MCP_PEERS).toEqual(['172.30.0.10']);
  });

  it('allows both in development', () => {
    expect(() =>
      assertAiConfigured(
        loadConfig({ KB_CHAT_AI_DEFAULTS: 'local', KB_CHAT_LLM: 'stub' }),
      ),
    ).not.toThrow();
  });
});

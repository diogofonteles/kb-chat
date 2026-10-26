import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SEALED_PREFIX,
  SecretBox,
  loadSecretsKey,
  parseSecretsKey,
} from './secret-box.js';

const key = () => randomBytes(32);

describe('SecretBox (ADR 0016)', () => {
  it('seals with AES-256-GCM and opens back, with a fresh IV per value', () => {
    const box = new SecretBox(key());
    const a = box.seal('sk-or-v1-secret', 'ctx');
    const b = box.seal('sk-or-v1-secret', 'ctx');
    expect(a.startsWith(SEALED_PREFIX)).toBe(true);
    expect(a).not.toContain('secret');
    expect(a).not.toBe(b);
    expect(box.open(a, 'ctx')).toBe('sk-or-v1-secret');
    expect(box.isSealed(a)).toBe(true);
    expect(box.isSealed('sk-plain')).toBe(false);
  });

  it('refuses a value sealed with another key or tampered with', () => {
    const sealed = new SecretBox(key()).seal('value-1234', 'ctx');
    expect(() => new SecretBox(key()).open(sealed, 'ctx')).toThrow();
    const box = new SecretBox(key());
    const good = box.seal('value-1234', 'ctx');
    const tampered = `${good.slice(0, -2)}${good.endsWith('A') ? 'B' : 'A'}A`;
    expect(() => box.open(tampered, 'ctx')).toThrow();
    expect(() => box.open('enc:v1:broken', 'ctx')).toThrow();
  });

  it('opens a value only where it was sealed (associated data)', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('sk-or-v1-a', 'settings:alice:openrouter');
    expect(box.open(sealed, 'settings:alice:openrouter')).toBe('sk-or-v1-a');
    expect(() => box.open(sealed, 'settings:bob:openrouter')).toThrow();
  });

  it('needs exactly 32 bytes of key', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow(/32 bytes/);
    expect(parseSecretsKey(randomBytes(32).toString('base64'))).toHaveLength(
      32,
    );
    expect(() => parseSecretsKey('c2hvcnQ=')).toThrow(/32 bytes/);
  });
});

describe('loadSecretsKey', () => {
  it('uses the configured key', async () => {
    const configured = randomBytes(32).toString('base64');
    const loaded = await loadSecretsKey({
      configured,
      stateDir: '/nonexistent',
      hosted: true,
    });
    expect(loaded.toString('base64')).toBe(configured);
  });

  it('refuses to run hosted without a key', async () => {
    await expect(
      loadSecretsKey({ stateDir: '/nonexistent', hosted: true }),
    ).rejects.toThrow(/KB_CHAT_SECRETS_KEY/);
  });

  it('creates a 0600 key file once in development and reuses it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'kbchat-secrets-'));
    const first = await loadSecretsKey({ stateDir, hosted: false });
    const again = await loadSecretsKey({ stateDir, hosted: false });
    expect(first.equals(again)).toBe(true);
    const file = join(stateDir, 'secrets.key');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8')).trim()).toBe(
      first.toString('base64'),
    );
  });
});

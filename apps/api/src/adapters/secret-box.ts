import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretSealerPort } from '../ports/secret-sealer.js';
import { isMissingFile } from './atomic-json.js';

/** A sealed value: `enc:v1:<iv>.<tag>.<ciphertext>`, each part base64url. */
export const SEALED_PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

/** The 32-byte master key from KB_CHAT_SECRETS_KEY (base64). */
export function parseSecretsKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== KEY_BYTES)
    throw new Error('KB_CHAT_SECRETS_KEY must be 32 bytes in base64');
  return key;
}

/** AES-256-GCM with a random IV per value (ADR 0016). */
export class SecretBox implements SecretSealerPort {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES)
      throw new Error('The secrets key must be 32 bytes');
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const parts = [iv, cipher.getAuthTag(), body].map((part) =>
      part.toString('base64url'),
    );
    return `${SEALED_PREFIX}${parts.join('.')}`;
  }

  open(sealed: string): string {
    const [iv, tag, body] = sealed.slice(SEALED_PREFIX.length).split('.');
    if (!this.isSealed(sealed) || !iv || !tag || body === undefined)
      throw new Error('Not a sealed value');
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  isSealed(value: string): boolean {
    return value.startsWith(SEALED_PREFIX);
  }
}

export interface SecretsKeySource {
  /** KB_CHAT_SECRETS_KEY, when set. */
  readonly configured?: string;
  readonly stateDir: string;
  /** Production or listening beyond loopback: the key must come from the environment. */
  readonly hosted: boolean;
}

/**
 * The master key: the environment's; in development, without it, a 0600 file in the state
 * folder made once (production refuses to start instead, ADR 0016).
 */
export async function loadSecretsKey(
  source: SecretsKeySource,
): Promise<Buffer> {
  if (source.configured) return parseSecretsKey(source.configured);
  if (source.hosted)
    throw new Error(
      'KB_CHAT_SECRETS_KEY is not set: generate it once with `openssl rand -base64 32` (docs/deploy/runbook.md)',
    );
  const file = join(source.stateDir, 'secrets.key');
  try {
    return parseSecretsKey(await readFile(file, 'utf8'));
  } catch (err) {
    if (!isMissingFile(err)) throw err;
  }
  const key = randomBytes(KEY_BYTES);
  await mkdir(source.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${key.toString('base64')}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(file, 0o600);
  return key;
}

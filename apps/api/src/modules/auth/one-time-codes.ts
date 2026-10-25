import {
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { codeChannelSchema, type CodeChannel } from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import { SerialDocument } from '../../serial-document.js';

/** A code lives ten minutes (KBC-014 BR-4). */
export const CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses a code survives; the fifth burns it (BR-4). */
export const MAX_CODE_ATTEMPTS = 5;

/** scrypt with a salt per code (ADR 0011): a copy of codes.json gives no code back in time. */
const SCRYPT: ScryptOptions = { N: 2 ** 14, r: 8, p: 1 };
const HASH_BYTES = 32;

export type CodePurpose = 'signup' | 'login';

/** Whose code: one live code per identifier (email or E.164 phone) and purpose. */
export interface CodeKey {
  readonly purpose: CodePurpose;
  readonly identifier: string;
}

const storedCodeSchema = z.object({
  purpose: z.enum(['signup', 'login']),
  identifier: z.string().min(1),
  channel: codeChannelSchema,
  salt: z.string().min(1),
  hash: z.string().min(1),
  expiresAt: z.iso.datetime(),
  attempts: z.number().int().min(0),
  /** The sign-up form, kept until the email is confirmed. */
  payload: z.unknown().optional(),
});
export type StoredCode = z.infer<typeof storedCodeSchema>;

const codesDocumentSchema = z.object({
  version: z.literal(1),
  codes: z.array(storedCodeSchema),
});
type CodesDocument = z.infer<typeof codesDocumentSchema>;

export interface OneTimeCodesDeps {
  readonly store: DocumentStorePort;
  readonly now?: () => Date;
  /** Six digits; random unless a test fixes them. */
  readonly generate?: () => string;
  /** Observes every hash of a guess (tests prove the work is the same with or without a code). */
  readonly onHash?: (code: string) => void;
}

const sixRandomDigits = (): string =>
  randomInt(0, 1_000_000).toString().padStart(6, '0');

const hashOf = (code: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(code, salt, HASH_BYTES, SCRYPT, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

/**
 * Compared against when no live code exists: the guess is hashed all the same, so the reply
 * takes as long for an unknown email as for a person (BR-3, NFR-3).
 */
const DECOY: Pick<StoredCode, 'salt' | 'hash'> = {
  salt: randomBytes(16).toString('base64url'),
  hash: randomBytes(HASH_BYTES).toString('base64url'),
};

const sameKey = (code: StoredCode, key: CodeKey): boolean =>
  code.purpose === key.purpose && code.identifier === key.identifier;

/**
 * One-time codes (KBC-014 BR-4, NFR-1): six digits, ten minutes, single use, five attempts,
 * stored only as a salted scrypt hash and compared in constant time.
 */
export class OneTimeCodes {
  private readonly doc: SerialDocument<CodesDocument>;

  constructor(private readonly deps: OneTimeCodesDeps) {
    this.doc = new SerialDocument({
      store: deps.store,
      parse: (raw) => {
        const parsed = codesDocumentSchema.safeParse(raw);
        if (!parsed.success)
          throw new AppError('INTERNAL', 'codes.json is invalid');
        return parsed.data;
      },
      empty: () => ({ version: 1, codes: [] }),
    });
  }

  /** A new code for `key`, replacing its previous one; returns the code to send. */
  async issue(
    key: CodeKey,
    extra: { readonly channel: CodeChannel; readonly payload?: unknown },
  ): Promise<string> {
    const code = (this.deps.generate ?? sixRandomDigits)();
    const salt = randomBytes(16).toString('base64url');
    const hash = (await hashOf(code, salt)).toString('base64url');
    const expiresAt = new Date(this.now() + CODE_TTL_MS).toISOString();
    const entry: StoredCode = {
      ...key,
      ...extra,
      salt,
      hash,
      expiresAt,
      attempts: 0,
    };
    await this.doc.change((doc) => ({
      doc: { version: 1, codes: [...this.live(doc, key), entry] },
      result: undefined,
    }));
    return code;
  }

  /** The code's entry when `code` is right (and spends it), else null (and counts the try). */
  verify(key: CodeKey, code: string): Promise<StoredCode | null> {
    return this.doc.change(async (doc) => {
      const entry = doc.codes.find(
        (c) => sameKey(c, key) && Date.parse(c.expiresAt) > this.now(),
      );
      const others = this.live(doc, key);
      if (!entry) {
        await this.matches(DECOY, code);
        return { doc: { version: 1, codes: others }, result: null };
      }
      if (await this.matches(entry, code))
        return { doc: { version: 1, codes: others }, result: entry };
      const tried = { ...entry, attempts: entry.attempts + 1 };
      const kept = tried.attempts >= MAX_CODE_ATTEMPTS ? [] : [tried];
      return { doc: { version: 1, codes: [...others, ...kept] }, result: null };
    });
  }

  private async matches(
    entry: Pick<StoredCode, 'salt' | 'hash'>,
    code: string,
  ): Promise<boolean> {
    this.deps.onHash?.(code);
    const expected = Buffer.from(entry.hash, 'base64url');
    const actual = await hashOf(code, entry.salt);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  /** The other keys' codes that are still valid: expired ones go on every write. */
  private live(doc: CodesDocument, key: CodeKey): StoredCode[] {
    const now = this.now();
    return doc.codes.filter(
      (c) => !sameKey(c, key) && Date.parse(c.expiresAt) > now,
    );
  }

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }
}

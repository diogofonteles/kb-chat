import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

/** Google's keys rotate every few days; without Cache-Control they are kept for an hour. */
const DEFAULT_MAX_AGE_S = 3600;
const MAX_AGE_CAP_S = 24 * 3600;
/** A token with an unknown key id refetches at most this often. */
const REFETCH_COOLDOWN_MS = 30_000;

/** A hung key server must not hang every sign-in. */
const DEFAULT_TIMEOUT_MS = 5000;

export interface JwksCacheOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/** "public, max-age=21110, must-revalidate" → 21110 (seconds), capped at a day. */
export function maxAgeOf(cacheControl: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '');
  const seconds = match ? Number(match[1]) : DEFAULT_MAX_AGE_S;
  return Math.min(seconds, MAX_AGE_CAP_S);
}

interface CachedKeys {
  readonly keys: JWTVerifyGetKey;
  readonly expiresAt: number;
  readonly fetchedAt: number;
}

/**
 * The issuer's JSON Web Key Set, fetched on demand and kept for its Cache-Control max-age.
 * An unknown key id (a rotation) refetches once, no more than every 30 s.
 */
export class JwksCache {
  private cached: CachedKeys | null = null;
  private inflight: Promise<CachedKeys> | null = null;

  constructor(private readonly options: JwksCacheOptions) {}

  /** The jose key resolver for jwtVerify. */
  readonly getKey: JWTVerifyGetKey = async (header, token) => {
    const current = await this.current();
    try {
      return await current.keys(header, token);
    } catch (err) {
      if (
        !(err instanceof errors.JWKSNoMatchingKey) ||
        !this.mayRefetch(current)
      )
        throw err;
      const fresh = await this.fetchKeys();
      return fresh.keys(header, token);
    }
  };

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private mayRefetch(current: CachedKeys): boolean {
    return this.now() - current.fetchedAt >= REFETCH_COOLDOWN_MS;
  }

  private async current(): Promise<CachedKeys> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached;
    return this.fetchKeys();
  }

  private fetchKeys(): Promise<CachedKeys> {
    this.inflight ??= this.download().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async download(): Promise<CachedKeys> {
    const signal = AbortSignal.timeout(
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      signal,
    });
    if (!response.ok)
      throw new Error(`JWKS request failed with ${response.status}`);
    const jwks = (await response.json()) as JSONWebKeySet;
    const fetchedAt = this.now();
    const maxAge = maxAgeOf(response.headers.get('cache-control'));
    this.cached = {
      keys: createLocalJWKSet(jwks),
      fetchedAt,
      expiresAt: fetchedAt + maxAge * 1000,
    };
    return this.cached;
  }
}

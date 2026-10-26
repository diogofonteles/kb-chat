import { createHash, randomBytes } from 'node:crypto';
import type { OpenRouterPurpose } from '@kb-chat/contracts';

/** OpenRouter's consent page (ADR 0016); the E2E server points it at its own fake. */
export const OPENROUTER_AUTHORIZE_URL = 'https://openrouter.ai/auth';
/** A connection must come back within this (OpenRouter's codes live 10 minutes too). */
export const CONNECT_TTL_MS = 10 * 60_000;
/** Where OpenRouter sends the person back, on our own origin. */
export const CALLBACK_PATH = '/api/v1/openrouter/callback';

/** What a pending connection remembers until its callback (never sent to the browser). */
export interface PendingConnection {
  readonly verifier: string;
  readonly principal: string;
  readonly purpose: OpenRouterPurpose;
  readonly expiresAt: number;
}

export interface OpenRouterConnectDeps {
  /** The SPA's origin; the callback goes through its /api proxy (dev) or Caddy (production). */
  readonly webOrigin: string;
  readonly authorizeUrl?: string;
  readonly now?: () => number;
}

const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

/**
 * OAuth PKCE with OpenRouter (BR-8): a random verifier and state per attempt, kept in memory,
 * bound to the principal and the purpose, usable once within 10 minutes.
 */
export class OpenRouterConnect {
  private readonly pending = new Map<string, PendingConnection>();

  constructor(private readonly deps: OpenRouterConnectDeps) {}

  /** The URL to send the person to. */
  start(principal: string, purpose: OpenRouterPurpose): string {
    this.sweep();
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    this.pending.set(state, {
      verifier,
      principal,
      purpose,
      expiresAt: this.now() + CONNECT_TTL_MS,
    });
    const url = new URL(this.deps.authorizeUrl ?? OPENROUTER_AUTHORIZE_URL);
    url.searchParams.set('callback_url', this.callbackUrl());
    url.searchParams.set('code_challenge', s256(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('key_label', 'Nova Alexandria');
    return url.toString();
  }

  /** The pending connection of this state, once, for this principal only. */
  take(state: string, principal: string): PendingConnection | null {
    const found = this.pending.get(state);
    if (!found) return null;
    this.pending.delete(state);
    if (found.principal !== principal || found.expiresAt <= this.now())
      return null;
    return found;
  }

  callbackUrl(): string {
    return new URL(CALLBACK_PATH, this.deps.webOrigin).toString();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, entry] of this.pending)
      if (entry.expiresAt <= now) this.pending.delete(state);
  }
}

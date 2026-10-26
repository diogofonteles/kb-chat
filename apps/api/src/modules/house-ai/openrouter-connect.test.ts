import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONNECT_TTL_MS, OpenRouterConnect } from './openrouter-connect.js';

const setup = () => {
  let now = 1_000;
  const connect = new OpenRouterConnect({
    webOrigin: 'https://nova.example',
    now: () => now,
  });
  return { connect, advance: (ms: number) => (now += ms) };
};

describe('OpenRouterConnect (KBC-022 BR-8)', () => {
  it('sends the person to OpenRouter with an S256 challenge, a state and our callback', () => {
    const { connect } = setup();
    const url = new URL(connect.start('owner', 'house'));
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe(
      'https://nova.example/api/v1/openrouter/callback',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state') ?? '';
    const pending = connect.take(state, 'owner');
    expect(pending?.purpose).toBe('house');
    const challenge = createHash('sha256')
      .update(pending?.verifier ?? '')
      .digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.toString()).not.toContain(pending?.verifier ?? 'x');
  });

  it('accepts a state once, only for the same principal, within 10 minutes', () => {
    const { connect, advance } = setup();
    const stateOf = (u: string) => new URL(u).searchParams.get('state') ?? '';
    const first = stateOf(connect.start('owner', 'house'));
    expect(connect.take(first, 'owner')).not.toBeNull();
    expect(connect.take(first, 'owner')).toBeNull();
    const other = stateOf(connect.start('owner', 'house'));
    expect(connect.take(other, 'someone-else')).toBeNull();
    expect(connect.take(other, 'owner')).toBeNull();
    const late = stateOf(connect.start('owner', 'house'));
    advance(CONNECT_TTL_MS);
    expect(connect.take(late, 'owner')).toBeNull();
    expect(connect.take('unknown', 'owner')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  REFUSAL_COOLDOWN_MS,
  addRequest,
  refuseRequest,
  stateOf,
  takePending,
  type StoredRequest,
} from './request-rules.js';

const NOW = Date.parse('2026-10-25T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const draft = {
  email: 'ana@example.com',
  firstName: 'Ana',
  lastName: 'Lima',
  phone: '+5581999990000',
  source: 'form' as const,
  sub: null,
  picture: null,
};

const context = (now = NOW) => ({
  now: iso(now),
  newId: () => '11111111-1111-4111-8111-111111111111',
});

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
};

function pending(): StoredRequest[] {
  return [...addRequest([], draft, context()).requests];
}

describe('access request rules (KBC-014)', () => {
  it('creates a pending request', () => {
    const { requests, result } = addRequest([], draft, context());
    expect(result).toMatchObject({
      status: 'pending',
      email: 'ana@example.com',
    });
    expect(requests).toHaveLength(1);
    expect(stateOf(requests, { email: 'ana@example.com' }, NOW)).toEqual({
      status: 'pending',
    });
  });

  it('refuses a second request while one is pending', () => {
    expect(codeOf(() => addRequest(pending(), draft, context()))).toBe(
      'ALREADY_REQUESTED',
    );
  });

  it('AC-9: a refused person asks again only after 24 hours (BR-7)', () => {
    const [request] = pending();
    if (!request) throw new Error('no request');
    const refused = refuseRequest(
      pending(),
      { id: request.id, by: 'm@x.co' },
      iso(NOW),
    ).requests;

    const later = NOW + REFUSAL_COOLDOWN_MS - 1;
    expect(stateOf(refused, { email: 'ana@example.com' }, later)).toEqual({
      status: 'refused',
      retryAt: iso(NOW + REFUSAL_COOLDOWN_MS),
    });
    expect(codeOf(() => addRequest(refused, draft, context(later)))).toBe(
      'REQUEST_COOLDOWN',
    );

    const after = NOW + REFUSAL_COOLDOWN_MS;
    expect(stateOf(refused, { email: 'ana@example.com' }, after)).toEqual({
      status: 'none',
    });
    const again = addRequest(refused, draft, context(after));
    expect(again.requests).toHaveLength(1);
    expect(again.result.status).toBe('pending');
  });

  it('matches a Google request by its sub as well as by email', () => {
    const google = {
      ...draft,
      source: 'google' as const,
      sub: 'g-1',
      email: 'ana@gmail.com',
    };
    const { requests } = addRequest([], google, context());
    expect(
      stateOf(requests, { email: 'other@gmail.com', sub: 'g-1' }, NOW),
    ).toEqual({ status: 'pending' });
    expect(stateOf(requests, { email: 'nobody@gmail.com' }, NOW)).toEqual({
      status: 'none',
    });
  });

  it('takes a pending request out for approval, never a refused one', () => {
    const requests = pending();
    const [request] = requests;
    if (!request) throw new Error('no request');
    const taken = takePending(requests, request.id);
    expect(taken.result.email).toBe('ana@example.com');
    expect(taken.requests).toEqual([]);

    const refused = refuseRequest(
      requests,
      { id: request.id, by: 'm@x.co' },
      iso(NOW),
    ).requests;
    expect(codeOf(() => takePending(refused, request.id))).toBe('NOT_FOUND');
    expect(
      codeOf(() =>
        refuseRequest(refused, { id: request.id, by: 'm@x.co' }, iso(NOW)),
      ),
    ).toBe('NOT_FOUND');
  });
});

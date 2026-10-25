import { describe, expect, it } from 'vitest';
import { REQUEST_TICKET_TTL_MS, RequestTickets } from './request-ticket.js';

const identity = {
  sub: '1234567890',
  email: 'ana@gmail.com',
  name: 'Ana Lima',
  picture: null,
};

function setup() {
  let now = 1_000_000;
  return {
    tickets: new RequestTickets({ now: () => now }),
    advance: (ms: number) => (now += ms),
  };
}

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
};

describe('RequestTickets (KBC-014 FR-3, ADR 0011)', () => {
  it('gives the verified Google identity back once', () => {
    const { tickets } = setup();
    const ticket = tickets.issue(identity);

    expect(tickets.redeem(ticket)).toEqual(identity);
    expect(codeOf(() => tickets.redeem(ticket))).toBe('REQUEST_EXPIRED');
  });

  it('refuses a ticket after fifteen minutes', () => {
    const { tickets, advance } = setup();
    const ticket = tickets.issue(identity);
    advance(REQUEST_TICKET_TTL_MS + 1);

    expect(codeOf(() => tickets.redeem(ticket))).toBe('REQUEST_EXPIRED');
  });

  it('refuses a ticket whose content was changed', () => {
    const { tickets } = setup();
    const [, signature] = tickets.issue(identity).split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...identity,
        email: 'eve@gmail.com',
        jti: 'x',
        exp: 9e12,
      }),
    ).toString('base64url');

    expect(codeOf(() => tickets.redeem(`${forged}.${signature}`))).toBe(
      'REQUEST_EXPIRED',
    );
    expect(codeOf(() => tickets.redeem('not-a-ticket'))).toBe(
      'REQUEST_EXPIRED',
    );
  });

  it('refuses a ticket signed by another API process', () => {
    const ticket = setup().tickets.issue(identity);
    expect(codeOf(() => setup().tickets.redeem(ticket))).toBe(
      'REQUEST_EXPIRED',
    );
  });
});

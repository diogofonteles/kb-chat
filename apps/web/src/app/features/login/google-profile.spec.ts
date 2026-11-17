import { googleProfileOf } from './google-profile.js';

const tokenOf = (payload: object): string =>
  ['e30', btoa(JSON.stringify(payload)).replace(/=+$/, ''), 'sig'].join('.');

describe('googleProfileOf (v2 · Auth, the account row)', () => {
  it('reads the email, name and picture of the ID token', () => {
    expect(
      googleProfileOf(
        tokenOf({ email: 'bruno@exemplo.test', name: 'Bruno Lima', sub: '1' }),
      ),
    ).toEqual({ email: 'bruno@exemplo.test', name: 'Bruno Lima' });
  });

  it('reads accents (UTF-8) in the name', () => {
    const json = JSON.stringify({ email: 'a@b.co', name: 'Conceição' });
    const utf8 = String.fromCharCode(...new TextEncoder().encode(json));
    expect(googleProfileOf(`e30.${btoa(utf8)}.s`)?.name).toBe('Conceição');
  });

  it('gives null for anything that is not a readable token', () => {
    expect(googleProfileOf('not-a-token')).toBeNull();
    expect(googleProfileOf('a.%%%.c')).toBeNull();
    expect(googleProfileOf(tokenOf({ name: 'no email' }))).toBeNull();
  });
});

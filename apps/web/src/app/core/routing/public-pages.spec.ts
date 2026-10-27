import { isPublicUrl, publicPageOf } from './public-pages.js';

describe('isPublicUrl (KBC-016, KBC-032)', () => {
  it('accepts the privacy policy with or without a query or fragment', () => {
    expect(isPublicUrl('/privacidade')).toBe(true);
    expect(isPublicUrl('/privacidade?from=google#dados')).toBe(true);
  });

  it('accepts the tutorial, also with a section anchor', () => {
    expect(isPublicUrl('/tutorial')).toBe(true);
    expect(isPublicUrl('/tutorial#pesquisa-com-ia')).toBe(true);
  });

  it('keeps every other page behind the session', () => {
    expect(isPublicUrl('/')).toBe(false);
    expect(isPublicUrl('')).toBe(false);
    expect(isPublicUrl('/privacidade/extra')).toBe(false);
    expect(isPublicUrl('/tutorial/extra')).toBe(false);
    expect(isPublicUrl('/outra')).toBe(false);
  });
});

describe('publicPageOf (KBC-032)', () => {
  it('names the public page an address shows', () => {
    expect(publicPageOf('/privacidade#dados')).toBe('privacy');
    expect(publicPageOf('/tutorial?x=1#entrar')).toBe('tutorial');
    expect(publicPageOf('/')).toBeNull();
  });
});

import { isPublicUrl } from './public-pages.js';

describe('isPublicUrl (KBC-016)', () => {
  it('accepts the privacy policy with or without a query or fragment', () => {
    expect(isPublicUrl('/privacidade')).toBe(true);
    expect(isPublicUrl('/privacidade?from=google#dados')).toBe(true);
  });

  it('keeps every other page behind the session', () => {
    expect(isPublicUrl('/')).toBe(false);
    expect(isPublicUrl('')).toBe(false);
    expect(isPublicUrl('/privacidade/extra')).toBe(false);
    expect(isPublicUrl('/outra')).toBe(false);
  });
});

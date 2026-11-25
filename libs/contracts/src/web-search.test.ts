import { describe, expect, it } from 'vitest';
import { documentLinkSchema } from './document-uploads.js';
import {
  webSearchKeyRequestSchema,
  webSearchRequestSchema,
} from './web-search.js';

describe('webSearchRequestSchema (KBC-185)', () => {
  const ok = { query: 'hermetismo', kinds: ['page'] };

  it('trims the query and asks for 10 results when not told', () => {
    expect(
      webSearchRequestSchema.parse({ query: '  hermes  ', kinds: ['page'] }),
    ).toEqual({ query: 'hermes', kinds: ['page'], limit: 10 });
  });

  it('takes a query of 3 to 500 characters, counted without the spaces around', () => {
    const query = (length: number) =>
      webSearchRequestSchema.safeParse({ ...ok, query: 'a'.repeat(length) })
        .success;
    expect([query(2), query(3), query(500), query(501)]).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(
      webSearchRequestSchema.safeParse({ ...ok, query: '  ab  ' }).success,
    ).toBe(false);
  });

  it('refuses no kind, an unknown one and a repeated one', () => {
    for (const kinds of [[], ['audio'], ['page', 'page']])
      expect(webSearchRequestSchema.safeParse({ ...ok, kinds }).success).toBe(
        false,
      );
    expect(
      webSearchRequestSchema.safeParse({ ...ok, kinds: ['page', 'video'] })
        .success,
    ).toBe(true);
  });

  it('takes 5 to 30 results and no other field', () => {
    const limit = (value: number) =>
      webSearchRequestSchema.safeParse({ ...ok, limit: value }).success;
    expect([limit(4), limit(5), limit(30), limit(31), limit(5.5)]).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(
      webSearchRequestSchema.safeParse({ ...ok, country: 'BR' }).success,
    ).toBe(false);
  });
});

describe('webSearchKeyRequestSchema', () => {
  it('takes what a header takes, without the spaces around it', () => {
    expect(
      webSearchKeyRequestSchema.parse({ key: ' fc-0123456789 \n' }),
    ).toEqual({ key: 'fc-0123456789' });
    for (const key of ['', 'fc-1', 'fc-01234 56789', 'fc-0123456789é'])
      expect(webSearchKeyRequestSchema.safeParse({ key }).success).toBe(false);
  });
});

describe('a candidate address', () => {
  it('is refused, never thrown on, when it is not a web link', () => {
    for (const url of [
      'not a link',
      'ftp://example.org/a',
      'https://localhost/a',
      'https://user:secret@example.org/a',
    ])
      expect(documentLinkSchema.safeParse(url).success).toBe(false);
  });
});

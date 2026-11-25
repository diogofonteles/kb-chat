import { describe, expect, it } from 'vitest';
import { documentLinkSchema } from './document-uploads.js';
import {
  isMediaHost,
  mediaLinkKind,
  mediaLinkOf,
  webSearchCalls,
  webSearchKeyRequestSchema,
  webSearchRequestSchema,
} from './web-search.js';

const takes = (fields: object) =>
  webSearchRequestSchema.safeParse({ query: 'hermetismo', ...fields }).success;

describe('webSearchRequestSchema (KBC-185)', () => {
  it('trims the subject and looks for 10 sources of every kind when not told', () => {
    expect(webSearchRequestSchema.parse({ query: '  hermes  ' })).toEqual({
      query: 'hermes',
      sources: 10,
      kinds: ['text', 'audio', 'video'],
      authors: [],
    });
  });

  it('takes a subject of 3 to 500 characters, without the spaces around', () => {
    const query = (length: number) => takes({ query: 'a'.repeat(length) });
    expect([query(2), query(3), query(500), query(501)]).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(takes({ query: '  ab  ' })).toBe(false);
  });

  it('refuses no kind, an unknown one and a repeated one', () => {
    for (const kinds of [[], ['page'], ['text', 'text']])
      expect(takes({ kinds })).toBe(false);
    expect(takes({ kinds: ['video'] })).toBe(true);
  });

  it('takes 1 to 30 sources and no other field', () => {
    const sources = [0, 1, 30, 31, 5.5].map((one) => takes({ sources: one }));
    expect(sources).toEqual([false, true, true, false, false]);
    expect(takes({ country: 'BR' })).toBe(false);
  });

  it('takes up to 5 different authors of 2 to 80 characters', () => {
    const names = ['Ana', 'Bia', 'Caio', 'Davi', 'Eva', 'Fábio'];
    expect(takes({ authors: names.slice(0, 5) })).toBe(true);
    expect(takes({ authors: names })).toBe(false);
    expect(takes({ authors: ['Al'] })).toBe(true);
    expect(takes({ authors: [' A '] })).toBe(false);
    expect(takes({ authors: ['x'.repeat(80)] })).toBe(true);
    expect(takes({ authors: ['x'.repeat(81)] })).toBe(false);
    expect(
      webSearchRequestSchema.parse({ query: 'abc', authors: [' Hermes '] })
        .authors,
    ).toEqual(['Hermes']);
  });

  it('refuses the same author twice, whatever the case or the quotes, and one of only quotes', () => {
    expect(takes({ authors: ['Manly Hall', 'MANLY HALL'] })).toBe(false);
    expect(takes({ authors: ['Manly Hall', '"Manly Hall"'] })).toBe(false);
    expect(takes({ authors: ['"""'] })).toBe(false);
  });
});

describe('webSearchCalls', () => {
  it('is one per kind, or per kind and author', () => {
    expect(webSearchCalls(3, 0)).toBe(3);
    expect(webSearchCalls(2, 1)).toBe(2);
    expect(webSearchCalls(3, 5)).toBe(15);
  });
});

describe('mediaLinkOf', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s&list=PL1',
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
  ])('reads the YouTube video of %s', (url) => {
    expect(mediaLinkOf(url)).toEqual({
      kind: 'video',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
  });

  it.each([
    [
      'https://www.vimeo.com/76979871/?share=copy',
      'https://vimeo.com/76979871',
    ],
  ])('reads the Vimeo video of %s', (url, item) => {
    expect(mediaLinkOf(url)).toEqual({ kind: 'video', url: item });
  });

  it.each([
    [
      'https://m.soundcloud.com/alguem/uma-aula?utm_source=x',
      'https://soundcloud.com/alguem/uma-aula',
    ],
    [
      'https://archive.org/details/uma-palestra/faixa-1.mp3?start=3',
      'https://archive.org/details/uma-palestra',
    ],
    [
      'https://podcasts.apple.com/br/podcast/um-programa/id123?i=456&l=en',
      'https://podcasts.apple.com/br/podcast/um-programa/id123?i=456',
    ],
  ])('reads the audio of %s', (url, item) => {
    expect(mediaLinkOf(url)).toEqual({ kind: 'audio', url: item });
    expect(mediaLinkKind(url)).toBe('audio');
  });

  it.each([
    'https://www.youtube.com/@canal',
    'https://www.youtube.com/playlist?list=PL1',
    'https://www.youtube.com/watch?v=curto',
    'https://www.youtube.com/constructor',
    'https://youtu.be/',
    'https://vimeo.com/canal',
    'https://vimeo.com/channels/staffpicks/76979871',
    'https://soundcloud.com/alguem',
    'https://soundcloud.com/alguem/tracks',
    'https://soundcloud.com/alguem/sets/uma-lista',
    'https://soundcloud.com/search/sounds',
    'https://archive.org/search?query=hermes',
    'https://archive.org/details/@alguem',
    'https://web.archive.org/web/2020/https://exemplo.org/',
    'https://podcasts.apple.com/br/podcast/um-programa/id123',
    'https://exemplo.org/watch?v=dQw4w9WgXcQ',
    'http://constructor/watch?v=dQw4w9WgXcQ',
    'não é um endereço',
  ])('has no item for %s', (url) => {
    expect(mediaLinkOf(url)).toBeNull();
    expect(mediaLinkKind(url)).toBeNull();
  });
});

describe('isMediaHost', () => {
  it('tells the audio and video sites from the rest of the web', () => {
    for (const url of [
      'https://www.youtube.com/@canal',
      'https://player.vimeo.com/video/1',
      'https://on.soundcloud.com/abc',
      'https://archive.org/search',
      'https://podcasts.apple.com/br/podcast/x/id1',
    ])
      expect(isMediaHost(url), url).toBe(true);
    for (const url of [
      'https://notvimeo.com/1',
      'https://web.archive.org/web/2020/https://exemplo.org/',
      'https://apple.com/br',
      'https://exemplo.org/a',
      'não é um endereço',
    ])
      expect(isMediaHost(url), url).toBe(false);
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

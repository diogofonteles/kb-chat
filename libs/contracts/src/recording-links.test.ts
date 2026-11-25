import { describe, expect, it } from 'vitest';
import { recordingLinkKind } from './recording-links.js';

describe('recordingLinkKind (KBC-186)', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/watch?v=abc&list=PL1',
    'https://m.youtube.com/shorts/abc',
    'https://youtube.com/live/abc',
    'https://youtu.be/abc?t=10',
    'https://vimeo.com/123456',
    'https://vimeo.com/123456/abcdef',
    'https://www.instagram.com/reel/Cabc/',
    'https://www.instagram.com/pessoa/p/Cabc/',
    'https://www.facebook.com/pessoa/videos/o-segredo/1849272622730358/',
    'https://www.facebook.com/pessoa/videos/1849272622730358',
    'https://www.facebook.com/reel/1849272622730358',
    'https://m.facebook.com/watch/?v=1849272622730358',
    'https://fb.watch/aBc-1/',
    'https://www.facebook.com/share/v/1AbCd/',
    'https://www.facebook.com/share/r/1AbCd/',
    'https://soundcloud.com/pessoa/faixa',
    'https://podcasts.apple.com/br/podcast/nome/id1?i=1000',
    'https://example.org/episodios/01.mp3',
    'https://example.org/aula.MP4?x=1',
  ])('%s is a recording', (link) => {
    expect(recordingLinkKind(link)).toBe('recording');
  });

  it.each([
    'https://www.youtube.com/playlist?list=PL1',
    'https://www.youtube.com/@canal',
    'https://www.youtube.com/@canal/videos',
    'https://www.youtube.com/channel/UC1-2',
    'https://soundcloud.com/pessoa/sets/aulas',
    'https://vimeo.com/showcase/123',
  ])('%s is a list', (link) => {
    expect(recordingLinkKind(link)).toBe('list');
  });

  it.each([
    'https://example.org/artigo',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/about',
    'https://youtu.be/',
    'https://www.instagram.com/pessoa/',
    'https://www.facebook.com/pessoa',
    'https://www.facebook.com/pessoa/posts/123',
    'https://www.facebook.com/share/p/1AbCd/',
    'https://soundcloud.com/pessoa',
    'https://podcasts.apple.com/br/podcast/nome/id1',
    'https://notyoutube.com/watch?v=abc',
    'https://youtube.com.evil.example/watch?v=abc',
    'não é um endereço',
  ])('%s is a page, or nothing', (link) => {
    expect(recordingLinkKind(link)).toBeNull();
  });
});

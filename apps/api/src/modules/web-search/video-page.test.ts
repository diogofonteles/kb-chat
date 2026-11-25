import { describe, expect, it } from 'vitest';
import { isVideoSite, videoPageOf } from './video-page.js';

describe('videoPageOf (KBC-185)', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s&list=PL1'],
    ['http://youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share'],
  ])('gives the one address of the YouTube video in %s', (url) => {
    expect(videoPageOf(url)).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });

  it('gives the address of a numeric Vimeo page', () => {
    for (const url of [
      'https://vimeo.com/76979871',
      'https://www.vimeo.com/76979871/?share=copy',
    ])
      expect(videoPageOf(url)).toBe('https://vimeo.com/76979871');
  });

  it.each([
    ['https://www.youtube.com/@canal'],
    ['https://www.youtube.com/playlist?list=PL1'],
    ['https://www.youtube.com/watch?v=curto'],
    ['https://www.youtube.com/results?search_query=hermes'],
    ['https://www.youtube.com/'],
    ['https://youtu.be/'],
    ['https://vimeo.com/canal'],
    ['https://vimeo.com/channels/staffpicks/76979871'],
    ['https://exemplo.org/watch?v=dQw4w9WgXcQ'],
    ['não é um endereço'],
  ])('has no video page for %s', (url) => {
    expect(videoPageOf(url)).toBeNull();
  });
});

describe('isVideoSite', () => {
  it('tells YouTube and Vimeo from the rest of the web', () => {
    expect(isVideoSite('https://www.youtube.com/@canal')).toBe(true);
    expect(isVideoSite('https://player.vimeo.com/video/1')).toBe(true);
    expect(isVideoSite('https://notvimeo.com/1')).toBe(false);
    expect(isVideoSite('https://exemplo.org/a')).toBe(false);
    expect(isVideoSite('não é um endereço')).toBe(false);
  });
});

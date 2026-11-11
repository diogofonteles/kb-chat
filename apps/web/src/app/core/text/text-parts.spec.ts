import { textParts } from './text-parts.js';

describe('textParts', () => {
  it('cuts the text at the highlights', () => {
    expect(
      textParts('Tiuaco é Mariri.', [
        { start: 9, end: 15 },
        { start: 0, end: 6 },
      ]),
    ).toEqual([
      { text: 'Tiuaco', marked: true },
      { text: ' é ', marked: false },
      { text: 'Mariri', marked: true },
      { text: '.', marked: false },
    ]);
  });

  it('drops overlapping, empty and out-of-range highlights', () => {
    expect(
      textParts('abc', [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
        { start: 2, end: 2 },
        { start: 2, end: 9 },
      ]),
    ).toEqual([
      { text: 'ab', marked: true },
      { text: 'c', marked: false },
    ]);
  });

  it('keeps a text without highlights whole', () => {
    expect(textParts('olá', [])).toEqual([{ text: 'olá', marked: false }]);
  });
});

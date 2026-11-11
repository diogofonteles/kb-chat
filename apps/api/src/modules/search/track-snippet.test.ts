import { describe, expect, it } from 'vitest';
import { trackSnippet } from './track-snippet.js';

const BODY = [
  '# O que é o ritmo?',
  '',
  'Gravação: Palestra de 12/03/2017 · faixa 1 de 2 · Mestre Laércio · 3:48',
  '',
  '[0:03] Pergunta sobre o ritmo',
  '',
  '[0:41] O ritmo é a lei do pêndulo que tudo governa',
].join('\n');
const source = { body: BODY, summary: 'Uma faixa sobre o ritmo.' };

describe('trackSnippet (KBC-101 FR-8)', () => {
  it('shows the speech without anchors, with the anchor of its paragraph', () => {
    expect(
      trackSnippet('12: [0:41] O ritmo é a lei do pêndulo…', source),
    ).toEqual({
      snippet: 'O ritmo é a lei do pêndulo…',
      seconds: 41,
    });
  });

  it('never shows the frontmatter, the heading or the recording line: the summary instead', () => {
    for (const raw of [
      'title: O que é o ritmo?\nkb_chat_media_id: x',
      '# O que é o ritmo?',
      'Gravação: Palestra de 12/03/2017 · faixa 1 de 2',
    ])
      expect(trackSnippet(raw, source)).toEqual({
        snippet: 'Uma faixa sobre o ritmo.',
        seconds: null,
      });
  });

  it('without a summary, the first spoken paragraph', () => {
    expect(trackSnippet('', { body: BODY, summary: null })).toEqual({
      snippet: 'Pergunta sobre o ritmo',
      seconds: null,
    });
  });
});

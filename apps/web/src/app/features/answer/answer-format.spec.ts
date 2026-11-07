import type { AnswerSource } from '@kb-chat/contracts';
import {
  citedAt,
  citedSource,
  formatCost,
  renderAnswer,
} from './answer-format.js';

const TRACK: AnswerSource = {
  n: 1,
  id: 'raw/media/r/t.md',
  title: 'O que é o ritmo?',
  media: {
    mediaId: '0b9c1f7e-1111-4a2b-8c3d-000000000001',
    kind: 'track',
    recordingTitle: 'Palestra de 12/03/2017',
    durationMs: 508_000,
    confidence: 'normal',
  },
  passages: [
    { at: '0:41', startMs: 41_300, endMs: 70_000 },
    { at: '', startMs: 70_000, endMs: 95_000 },
  ],
};

describe('answer formatting', () => {
  it('drops raw HTML, links and images from model output, keeping citations', () => {
    const html = renderAnswer(
      'Veja <img src="https://evil/x?q=1"> e [site](https://evil) e ![x](https://evil/i.png) [1].',
      [{ n: 1, id: 'a.md', title: 'A' }],
    );
    expect(html).not.toMatch(/<img|href="https:\/\/evil/);
    expect(html).toContain('&lt;img');
    expect(html).toContain('site');
    expect(html).toContain(
      '<a class="cite" href="#fonte-1" aria-label="Fonte 1: A"',
    );
    expect(renderAnswer('sem fonte [9]')).toContain('[9]');
  });

  it('links citations with three or four digits, as long exhaustive answers number many sources (KBC-017)', () => {
    const html = renderAnswer('Obras [123] e [1234].', [
      { n: 123, id: 'a.md', title: 'A' },
      { n: 1234, id: 'b.md', title: 'B' },
    ]);
    expect(html).toContain('href="#fonte-123"');
    expect(html).toContain('href="#fonte-1234"');
  });

  it('wraps a Markdown table in a box that scrolls sideways, and only Markdown tables', () => {
    const html = renderAnswer(
      '| Princípio | Fonte |\n| --- | --- |\n| Ritmo | [1] |\n\n<table>x</table>',
    );
    expect(html).toContain('<div class="table-scroll"><table>');
    expect(html.match(/table-scroll/g)).toHaveLength(1);
    expect(html).toContain('&lt;table&gt;');
  });

  it('KBC-099 FR-7: a track citation shows [n], names the track and the minute, and keeps its time', () => {
    const host = document.createElement('div');
    host.innerHTML = renderAnswer('O ritmo [1@0:41] e [1].', [TRACK]);
    const [timed, plain] = [...host.querySelectorAll('a.cite')];
    expect(timed?.textContent).toBe('[1]');
    expect(timed?.getAttribute('aria-label')).toBe(
      'Fonte 1, faixa O que é o ritmo?, aos 41 segundos',
    );
    expect(citedAt(timed ?? null)).toBe('0:41');
    expect(plain?.getAttribute('aria-label')).toBe(
      'Fonte 1, faixa O que é o ritmo?, aos 1 minuto e 10 segundos',
    );
    expect(citedAt(plain ?? null)).toBe('');
    expect(citedSource(timed ?? null)).toBe(1);
  });

  it('a track citation of an answer without passages still opens the track', () => {
    const old: AnswerSource = {
      n: TRACK.n,
      id: TRACK.id,
      title: TRACK.title,
      ...(TRACK.media && { media: TRACK.media }),
    };
    const html = renderAnswer('O ritmo [1@0:41].', [old]);
    expect(html).toContain('aria-label="Fonte 1, faixa O que é o ritmo?"');
    expect(renderAnswer('Sem fonte [3@0:41].')).toContain('[3@0:41]');
  });

  it('formats costs in pt-BR', () => {
    expect(formatCost(0.00042)).toMatch(/^US\$\s0,0004$/);
  });

  it('reads the source number of a clicked citation', () => {
    const host = document.createElement('div');
    host.innerHTML = renderAnswer('Texto [2].', [
      { n: 2, id: 'b.md', title: 'B' },
    ]);
    expect(citedSource(host.querySelector('a.cite'))).toBe(2);
    expect(citedSource(host)).toBeNull();
  });
});

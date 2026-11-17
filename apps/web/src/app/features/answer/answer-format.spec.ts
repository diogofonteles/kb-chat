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
  it('KBC-110 FR-5: "[n]" of a restricted source is text read as "Fonte n, restrita", no link', () => {
    const html = renderAnswer(
      'Aberta [1] e velada [2].',
      [{ n: 1, id: 'a.md', title: 'A' }],
      [2],
    );

    expect(html).toContain('href="#fonte-1"');
    expect(html).not.toContain('#fonte-2');
    expect(html).toContain(
      '<span class="cite-restricted"><span aria-hidden="true">[2]</span><span class="visually-hidden">Fonte 2, restrita</span></span>',
    );
  });

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

  it('KBC-099 FR-7, KBC-150 item 7: a track citation shows its number with "título · tempo", names the track and the minute, and keeps its time', () => {
    const host = document.createElement('div');
    host.innerHTML = renderAnswer('O ritmo [1@0:41] e [1].', [TRACK]);
    const [timed, plain] = [...host.querySelectorAll('a.cite')];
    expect(timed?.classList.contains('cite-audio')).toBe(true);
    expect(timed?.querySelector('.cite-n')?.textContent).toBe('1');
    expect(timed?.querySelector('.cite-where')?.textContent).toBe(
      'O que é o ritmo? · 0:41',
    );
    expect(plain?.querySelector('.cite-where')?.textContent).toBe(
      'O que é o ritmo? · 1:10',
    );
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

  it('KBC-155 AC-6: consecutive citations of the same track are one pill with the times inside, each its own link', () => {
    const three: AnswerSource = {
      ...TRACK,
      passages: [
        { at: '1:16', startMs: 76_000, endMs: 80_000 },
        { at: '1:21', startMs: 81_000, endMs: 85_000 },
        { at: '0:48', startMs: 48_000, endMs: 52_000 },
      ],
    };
    const host = document.createElement('div');
    host.innerHTML = renderAnswer(
      'Na infância [1@1:16][1@1:21], [1@0:48]; [1@1:21].',
      [three],
    );
    const groups = host.querySelectorAll('.cite-group');
    expect(groups).toHaveLength(1);
    const group = groups[0] as HTMLElement;
    expect(group.textContent).toBe('1O que é o ritmo? · 1:16, 1:21, 0:48');
    const times = [...group.querySelectorAll('a.cite')];
    expect(times.map((one) => one.textContent)).toEqual([
      '1:16',
      '1:21',
      '0:48',
    ]);
    expect(times.map((one) => one.getAttribute('aria-label'))).toEqual([
      'Ouvir O que é o ritmo? aos 1 minuto e 16 segundos',
      'Ouvir O que é o ritmo? aos 1 minuto e 21 segundos',
      'Ouvir O que é o ritmo? aos 48 segundos',
    ]);
    expect(times.map((one) => citedAt(one))).toEqual(['1:16', '1:21', '0:48']);
    expect(times.map((one) => citedSource(one))).toEqual([1, 1, 1]);
    // Only the pill's own parts: the sentence around it is untouched.
    expect(host.textContent?.trim()).toBe(
      'Na infância 1O que é o ritmo? · 1:16, 1:21, 0:48.',
    );
  });

  it('KBC-155 AC-7: the grouped times read "0:50, 0:41": the comma right after the time, no space before it', () => {
    const host = document.createElement('div');
    host.innerHTML = renderAnswer('Tudo vibra [1@0:50], [1@0:41].', [
      {
        ...TRACK,
        passages: [
          { at: '0:50', startMs: 50_000, endMs: 53_000 },
          { at: '0:41', startMs: 41_000, endMs: 44_000 },
        ],
      },
    ]);
    const where = host.querySelector('.cite-group .cite-where') as HTMLElement;
    expect(where.textContent?.endsWith('0:50, 0:41')).toBe(true);
    const first = where.querySelector('a.cite.cite-time') as HTMLElement;
    expect(first.nextSibling?.textContent).toBe(', ');
    expect(host.textContent?.trim()).toMatch(/0:50, 0:41\.$/);
  });

  it('KBC-155: a time that names no passage links to the passage it shows, grouped or alone', () => {
    const two: AnswerSource = {
      ...TRACK,
      passages: [
        { at: '0:41', startMs: 41_000, endMs: 44_000 },
        { at: '0:50', startMs: 50_000, endMs: 53_000 },
      ],
    };
    const host = document.createElement('div');
    host.innerHTML = renderAnswer('Junto [1@9:99], [1@0:50]. Só [1@9:99].', [
      two,
    ]);
    const grouped = [...host.querySelectorAll('.cite-group a.cite-time')];
    expect(grouped.map((one) => one.textContent)).toEqual(['0:41', '0:50']);
    expect(grouped.map((one) => citedAt(one))).toEqual(['0:41', '0:50']);
    const alone = host.querySelector('a.cite-audio') as HTMLElement;
    expect(alone.textContent).toContain('0:41');
    expect(citedAt(alone)).toBe('0:41');
  });

  it('KBC-155 AC-7: a lone track citation, a text, another track or words in between are not grouped', () => {
    const other: AnswerSource = { ...TRACK, n: 2, title: 'Outra faixa' };
    const text: AnswerSource = { n: 3, id: 'leis.md', title: 'As leis' };
    const host = document.createElement('div');
    host.innerHTML = renderAnswer(
      'Um [1@0:41] [2@0:41] dois [1@0:41] e [1] três [3][3].',
      [TRACK, other, text],
    );
    expect(host.querySelectorAll('.cite-group')).toHaveLength(0);
    expect(host.querySelectorAll('a.cite-audio')).toHaveLength(4);
    expect(
      [...host.querySelectorAll('a.cite:not(.cite-audio)')].map(
        (one) => one.textContent,
      ),
    ).toEqual(['[3]', '[3]']);
    // The same passage twice in a row is one citation, not a pill of one time.
    host.innerHTML = renderAnswer('Um [1@0:41], [1@0:41].', [TRACK]);
    expect(host.querySelectorAll('.cite-group')).toHaveLength(0);
    expect(host.querySelectorAll('a.cite-audio')).toHaveLength(1);
    // A track saved without passages is not grouped either.
    const old: AnswerSource = {
      n: TRACK.n,
      id: TRACK.id,
      title: TRACK.title,
      ...(TRACK.media && { media: TRACK.media }),
    };
    host.innerHTML = renderAnswer('Um [1@0:41][1@1:10].', [old]);
    expect(host.querySelectorAll('.cite-group')).toHaveLength(0);
    expect(host.querySelectorAll('a.cite-audio')).toHaveLength(2);
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

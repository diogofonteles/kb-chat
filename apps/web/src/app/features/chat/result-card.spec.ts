import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { SearchHit } from '@kb-chat/contracts';
import { aHit } from '../../testing/fixtures.js';
import { ResultCard } from './result-card.js';

const providers = [provideZonelessChangeDetection()];

describe('ResultCard', () => {
  it('hides the facet and subject lines when the document has none', async () => {
    await render(ResultCard, {
      providers,
      inputs: {
        hit: aHit({ genre: null, depth: null, relevance: null, concepts: [] }),
      },
    });
    expect(screen.queryByText(/Assuntos:/)).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('lists up to two subjects without a counter and emits on click', async () => {
    const opened = vi.fn();
    await render(ResultCard, {
      providers,
      inputs: { hit: aHit({ concepts: ['Cabala', 'Alquimia'] }), active: true },
      on: { opened },
    });
    expect(screen.getByText(/Cabala · Alquimia/)).toBeTruthy();
    expect(screen.queryByText(/\(\+/)).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button'));
    expect(opened).toHaveBeenCalledOnce();
  });

  it('opens with the authorship badge: the Mestre with its mark, other authors outlined (KBC-020 AC-3)', async () => {
    const view = await render(ResultCard, {
      providers,
      inputs: { hit: aHit() },
    });
    const mestre = screen.getByText(/Mestre Laércio/);
    expect(mestre.closest('[data-authorship]')?.textContent).toMatch(
      /Autoria:\s*✦\s*Mestre Laércio/,
    );
    view.fixture.componentRef.setInput(
      'hit',
      aHit({ authorship: 'outros-autores', author: null }),
    );
    await view.fixture.whenStable();
    expect(screen.getByText(/Outros autores/)).toBeTruthy();
    expect(screen.queryByText(/Mestre Laércio/)).toBeNull();
    expect(screen.queryByText('✦')).toBeNull();
  });
});

describe('ResultCard in a parent collection (KBC-048)', () => {
  it('names the sub-collection and opens the hit and its copies there', async () => {
    const opened = vi.fn();
    const hit = aHit({
      topic: 'udv/palavra-do-mestre',
      copies: [{ id: 'raw/copia.md', title: 'Cópia' }],
    });
    await render(ResultCard, {
      providers,
      inputs: { hit, place: 'Palavra do Mestre' },
      on: { opened },
    });
    expect(screen.getByText('em Palavra do Mestre')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /A Lei do Ritmo/ }));
    expect(opened).toHaveBeenLastCalledWith({
      id: hit.id,
      title: hit.title,
      topic: 'udv/palavra-do-mestre',
    });
    fireEvent.click(screen.getByRole('button', { name: /1 cópia/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cópia raw\/copia/ }));
    expect(opened).toHaveBeenLastCalledWith({
      id: 'raw/copia.md',
      title: 'Cópia',
      topic: 'udv/palavra-do-mestre',
    });
  });

  it('says nothing about the place for a hit of the chosen collection itself', async () => {
    await render(ResultCard, { providers, inputs: { hit: aHit() } });
    expect(screen.queryByText(/^em /)).toBeNull();
  });
});

describe('ResultCard of a track (KBC-101)', () => {
  const MEDIA_ID = '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e';
  const track = (media: Partial<NonNullable<SearchHit['media']>> = {}) =>
    aHit({
      id: 'raw/media/r/t.md',
      title: 'O que é o ritmo?',
      genre: 'talk_or_interview',
      depth: 2,
      relevance: 'core',
      concepts: ['Cosmologia Espiritual'],
      snippet: 'O ritmo é a lei do pêndulo',
      media: {
        mediaId: MEDIA_ID,
        kind: 'track',
        recordingTitle: 'Palestra de 12/03/2017',
        ordinal: 3,
        total: 12,
        durationMs: 600_000,
        startMs: 495_000,
        endMs: 499_000,
        confidence: 'normal',
        stale: false,
        ...media,
      },
    });

  it('AC-10, AC-19: says "♪ Faixa · 8:15", the recording and its place, and is named for a screen reader', async () => {
    await render(ResultCard, { providers, inputs: { hit: track() } });
    const card = screen.getByRole('button', {
      name: 'Faixa de áudio, O que é o ritmo?, aos 8 minutos e 15 segundos',
    });
    // The spaces between the parts are the layout's gaps (the line breaks in two at 390 px).
    expect(card.textContent?.replace(/\s+/g, ' ')).toMatch(
      /♪ ?Faixa ?· ?8:15 ?Palestra de 12\/03\/2017 · faixa 3 de 12/,
    );
    expect(card.textContent).toContain('Aula ou palestra');
    expect(card.textContent).toContain('Cosmologia Espiritual');
    expect(screen.queryByText(/baixa confiança|atualizando/)).toBeNull();
  });

  it('AC-15: shows the merged spoken sentence with the words found marked', async () => {
    const view = await render(ResultCard, {
      providers,
      inputs: {
        hit: track({
          spoken: {
            text: 'O ritmo é a lei do pêndulo',
            highlights: [{ start: 2, end: 7 }],
          },
        }),
      },
    });
    const marks = view.container.querySelectorAll('mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual(['ritmo']);
  });

  it('AC-20: low confidence and "atualizando" say so in text', async () => {
    await render(ResultCard, {
      providers,
      inputs: { hit: track({ confidence: 'low', stale: true }) },
    });
    expect(screen.getByText('baixa confiança')).toBeTruthy();
    expect(screen.getByText('· atualizando')).toBeTruthy();
  });

  it('AC-19: Enter or a click opens the T22 panel on the card passage, never the document', async () => {
    const opened = vi.fn();
    const trackOpened = vi.fn();
    await render(ResultCard, {
      providers,
      inputs: { hit: track() },
      on: { opened, trackOpened },
    });
    const card = screen.getByRole('button');
    fireEvent.click(card);
    expect(opened).not.toHaveBeenCalled();
    expect(trackOpened).toHaveBeenCalledWith({
      at: '',
      trigger: card,
      source: expect.objectContaining({
        title: 'O que é o ritmo?',
        media: expect.objectContaining({
          mediaId: MEDIA_ID,
          ordinal: 3,
          total: 12,
        }),
        passages: [{ at: '', startMs: 495_000, endMs: 499_000 }],
      }),
    });
  });
});

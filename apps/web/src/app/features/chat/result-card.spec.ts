import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
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

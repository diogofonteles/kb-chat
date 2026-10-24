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
});

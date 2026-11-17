import { provideZonelessChangeDetection } from '@angular/core';
import type { LibraryFilters } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { aTopic } from '../../../testing/fixtures.js';
import { LibraryControls } from './library-controls.js';
import type { FilterChange } from './library-labels.js';

const NONE: LibraryFilters = {
  states: [],
  authors: [],
  topic: null,
  allTopics: false,
  subject: null,
};

async function renderControls(
  filters: LibraryFilters = NONE,
  subjects: readonly { key: string; name: string }[] = [],
) {
  const changes: FilterChange[] = [];
  const view = await render(LibraryControls, {
    providers: [provideZonelessChangeDetection()],
    inputs: {
      facets: {
        states: ['unheard', 'in-progress'],
        authors: [
          { slug: 'mestre-laercio', name: 'Mestre Laércio', main: true },
        ],
        otherAuthors: true,
        topics: ['udv/palavra-do-mestre', 'alquimia'],
        subjects: [...subjects],
      },
      filters,
      topics: [
        aTopic({ slug: 'alquimia', title: 'Alquimia' }),
        aTopic({ slug: 'hermetismo', title: 'Hermetismo' }),
        aTopic({ slug: 'udv', title: 'UDV' }),
        aTopic({
          slug: 'udv/palavra-do-mestre',
          title: 'Palavra do Mestre',
          parent: 'udv',
        }),
      ],
    },
    on: {
      filtersChange: (value: FilterChange) => changes.push(value),
    },
  });
  return { ...view, changes };
}

describe('LibraryControls (T16, SL-13/15/16)', () => {
  it('shows only the chips with media behind them', async () => {
    await renderControls();
    expect(screen.queryByRole('button', { name: 'Áudio' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Não ouvidas' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ouvidas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
  });

  it('presses a chip into the filters', async () => {
    const { changes } = await renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Não ouvidas' }));
    expect(changes).toEqual([{ kind: 'toggle-state', state: 'unheard' }]);
  });

  it('marks a pressed chip with aria-pressed and offers to clear', async () => {
    const { changes } = await renderControls({
      ...NONE,
      states: ['heard'],
    });
    const heard = screen.getByRole('button', { name: 'Ouvidas' });
    expect(heard.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(changes).toEqual([{ kind: 'clear' }]);
  });

  it('chooses an author in "Autoria ▾", and the chip of the collection in force, a sub-collection included, takes it away (AC-5)', async () => {
    const { changes, fixture } = await renderControls({
      ...NONE,
      topic: 'udv/palavra-do-mestre',
    });
    // The collection is chosen in the sidebar (D5); here it is named, with its ✕.
    const topic = screen.getByRole('button', {
      name: /^Ver todos os acervos \(tirar .*Palavra do Mestre\)$/,
    });
    expect(topic.textContent).toContain('Acervo:');
    fireEvent.click(topic);
    fireEvent.click(screen.getByRole('button', { name: 'Autoria' }));
    await fixture.whenStable();
    expect(
      screen
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent?.trim()),
    ).toEqual(['Mestre Laércio, principal', 'Outros autores']);
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: /Mestre Laércio, principal/ }),
    );
    expect(changes).toEqual([
      { kind: 'topic', topic: null },
      { kind: 'author', author: 'mestre-laercio' },
    ]);
  });

  it('shows a chosen author as a chip that clears it', async () => {
    const { changes } = await renderControls({
      ...NONE,
      authors: ['mestre-laercio'],
    });
    expect(screen.queryByRole('button', { name: 'Autoria' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Tirar o filtro de autoria: Mestre Laércio',
      }),
    );
    expect(changes).toEqual([{ kind: 'author', author: null }]);
  });
});

describe('LibraryControls "Assunto" (KBC-070 FR-4)', () => {
  const CABALA = { key: 'concept:cabala', name: 'Cabala' };

  it('is absent with no subject to offer', async () => {
    await renderControls();
    expect(screen.queryByRole('button', { name: 'Assunto' })).toBeNull();
  });

  it('offers the subjects and says which was chosen', async () => {
    const { changes, fixture } = await renderControls(NONE, [CABALA]);
    fireEvent.click(screen.getByRole('button', { name: 'Assunto' }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Cabala/ }));
    expect(changes).toEqual([{ kind: 'subject', subject: CABALA.key }]);
  });

  it('keeps a chosen subject that left, to be cleared', async () => {
    const { changes } = await renderControls(
      { ...NONE, subject: 'free:gone' },
      [CABALA],
    );
    const chosen = screen.getByRole('button', {
      name: 'Tirar o filtro de assunto: Assunto indisponível',
    });
    fireEvent.click(chosen);
    expect(changes).toEqual([{ kind: 'subject', subject: null }]);
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toBeTruthy();
  });

  it('keeps the collection in force on the list, even with no media (KBC-091)', async () => {
    await render(LibraryControls, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        facets: {
          states: [],
          authors: [],
          otherAuthors: false,
          topics: [],
          subjects: [],
        },
        filters: { ...NONE, topic: 'alquimia' },
        topics: [
          aTopic({ slug: 'alquimia', title: 'Alquimia' }),
          aTopic({ slug: 'hermetismo', title: 'Hermetismo' }),
        ],
      },
    });
    expect(
      screen.getByRole('button', {
        name: 'Ver todos os acervos (tirar Alquimia)',
      }).textContent,
    ).toContain('Acervo: Alquimia');
  });
});

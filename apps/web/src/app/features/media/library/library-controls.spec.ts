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
  subject: null,
};

async function renderControls(
  filters: LibraryFilters = NONE,
  subjects: readonly { key: string; name: string }[] = [],
) {
  const changes: FilterChange[] = [];
  const sorts: string[] = [];
  const views: string[] = [];
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
      sort: 'recently-played',
      view: 'list',
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
      sortChange: (value: string) => sorts.push(value),
      viewChange: (value: string) => views.push(value),
    },
  });
  return { ...view, changes, sorts, views };
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

  it('chooses an author and a collection, the parent of a sub-collection included (AC-5)', async () => {
    const { changes } = await renderControls();
    const topic = screen.getByLabelText('Acervo') as HTMLSelectElement;
    expect([...topic.options].map((option) => option.value)).toEqual([
      '',
      'alquimia',
      'udv',
      'udv/palavra-do-mestre',
    ]);
    fireEvent.change(topic, { target: { value: 'udv' } });
    fireEvent.change(screen.getByLabelText('Autoria'), {
      target: { value: 'mestre-laercio' },
    });
    expect(changes).toEqual([
      { kind: 'topic', topic: 'udv' },
      { kind: 'author', author: 'mestre-laercio' },
    ]);
  });

  it('orders through a menu button and switches the view', async () => {
    const { sorts, views, fixture } = await renderControls();
    fireEvent.click(
      screen.getByRole('button', { name: 'Ordenar: Ouvidas recentemente' }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Duração/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ver em grade' }));
    expect(sorts).toEqual(['duration']);
    expect(views).toEqual(['grid']);
  });
});

describe('LibraryControls "Assunto" (KBC-070 FR-4)', () => {
  const CABALA = { key: 'concept:cabala', name: 'Cabala' };

  it('is absent with no subject to offer', async () => {
    await renderControls();
    expect(screen.queryByRole('combobox', { name: 'Assunto' })).toBeNull();
  });

  it('offers the subjects and says which was chosen', async () => {
    const { changes } = await renderControls(NONE, [CABALA]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assunto' }), {
      target: { value: CABALA.key },
    });
    expect(changes).toEqual([{ kind: 'subject', subject: CABALA.key }]);
  });

  it('keeps a chosen subject that left, to be cleared', async () => {
    await renderControls({ ...NONE, subject: 'free:gone' }, [CABALA]);
    expect(
      screen.getByRole('option', { name: 'Assunto indisponível' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toBeTruthy();
  });
});

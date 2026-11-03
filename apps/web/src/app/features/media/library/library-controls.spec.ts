import { provideZonelessChangeDetection } from '@angular/core';
import type { LibraryFilters } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { aTopic } from '../../../testing/fixtures.js';
import { LibraryControls } from './library-controls.js';

const NONE: LibraryFilters = {
  states: [],
  authorships: [],
  topic: null,
};

async function renderControls(filters: LibraryFilters = NONE) {
  const changes: LibraryFilters[] = [];
  const sorts: string[] = [];
  const views: string[] = [];
  const view = await render(LibraryControls, {
    providers: [provideZonelessChangeDetection()],
    inputs: {
      facets: {
        states: ['unheard', 'in-progress'],
        authorships: ['mestre-laercio', 'outros-autores'],
        topics: ['udv/palavra-do-mestre', 'alquimia'],
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
      filtersChange: (value: LibraryFilters) => changes.push(value),
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
    expect(changes).toEqual([{ ...NONE, states: ['unheard'] }]);
  });

  it('marks a pressed chip with aria-pressed and offers to clear', async () => {
    const { changes } = await renderControls({
      ...NONE,
      states: ['heard'],
    });
    const heard = screen.getByRole('button', { name: 'Ouvidas' });
    expect(heard.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(changes).toEqual([NONE]);
  });

  it('chooses an authorship and a collection, the parent of a sub-collection included (AC-5)', async () => {
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
      { ...NONE, topic: 'udv' },
      { ...NONE, authorships: ['mestre-laercio'] },
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

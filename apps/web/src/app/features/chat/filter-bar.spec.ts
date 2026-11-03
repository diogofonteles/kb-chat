import { provideZonelessChangeDetection, signal } from '@angular/core';
import type { ResultFacets } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { aTopic } from '../../testing/fixtures.js';
import { NO_FILTERS } from './chat-message.js';
import { ChatStore } from './chat-store.js';
import { FilterBar } from './filter-bar.js';

const FACETS: ResultFacets = {
  concepts: Array.from({ length: 14 }, (_, i) => ({
    value: `Assunto ${i + 1}`,
    count: 20 - i,
  })),
  genres: [
    { value: 'article_or_essay', count: 7 },
    { value: 'talk_or_interview', count: 3 },
  ],
  depths: [{ value: 1, count: 10 }],
  relevances: [
    { value: 'core', count: 9 },
    { value: 'off_topic', count: 1 },
  ],
  authorships: [
    { value: 'mestre-laercio', count: 6 },
    { value: 'outros-autores', count: 3 },
    { value: 'sintese', count: 1 },
  ],
  topics: [{ value: 'hermetismo', count: 10 }],
};

async function renderBar(filters = NO_FILTERS, hiddenOffTopic = 0) {
  const filtersChange = vi.fn();
  const view = await render(FilterBar, {
    providers: [provideZonelessChangeDetection()],
    inputs: { facets: FACETS, filters, hiddenOffTopic },
    on: { filtersChange },
  });
  return { ...view, filtersChange };
}

describe('FilterBar (desktop popovers)', () => {
  it('opens a facet, lists values with counts and applies a choice at once', async () => {
    const view = await renderBar();
    const chip = screen.getByRole('button', { name: /Tipo de texto/ });
    fireEvent.click(chip);
    await view.fixture.whenStable();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const option = screen.getByRole('checkbox', { name: /Aula ou palestra/ });
    expect(option.closest('label')?.textContent).toContain('3');
    fireEvent.click(option);
    expect(view.filtersChange).toHaveBeenCalledWith({
      ...NO_FILTERS,
      genres: ['talk_or_interview'],
    });
  });

  it('shows 12 subjects first and the rest on "Ver todos"', async () => {
    const view = await renderBar();
    fireEvent.click(screen.getByRole('button', { name: /^Assuntos/ }));
    await view.fixture.whenStable();
    expect(screen.getAllByRole('checkbox')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos (14)' }));
    await view.fixture.whenStable();
    expect(screen.getAllByRole('checkbox')).toHaveLength(14);
  });

  it('closes the popover with Escape and with a click outside', async () => {
    const view = await renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Profundidade/ }));
    await view.fixture.whenStable();
    fireEvent.keyDown(screen.getByRole('checkbox'), { key: 'Escape' });
    await view.fixture.whenStable();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Profundidade/ }));
    await view.fixture.whenStable();
    fireEvent.click(document.body);
    await view.fixture.whenStable();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows active filters as removable chips, the count and hidden off-topic note', async () => {
    const filters = {
      ...NO_FILTERS,
      concepts: ['Assunto 1'],
      depths: [1 as const],
    };
    const view = await renderBar(filters, 2);
    expect(
      screen.getByRole('button', { name: /^Assuntos/ }).textContent,
    ).toContain('(1)');
    expect(screen.getByText('2 ocultos (fora do tema)')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remover Profundidade: Intermediário',
      }),
    );
    expect(view.filtersChange).toHaveBeenCalledWith({
      ...NO_FILTERS,
      concepts: ['Assunto 1'],
    });
  });

  it('keeps a selected value visible even when it has no results', async () => {
    const view = await renderBar({ ...NO_FILTERS, genres: ['paper'] });
    fireEvent.click(screen.getByRole('button', { name: /^Tipo de texto/ }));
    await view.fixture.whenStable();
    const paper = screen.getByRole('checkbox', {
      name: /Estudo acadêmico/,
    }) as HTMLInputElement;
    expect(paper.checked).toBe(true);
  });
});

describe('FilterBar focus', () => {
  it('returns focus to the facet chip when Escape closes its popover', async () => {
    const view = await renderBar();
    const chip = screen.getByRole('button', { name: /^Profundidade/ });
    fireEvent.click(chip);
    await view.fixture.whenStable();
    fireEvent.keyDown(screen.getByRole('checkbox'), { key: 'Escape' });
    await view.fixture.whenStable();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('moves focus to the facet chip after removing an active filter (desktop)', async () => {
    await renderBar({ ...NO_FILTERS, depths: [1] });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remover Profundidade: Intermediário',
      }),
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Profundidade/ }),
    );
  });

  it('closes the popover when focus leaves the facet', async () => {
    const view = await renderBar();
    const chip = screen.getByRole('button', { name: /^Profundidade/ });
    fireEvent.click(chip);
    await view.fixture.whenStable();
    fireEvent.focusOut(screen.getByRole('checkbox'), {
      relatedTarget: screen.getByRole('button', { name: /^Assuntos/ }),
    });
    await view.fixture.whenStable();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('lists the most recently applied filter first', async () => {
    const filters = {
      ...NO_FILTERS,
      concepts: ['Assunto 1'],
      genres: ['paper' as const],
    };
    await render(FilterBar, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        facets: FACETS,
        filters,
        order: ['genres:paper', 'concepts:Assunto 1'],
      },
    });
    const removers = screen.getAllByRole('button', { name: /^Remover/ });
    expect(removers[0]?.getAttribute('aria-label')).toBe(
      'Remover Assuntos: Assunto 1',
    );
  });
});

describe('FilterBar (mobile sheet)', () => {
  it('collects choices in a draft and applies them only on Aplicar', async () => {
    const view = await renderBar();
    fireEvent.click(
      screen.getByText('Filtros').closest('button') as HTMLButtonElement,
    );
    await view.fixture.whenStable();
    const sheet = screen.getByRole('dialog', { name: 'Filtros' });
    fireEvent.click(
      sheet.querySelector('input[type=checkbox]') as HTMLInputElement,
    );
    await view.fixture.whenStable();
    expect(view.filtersChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(view.filtersChange).toHaveBeenCalledWith({
      ...NO_FILTERS,
      concepts: ['Assunto 1'],
    });
  });

  it('discards the draft on Cancelar', async () => {
    const view = await renderBar();
    fireEvent.click(
      screen.getByText('Filtros').closest('button') as HTMLButtonElement,
    );
    await view.fixture.whenStable();
    const sheet = screen.getByRole('dialog', { name: 'Filtros' });
    fireEvent.click(
      sheet.querySelector('input[type=checkbox]') as HTMLInputElement,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos (14)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await view.fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.filtersChange).not.toHaveBeenCalled();
  });
});

describe('FilterBar authorship control (KBC-020 AC-2)', () => {
  const radio = (name: RegExp) => screen.getByRole('radio', { name });

  it('offers Todos, Mestre Laércio and Outros autores with counts, Todos by default', async () => {
    await renderBar();
    expect(screen.getByRole('radiogroup', { name: 'Autoria' })).toBeTruthy();
    expect(radio(/^Todos/).closest('label')?.textContent).toContain('10');
    expect(radio(/Mestre Laércio/).closest('label')?.textContent).toContain(
      '6',
    );
    expect(radio(/Outros autores/).closest('label')?.textContent).toContain(
      '3',
    );
    expect((radio(/^Todos/) as HTMLInputElement).checked).toBe(true);
  });

  it("names the main group by the open collection's main author (KBC-049 FR-4)", async () => {
    const udv = aTopic({
      slug: 'udv',
      title: 'UDV',
      mainAuthor: { slug: 'mestre-gabriel', name: 'Mestre Gabriel' },
    });
    await render(FilterBar, {
      providers: [
        provideZonelessChangeDetection(),
        // Only the open collection is read from the page's store.
        { provide: ChatStore, useValue: { topic: signal(udv) } },
      ],
      inputs: { facets: FACETS, filters: NO_FILTERS },
    });
    const main = radio(/Mestre Gabriel/).closest('label');
    expect(main?.textContent).toContain('✦');
    expect(main?.textContent).toContain('6');
    expect(screen.queryByRole('radio', { name: /Laércio/ })).toBeNull();
  });

  it('names the removable "Autoria" chips by the main author too (KBC-049)', async () => {
    const udv = aTopic({
      slug: 'udv',
      title: 'UDV',
      mainAuthor: { slug: 'mestre-gabriel', name: 'Mestre Gabriel' },
    });
    await render(FilterBar, {
      providers: [
        provideZonelessChangeDetection(),
        { provide: ChatStore, useValue: { topic: signal(udv) } },
      ],
      inputs: {
        facets: FACETS,
        filters: {
          ...NO_FILTERS,
          authorships: ['mestre-laercio', 'outros-autores'],
        },
      },
    });
    expect(
      screen.getByRole('button', { name: 'Remover Autoria: Mestre Gabriel' }),
    ).toBeTruthy();
    expect(screen.queryByText(/Laércio/)).toBeNull();
  });

  it('filters by one group at once and goes back to every group with Todos', async () => {
    const view = await renderBar();
    fireEvent.click(radio(/Mestre Laércio/));
    expect(view.filtersChange).toHaveBeenLastCalledWith({
      ...NO_FILTERS,
      authorships: ['mestre-laercio'],
    });
    view.fixture.componentRef.setInput('filters', {
      ...NO_FILTERS,
      authorships: ['mestre-laercio'],
    });
    await view.fixture.whenStable();
    expect((radio(/Mestre Laércio/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(radio(/^Todos/));
    expect(view.filtersChange).toHaveBeenLastCalledWith(NO_FILTERS);
  });

  it('disables a group without results unless it is the chosen one', async () => {
    const filtersChange = vi.fn();
    const view = await render(FilterBar, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        facets: {
          ...FACETS,
          authorships: [{ value: 'mestre-laercio', count: 4 }],
        },
        filters: NO_FILTERS,
      },
      on: { filtersChange },
    });
    await view.fixture.whenStable();
    expect((radio(/Outros autores/) as HTMLInputElement).disabled).toBe(true);
    expect(radio(/Outros autores/).closest('label')?.textContent).toContain(
      '0',
    );
  });

  it('keeps the authorship out of the removable chips, which the control already shows', async () => {
    await renderBar({ ...NO_FILTERS, authorships: ['outros-autores'] });
    expect(screen.queryByRole('list', { name: 'Filtros ativos' })).toBeNull();
  });

  it('shows several selected groups as removable chips, since the control reads them as Todos', async () => {
    const view = await renderBar({
      ...NO_FILTERS,
      authorships: ['sintese', 'nao-classificado'],
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remover Autoria: Síntese do acervo',
      }),
    );
    expect(view.filtersChange).toHaveBeenLastCalledWith({
      ...NO_FILTERS,
      authorships: ['nao-classificado'],
    });
  });
});

describe('FilterBar "Sub-acervo" (KBC-048 FR-4)', () => {
  const PARENT: ResultFacets = {
    ...FACETS,
    topics: [
      { value: 'udv', count: 2 },
      { value: 'udv/palavra-do-mestre', count: 5 },
    ],
  };
  const names = new Map([
    ['udv', 'UDV'],
    ['udv/palavra-do-mestre', 'Palavra do Mestre'],
  ]);

  it('offers the parent and its sub-collections by name and restricts to one', async () => {
    const filtersChange = vi.fn();
    const view = await render(FilterBar, {
      providers: [provideZonelessChangeDetection()],
      inputs: { facets: PARENT, filters: NO_FILTERS, topicNames: names },
      on: { filtersChange },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Sub-acervo/ }));
    await view.fixture.whenStable();
    const option = screen.getByRole('checkbox', { name: /Palavra do Mestre/ });
    expect(option.closest('label')?.textContent).toContain('5');
    fireEvent.click(option);
    expect(filtersChange).toHaveBeenCalledWith({
      ...NO_FILTERS,
      topics: ['udv/palavra-do-mestre'],
    });
  });

  it('is not offered when the search spans one collection only', async () => {
    await renderBar();
    expect(screen.queryByRole('button', { name: /^Sub-acervo/ })).toBeNull();
  });
});

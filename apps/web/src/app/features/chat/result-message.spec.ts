import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { aHit, aResponse } from '../../testing/fixtures.js';
import { NO_FILTERS, type ChatMessage } from './chat-message.js';
import { ResultMessage } from './result-message.js';

const base: ChatMessage = {
  id: 1,
  rev: 1,
  filters: NO_FILTERS,
  loadingMore: false,
  moreFailed: false,
  filterOrder: [],
  topic: 'hermetismo',
  question: 'xyzzy',
  mode: 'semantic',
  status: 'done',
  response: aResponse([]),
  error: null,
};

describe('ResultMessage', () => {
  it('does not offer a semantic search when the search already was semantic', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: base },
    });
    expect(screen.getByText('Nada encontrado para "xyzzy".')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Buscar por significado' }),
    ).toBeNull();
  });

  it('offers to remove each active filter when filters empty the list', async () => {
    const filtersChanged = vi.fn();
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        message: { ...base, filters: { ...NO_FILTERS, genres: ['paper'] } },
      },
      on: { filtersChanged },
    });
    expect(
      screen.getByText('Nada encontrado para "xyzzy" com estes filtros.'),
    ).toBeTruthy();
    // Both the active chip and the empty-state suggestion remove the filter.
    const removers = screen.getAllByRole('button', {
      name: 'Remover Tipo de texto: Estudo acadêmico',
    });
    expect(removers).toHaveLength(2);
    fireEvent.click(removers[1] as HTMLElement);
    expect(filtersChanged).toHaveBeenCalledWith(NO_FILTERS);
  });

  it('shows the searching skeleton until the first response', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        message: { ...base, status: 'loading', response: null },
        topicTitle: 'Hermetismo',
      },
    });
    expect(screen.getByText('Buscando em Hermetismo…')).toBeTruthy();
  });

  it('keeps the cards while a re-run refreshes them and offers more pages', async () => {
    const moreRequested = vi.fn();
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        message: {
          ...base,
          status: 'loading',
          response: aResponse([aHit()], { nextOffset: 10 }),
        },
      },
      on: { moreRequested },
    });
    expect(screen.getByText('Atualizando…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));
    expect(moreRequested).toHaveBeenCalledOnce();
  });

  it('reports a failed further page next to "Mostrar mais"', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        message: {
          ...base,
          moreFailed: true,
          response: aResponse([aHit()], { nextOffset: 10 }),
        },
      },
    });
    expect(screen.getByRole('alert').textContent).toMatch(
      /Não consegui carregar mais/,
    );
    expect(screen.getByRole('button', { name: 'Mostrar mais' })).toBeTruthy();
  });
});

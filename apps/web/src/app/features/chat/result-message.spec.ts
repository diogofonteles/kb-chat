import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { aHit, aMediaHit, aResponse, aTopic } from '../../testing/fixtures.js';
import { NO_FILTERS, type ChatMessage } from './chat-message.js';
import { ResultMessage } from './result-message.js';

const base: ChatMessage = {
  id: 1,
  rev: 1,
  filters: NO_FILTERS,
  kinds: ['text', 'audio'],
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

describe('ResultMessage in a parent collection (KBC-048 FR-4)', () => {
  const topics = [
    aTopic({ slug: 'udv', title: 'UDV' }),
    aTopic({
      slug: 'udv/palavra-do-mestre',
      title: 'Palavra do Mestre',
      parent: 'udv',
    }),
    aTopic({ slug: 'hermetismo', title: 'Hermetismo' }),
  ];
  const fromChild = aHit({ topic: 'udv/palavra-do-mestre' });
  const parentMessage: ChatMessage = {
    ...base,
    topic: 'udv',
    filters: { ...NO_FILTERS, topics: ['udv/palavra-do-mestre'] },
    response: {
      ...aResponse([fromChild]),
      facets: {
        ...aResponse([fromChild]).facets,
        topics: [
          { value: 'udv', count: 1 },
          { value: 'udv/palavra-do-mestre', count: 1 },
        ],
      },
    },
  };

  it('names the sub-collection of each result and of the active filter, by the message’s collection', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: parentMessage, topics },
    });
    expect(screen.getByText('em Palavra do Mestre')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Remover Sub-acervo: Palavra do Mestre',
      }),
    ).toBeTruthy();
  });

  it('says nothing about places for a message of a collection without sub-collections', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        message: { ...base, response: aResponse([aHit()]) },
        topics,
      },
    });
    expect(screen.queryByText(/^em /)).toBeNull();
  });
});

describe('ResultMessage with spoken passages (KBC-039)', () => {
  const withAudio = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    ...base,
    mode: 'all',
    response: aResponse(
      [aHit({ id: 'a.md', score: 0.99 }), aHit({ id: 'b.md', score: 0.2 })],
      {
        media: [
          aMediaHit({ score: 0.5 }),
          aMediaHit({ startMs: 60_000, score: 0.4, confidence: 'low' }),
        ],
        kinds: { text: 2, audio: 7 },
      },
    ),
    ...overrides,
  });

  it('mixes the passages among the documents by relevance, with the minute and the badge (FR-6, AC-1, AC-5)', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: withAudio() },
    });
    const items = screen.getAllByRole('listitem');
    expect(
      items.map((item) =>
        item.querySelector('[data-media-id]') ? 'audio' : 'text',
      ),
    ).toEqual(['text', 'audio', 'audio', 'text']);
    expect(items[1]?.textContent).toContain('Áudio · Na fala');
    expect(items[1]?.textContent).toContain('8:15');
    expect(items[1]?.querySelector('.snippet')?.textContent?.trim()).toBe(
      'Tiuaco é Mariri na história.',
    );
    expect(items[1]?.textContent).not.toContain('baixa confiança');
    expect(items[2]?.textContent).toContain('baixa confiança');
    expect(screen.getByText(/2 trechos na fala/)).toBeTruthy();
  });

  it('opens a passage with its place among the results (FR-4)', async () => {
    const passageOpened = vi.fn();
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: withAudio() },
      on: { passageOpened },
    });
    fireEvent.click(
      screen.getAllByRole('button', {
        name: /Palestra do Tiuaco/,
      })[0] as HTMLElement,
    );
    expect(passageOpened).toHaveBeenCalledWith({
      hit: expect.objectContaining({ startMs: 495_000 }),
      position: 2,
    });
  });

  it('offers "Buscar em" with the counts and asks again with the new choice (FR-5, AC-9)', async () => {
    const kindsChanged = vi.fn();
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: withAudio() },
      on: { kindsChanged },
    });
    const group = screen.getByRole('group', { name: 'Buscar em' });
    expect(group.textContent).toMatch(/Textos\s*2/);
    expect(group.textContent).toMatch(/Áudios\s*7/);
    fireEvent.click(screen.getByRole('checkbox', { name: /Textos/ }));
    expect(kindsChanged).toHaveBeenCalledWith(['audio']);
  });

  it('keeps the last kind chosen: it cannot be unchecked (BR-4)', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: withAudio({ kinds: ['audio'] }) },
    });
    const audio = screen.getByRole('checkbox', { name: /Áudios/ });
    expect((audio as HTMLInputElement).checked).toBe(true);
    expect((audio as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: /Textos/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it('has no "Buscar em" where the collection has no audio for this person', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: { ...base, response: aResponse([aHit()]) } },
    });
    expect(screen.queryByRole('group', { name: 'Buscar em' })).toBeNull();
    expect(document.querySelector('[data-media-id]')).toBeNull();
  });

  it('marks the passage open in the reading panel', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        message: withAudio(),
        activePassage: `${aMediaHit().mediaId}@495000`,
      },
    });
    const pressed = screen
      .getAllByRole('button', { pressed: true })
      .map((button) => button.getAttribute('data-media-id'));
    expect(pressed).toEqual([aMediaHit().mediaId]);
  });
});

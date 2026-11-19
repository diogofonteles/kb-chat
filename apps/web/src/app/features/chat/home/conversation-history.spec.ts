import { provideZonelessChangeDetection, signal } from '@angular/core';
import type { Conversation, ConversationSummary } from '@kb-chat/contracts';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { of } from 'rxjs';
import { HistoryStore } from '@core/history/history-store.js';
import { RESEARCH_RESTORER } from '@core/history/research-restorer.js';
import { ChatStore } from '../chat-store.js';
import { ViewStore } from '../view-store.js';
import { ConversationHistory } from './conversation-history.js';

const SUMMARIES: ConversationSummary[] = [
  {
    id: 'c-1',
    kind: 'research',
    topic: 'hermetismo',
    title: 'Quais livros o Mestre recomenda?',
    updatedAt: '2026-11-17T10:00:00.000Z',
    count: 1,
    status: 'failed',
  },
  {
    id: 'c-2',
    kind: 'search',
    topic: 'hermetismo',
    title: 'lei do ritmo',
    updatedAt: '2026-11-17T09:00:00.000Z',
    count: 1,
  },
];

async function setup() {
  const conversations = signal(SUMMARIES);
  const saved = { id: 'c-2', kind: 'search' } as unknown as Conversation;
  const history = {
    conversations,
    load: vi.fn(() => of(saved)),
    remove: vi.fn((id: string) =>
      conversations.update((list) => list.filter((c) => c.id !== id)),
    ),
  };
  const chat = {
    topicList: signal([{ slug: 'hermetismo', title: 'Hermetismo' }]),
    restore: vi.fn(),
  };
  const views = { select: vi.fn() };
  const restorer = { restore: vi.fn() };
  const restored = vi.fn();
  const view = await render(ConversationHistory, {
    providers: [
      provideZonelessChangeDetection(),
      { provide: HistoryStore, useValue: history },
      { provide: ChatStore, useValue: chat },
      { provide: ViewStore, useValue: views },
      { provide: RESEARCH_RESTORER, useValue: restorer },
    ],
    on: { restored },
  });
  return { view, history, chat, views, restorer, restored };
}

describe('ConversationHistory (chat-history@mobile)', () => {
  it('lists each conversation with its kind and how it stands, or its collection', async () => {
    await setup();
    const rows = within(screen.getByRole('list', { name: 'Conversas' }))
      .getAllByRole('listitem')
      .map((li) => [
        li.querySelector('.title')?.textContent?.trim(),
        li.querySelector('.meta')?.textContent?.trim(),
        li.querySelector('.meta')?.classList.contains('failed'),
      ]);
    expect(rows).toEqual([
      ['Quais livros o Mestre recomenda?', 'Pesquisa com IA · falhou', true],
      ['lei do ritmo', 'Busca · Hermetismo', false],
    ]);
  });

  it('filters by kind with the chips Tudo, Pesquisa com IA and Busca', async () => {
    const { view } = await setup();
    const tudo = screen.getByRole('radio', { name: 'Tudo' });
    expect(tudo.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Busca' }));
    await view.fixture.whenStable();
    expect(screen.queryByText('Quais livros o Mestre recomenda?')).toBeNull();
    expect(screen.getByText('lei do ritmo')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Pesquisa com IA' }));
    await view.fixture.whenStable();
    expect(screen.queryByText('lei do ritmo')).toBeNull();
  });

  it('opens a search in the search view and says it is back on screen', async () => {
    const { history, chat, views, restored } = await setup();
    fireEvent.click(screen.getByText('lei do ritmo'));
    expect(history.load).toHaveBeenCalledWith('c-2');
    expect(views.select).toHaveBeenCalledWith('search');
    expect(chat.restore).toHaveBeenCalled();
    expect(restored).toHaveBeenCalled();
  });

  it('deletes a conversation from its ⋯ only after it is confirmed', async () => {
    const { view, history } = await setup();
    HTMLDialogElement.prototype.showModal ??= function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais opções: lei do ritmo' }),
    );
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apagar conversa' }));
    await view.fixture.whenStable();
    expect(history.remove).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Apagar', hidden: true }),
    );
    expect(history.remove).toHaveBeenCalledWith('c-2');
    await view.fixture.whenStable();
    expect(
      screen.queryByText('lei do ritmo', { selector: '.title' }),
    ).toBeNull();
  });
});

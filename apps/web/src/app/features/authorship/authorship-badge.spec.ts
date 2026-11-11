import { provideZonelessChangeDetection, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import type { Authorship, MediaAuthor } from '@kb-chat/contracts';
import { ChatStore } from '@features/chat/chat-store.js';
import { aTopic } from '../../testing/fixtures.js';
import { AuthorshipBadge } from './authorship-badge.js';

async function badge(
  inputs: { authorship?: Authorship; mediaAuthor?: MediaAuthor },
  mainAuthor: string | null = null,
) {
  const topic = aTopic({
    slug: 'udv',
    title: 'UDV',
    mainAuthor: mainAuthor ? { slug: 'main', name: mainAuthor } : null,
  });
  const view = await render(AuthorshipBadge, {
    providers: [
      provideZonelessChangeDetection(),
      // Only the open collection is read from the page's store.
      { provide: ChatStore, useValue: { topic: signal(topic) } },
    ],
    inputs,
  });
  return view.container.querySelector('.authorship-badge');
}

describe('AuthorshipBadge (KBC-020, KBC-049)', () => {
  it("names the documents of the main group by the collection's main author, with ✦", async () => {
    const shown = await badge(
      { authorship: 'mestre-laercio' },
      'Mestre Gabriel',
    );
    expect(shown?.textContent).toMatch(/Autoria:\s*✦\s*Mestre Gabriel/);
    expect(shown?.getAttribute('data-authorship')).toBe('mestre-laercio');
  });

  it('keeps "Mestre Laércio" where the collection has no main author', async () => {
    const shown = await badge({ authorship: 'mestre-laercio' });
    expect(shown?.textContent).toContain('Mestre Laércio');
  });

  it('shows a media author by name, filled with ✦ only when main', async () => {
    const main = await badge({
      mediaAuthor: { slug: 'g', name: 'Mestre Gabriel', main: true },
    });
    expect(main?.textContent).toMatch(/✦\s*Mestre Gabriel/);
    expect(main?.getAttribute('data-authorship')).toBe('mestre-laercio');
  });

  it('outlines another author, without the mark', async () => {
    const other = await badge({
      mediaAuthor: { slug: 'ana', name: 'Ana Souza', main: false },
    });
    expect(other?.textContent).toContain('Ana Souza');
    expect(other?.textContent).not.toContain('✦');
    expect(other?.getAttribute('data-authorship')).toBe('outros-autores');
  });

  it('groups media with no author as "Outros autores"', async () => {
    const none = await badge({ mediaAuthor: null });
    expect(none?.textContent).toContain('Outros autores');
  });

  it('draws nothing without an authorship (a turn saved before KBC-020)', async () => {
    expect(await badge({})).toBeNull();
    expect(screen.queryByText(/Autoria/)).toBeNull();
  });
});

import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import type { SearchKind } from '@kb-chat/contracts';
import { UiCover, UiIcon, UiMenu, UiMenuItem } from '@ui/index.js';
import { ChatStore } from '../chat-store.js';
import { ALL_KINDS } from '../search-kinds.js';
import { ViewStore } from '../view-store.js';

/** The reach the scope chips pick: every kind, only the texts, or the AI research. */
export type Scope = 'all' | 'documents' | 'research';

/**
 * The row at the top of the main panel (v2 · Conversa, `escopo`): Tudo · Documentos ·
 * Pesquisa com IA, which also switch between the search and the research (the v1 view
 * switch), and "Em: <acervo> · N documentos" with the menu that changes the collection.
 * On a phone the collection lives in the Menu, so `compact` leaves it out.
 */
@Component({
  selector: 'app-scope-bar',
  imports: [DecimalPipe, UiCover, UiIcon, UiMenu, UiMenuItem],
  templateUrl: './scope-bar.html',
  styleUrl: './scope-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScopeBar {
  protected readonly store = inject(ChatStore);
  protected readonly views = inject(ViewStore);

  readonly researching = input(false);
  /** Without "Em: <acervo>" (phones). */
  readonly compact = input(false);
  /** Another collection was chosen: the page moves the focus to the question box. */
  readonly collectionChosen = output();

  protected readonly topic = this.store.topic;
  protected readonly collections = computed(() =>
    this.store.topicList().filter((topic) => topic.canOpen),
  );
  protected readonly scope = computed((): Scope => {
    if (this.researching()) return 'research';
    const kinds = this.store.kinds();
    return kinds.length === 1 && kinds[0] === 'text' ? 'documents' : 'all';
  });

  protected chooseScope(scope: Scope): void {
    if (scope === 'research') {
      this.views.select('research');
      return;
    }
    const kinds: readonly SearchKind[] =
      scope === 'documents' ? ['text'] : ALL_KINDS;
    this.store.setKinds(kinds);
    this.views.select('search');
  }

  /** Arrows move the choice among the enabled chips, as in a radio group. */
  protected moveScope(event: KeyboardEvent): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    const group = event.currentTarget as HTMLElement;
    const chips = [
      ...group.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ].filter((chip) => !chip.disabled);
    const at = chips.findIndex(
      (chip) => chip.dataset['scope'] === this.scope(),
    );
    const next = chips[(at + step + chips.length) % chips.length];
    if (!next) return;
    event.preventDefault();
    next.click();
    next.focus();
  }

  protected chooseCollection(slug: string): void {
    this.store.selectTopic(slug);
    this.collectionChosen.emit();
  }
}

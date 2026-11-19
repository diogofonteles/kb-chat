import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import type { AnswerSource, DocumentRef } from '@kb-chat/contracts';
import { ChatStore, type CitedSource } from '@features/chat/chat-store.js';
import { DocumentPanel } from '@features/document/document-panel.js';
import { TrackPassagePanel } from '@features/media/track-passage/track-passage-panel.js';
import { UiIcon } from '@ui/icon.js';
import { ResearchMessage, type OpenedSource } from './research-message.js';
import type { TrackOpening } from './track-opening.js';
import { citedSources, type ResearchTurn } from './research-turn.js';

/** A source of an answer opened beside it: which one, the answer's question and its list. */
export interface SourceOpening {
  readonly doc: DocumentRef;
  readonly question: string;
  readonly sources: readonly CitedSource[];
  /** The citation or row that opened it: the focus goes back there (FR-2). */
  readonly trigger: HTMLElement | null;
}

/** Below this width a source opens in the reading sheet over the answer (FR-2). */
const PHONE_QUERY = '(max-width: 1023px)';
/** How far the sheet's head is dragged down before it lets go (a flick, not a tap). */
const DRAG_CLOSE_PX = 80;

/** Where each tab key moves from tab `at` of `count` (ARIA APG tabs, wrapping at the ends). */
const TAB_KEYS: Readonly<
  Record<string, ((at: number, count: number) => number) | undefined>
> = {
  ArrowRight: (at, count) => (at + 1) % count,
  ArrowLeft: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_at, count) => count - 1,
};

/** The tab an arrow, Home or End selects from tab `at` of `count` (null: not a tab key). */
export function tabTarget(
  key: string,
  at: number,
  count: number,
): number | null {
  const move = TAB_KEYS[key];
  return move ? move(at, count) : null;
}

/**
 * What the reading sheet shows: the answer's cited sources (texts and tracks, a tab each), the
 * one open and, for a track, the time its citation wrote (KBC-127 FR-2, KBC-150 item 8).
 */
interface Reading {
  readonly question: string;
  readonly tabs: readonly AnswerSource[];
  readonly current: AnswerSource;
  readonly at: string;
  /** The citation or chip that opened it: the focus goes back there. */
  readonly trigger: HTMLElement | null;
}

/**
 * The "Pesquisa com IA" conversation: only the agent's answers, never search cards (BR-6).
 * A cited text opens beside the answer (the page's 460 panel) or, on a phone, in a reading
 * sheet of 85% with a tab per source, the answer still under it (KBC-127 FR-1, FR-2).
 */
@Component({
  selector: 'app-research-thread',
  imports: [ResearchMessage, DocumentPanel, TrackPassagePanel, UiIcon],
  template: `
    @for (turn of turns(); track turn.id) {
      <app-research-message
        [turn]="turn"
        [last]="$last"
        [activeSource]="activeSources().get(turn.id) ?? null"
        [activeAt]="activeAt()"
        (opened)="openSource(turn, $event)"
        (trackOpened)="openTrack($event)"
        (stopped)="stopped.emit()"
        (retried)="retried.emit()"
        (redone)="redone.emit()"
        (continued)="continued.emit()"
      />
    }
    <p class="visually-hidden" aria-live="polite">{{ announcement() }}</p>

    <!-- The backdrop tap is a pointer way out only: Escape and drag close it too. -->
    <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
    <dialog
      #sheet
      class="reading-sheet"
      [class.full]="full()"
      aria-label="Fonte"
      i18n-aria-label="@@source.sheet"
      [style.translate]="dragOffset()"
      (close)="sheetClosed()"
      (click)="backdropClick($event)"
    >
      @if (reading(); as open) {
        <div
          class="sheet-head"
          (pointerdown)="dragStart($event)"
          (pointermove)="dragMove($event)"
          (pointerup)="dragEnd()"
          (pointercancel)="dragEnd()"
        >
          <span class="handle" aria-hidden="true"></span>
          <div class="tabs-row">
            <div
              class="tabs"
              role="tablist"
              aria-label="Fontes"
              i18n-aria-label="@@source.tabs"
            >
              @for (source of open.tabs; track source.n) {
                <!-- The APG tabs: only the selected tab is a Tab stop; arrows, Home and End move. -->
                <button
                  #tab
                  type="button"
                  role="tab"
                  class="tab"
                  [id]="tabId(source)"
                  [attr.aria-selected]="source.n === open.current.n"
                  [attr.tabindex]="source.n === open.current.n ? 0 : -1"
                  aria-controls="reading-source"
                  [class.audio]="!!source.media"
                  (click)="choose(source)"
                  (keydown)="tabKey($event)"
                >
                  @if (source.media) {
                    <ui-icon name="wave" [size]="12" />
                  }
                  <span i18n="@@source.tab">Fonte {{ source.n }}</span>
                </button>
              }
            </div>
            <button
              type="button"
              class="sheet-tool"
              [attr.aria-pressed]="full()"
              aria-label="Tela cheia"
              i18n-aria-label="@@source.fullscreen"
              (click)="full.set(!full())"
            >
              <ui-icon name="expand" [size]="18" />
            </button>
            <button
              type="button"
              class="sheet-tool"
              aria-label="Fechar"
              i18n-aria-label="@@ui.dialog.close"
              (click)="closeSheet()"
            >
              <ui-icon name="close" [size]="20" />
            </button>
          </div>
        </div>
        @if (open.current.media) {
          <app-track-passage-panel
            id="reading-source"
            class="sheet-reader"
            [labelledBy]="tabId(open.current)"
            [focusTitle]="!fromTab()"
            [inSheet]="true"
            [source]="open.current"
            [at]="open.at"
            [sources]="open.tabs"
            [topic]="topic()"
            [topics]="chat.topicList()"
            (closed)="closeSheet()"
          />
        } @else {
          <app-document-panel
            id="reading-source"
            role="tabpanel"
            class="sheet-reader"
            [labelledBy]="tabId(open.current)"
            [focusTitle]="!fromTab()"
            [topic]="topic()"
            [documentId]="open.current.id"
            [fallbackTitle]="open.current.title"
            [highlight]="open.question"
            [inSheet]="true"
            [sourceMode]="true"
            (closed)="closeSheet()"
            (documentOpened)="openDocument(open.current)"
            (navigated)="openDocument($event)"
            (trackOpened)="openTrack($event)"
          />
        }
      }
    </dialog>
  `,
  styleUrl: './research-thread.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResearchThread {
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly injector = inject(Injector);
  protected readonly chat = inject(ChatStore);
  private readonly sheet =
    viewChild.required<ElementRef<HTMLDialogElement>>('sheet');
  private readonly tabs = viewChildren<ElementRef<HTMLButtonElement>>('tab');

  readonly turns = input.required<readonly ResearchTurn[]>();
  /** The document open in the page's panel: its source is marked in its answer. */
  readonly openDocumentId = input<string | null>(null);
  readonly opened = output<SourceOpening>();
  readonly trackOpened = output<TrackOpening>();
  readonly stopped = output();
  readonly retried = output();
  readonly redone = output();
  /** "Continuar varredura" on the last turn (KBC-030). */
  readonly continued = output();

  protected readonly topic = computed(() => this.chat.topicSlug() ?? '');
  protected readonly reading = signal<Reading | null>(null);
  protected readonly full = signal(false);
  private readonly drag = signal<{ start: number; now: number } | null>(null);
  /** The sheet closed into the page's document: focus stays there, not on the citation. */
  private leftToDocument = false;
  /** The source on screen was chosen on a tab, which keeps the focus (ARIA APG tabs). */
  protected readonly fromTab = signal(false);
  protected readonly dragOffset = computed(() => {
    const drag = this.drag();
    return drag ? `0 ${Math.max(0, drag.now - drag.start)}px` : null;
  });

  /**
   * Short live-region text: the streamed tokens are not announced, and errors already are
   * (role="alert" in the message).
   */
  protected readonly announcement = computed(() => {
    const last = this.turns().at(-1);
    const ready = last?.phase === 'done' && !last.interrupted && !last.restored;
    return ready ? $localize`:@@ai.ready:Resposta da IA pronta.` : '';
  });

  /**
   * The source marked in each answer: the one open in the sheet, in the page's document panel
   * or, a track, in the page's audio source (KBC-150 item 7).
   */
  protected readonly activeSources = computed(() => {
    const reading = this.reading();
    const id = this.openDocumentId();
    const track = this.chat.openTrack();
    return new Map(
      this.turns().map((turn) => {
        if (reading)
          return [
            turn.id,
            reading.question === turn.question ? reading.current.n : null,
          ];
        if (track?.question !== undefined)
          return [
            turn.id,
            track.question === turn.question ? track.source.n : null,
          ];
        const open = turn.sources.find((source) => source.id === id);
        return [turn.id, open?.n ?? null];
      }),
    );
  });

  /** The time of the open track's citation: only that one is filled (KBC-150 item 7). */
  protected readonly activeAt = computed(() => {
    const reading = this.reading();
    if (reading) return reading.current.media ? reading.at : null;
    return this.chat.openTrack()?.at ?? null;
  });

  protected openSource(turn: ResearchTurn, opened: OpenedSource): void {
    const sources = citedSources(turn)
      .filter((source) => !source.media)
      .map(({ n, id, title }) => ({ n, id, title }));
    const opening: SourceOpening = {
      doc: { id: opened.id, title: opened.title },
      question: turn.question,
      sources,
      trigger: opened.trigger,
    };
    const tabs = citedSources(turn);
    const current = tabs.find((source) => source.id === opened.id);
    if (!current || !this.isPhone()) {
      this.opened.emit(opening);
      return;
    }
    this.showSheet({
      question: turn.question,
      tabs,
      current,
      at: '',
      trigger: opened.trigger,
    });
  }

  /**
   * A track: beside the answer on a desktop (the page's audio source); on a phone, in the
   * reading sheet with a tab per source (KBC-150 item 8).
   */
  protected openTrack(opening: TrackOpening): void {
    const tabs = opening.sources ?? [];
    if (!this.isPhone() || !tabs.some((one) => one.n === opening.source.n)) {
      this.trackOpened.emit(opening);
      return;
    }
    const reading = this.reading();
    if (reading) {
      this.reading.set({ ...reading, current: opening.source, at: opening.at });
      return;
    }
    this.showSheet({
      question: opening.question ?? '',
      tabs,
      current: opening.source,
      at: opening.at,
      trigger: opening.trigger,
    });
  }

  private showSheet(reading: Reading): void {
    this.reading.set(reading);
    this.fromTab.set(false);
    this.full.set(false);
    afterNextRender(() => this.sheet().nativeElement.showModal(), {
      injector: this.injector,
    });
  }

  protected choose(source: AnswerSource): void {
    this.fromTab.set(true);
    this.reading.update(
      (open) =>
        open && {
          ...open,
          current: source,
          at: source.passages?.[0]?.at ?? '',
        },
    );
  }

  protected tabId(source: AnswerSource): string {
    return `reading-tab-${source.n}`;
  }

  /** Arrows, Home and End choose another tab and move the focus to it (ARIA APG tabs). */
  protected tabKey(event: KeyboardEvent): void {
    const reading = this.reading();
    if (!reading) return;
    const sources = reading.tabs;
    const at = sources.findIndex((source) => source.n === reading.current.n);
    const target = tabTarget(event.key, at, sources.length);
    if (target === null) return;
    event.preventDefault();
    const source = sources[target];
    if (!source) return;
    this.choose(source);
    this.tabs()[target]?.nativeElement.focus();
  }

  /** "Abrir documento" or a related one: the page's document, out of the sheet. */
  protected openDocument(doc: DocumentRef): void {
    const reading = this.reading();
    this.leftToDocument = reading !== null;
    this.closeSheet();
    if (!reading) return;
    this.chat.openSource(this.topic(), doc, {
      question: reading.question,
      sources: [],
    });
    this.chat.leaveSources();
  }

  protected closeSheet(): void {
    this.sheet().nativeElement.close();
  }

  /** Native "close" (Escape, ✕, drag or backdrop): back to the citation that opened it. */
  protected sheetClosed(): void {
    const trigger = this.leftToDocument
      ? null
      : (this.reading()?.trigger ?? null);
    this.leftToDocument = false;
    this.reading.set(null);
    this.drag.set(null);
    trigger?.focus();
  }

  protected backdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeSheet();
  }

  protected dragStart(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest('button')) return;
    this.drag.set({ start: event.clientY, now: event.clientY });
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  protected dragMove(event: PointerEvent): void {
    this.drag.update((drag) => drag && { ...drag, now: event.clientY });
  }

  /** Dragged down far enough, the sheet closes; else it springs back. */
  protected dragEnd(): void {
    const drag = this.drag();
    this.drag.set(null);
    if (drag && drag.now - drag.start > DRAG_CLOSE_PX) this.closeSheet();
  }

  private isPhone(): boolean {
    return this.view?.matchMedia?.(PHONE_QUERY).matches ?? false;
  }
}

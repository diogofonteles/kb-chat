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
} from '@angular/core';
import type { DocumentRef } from '@kb-chat/contracts';
import { ChatStore, type CitedSource } from '@features/chat/chat-store.js';
import { DocumentPanel } from '@features/document/document-panel.js';
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

/** What the reading sheet shows: the answer's sources and the one open. */
interface Reading {
  readonly opening: SourceOpening;
  readonly current: CitedSource;
}

/**
 * The "Pesquisa com IA" conversation: only the agent's answers, never search cards (BR-6).
 * A cited text opens beside the answer (the page's 460 panel) or, on a phone, in a reading
 * sheet of 85% with a tab per source, the answer still under it (KBC-127 FR-1, FR-2).
 */
@Component({
  selector: 'app-research-thread',
  imports: [ResearchMessage, DocumentPanel, UiIcon],
  template: `
    @for (turn of turns(); track turn.id) {
      <app-research-message
        [turn]="turn"
        [last]="$last"
        [activeSource]="activeSources().get(turn.id) ?? null"
        (opened)="openSource(turn, $event)"
        (trackOpened)="trackOpened.emit($event)"
        (stopped)="stopped.emit()"
        (retried)="retried.emit()"
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
              @for (source of open.opening.sources; track source.n) {
                <button
                  type="button"
                  role="tab"
                  class="tab"
                  [attr.aria-selected]="source.n === open.current.n"
                  [attr.aria-controls]="'reading-source'"
                  (click)="choose(source)"
                  i18n="@@source.tab"
                >
                  Fonte {{ source.n }}
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
          </div>
        </div>
        <app-document-panel
          id="reading-source"
          role="tabpanel"
          class="sheet-reader"
          [topic]="topic()"
          [documentId]="open.current.id"
          [fallbackTitle]="open.current.title"
          [highlight]="open.opening.question"
          [inSheet]="true"
          [sourceMode]="true"
          (closed)="closeSheet()"
          (documentOpened)="openDocument(open.current)"
          (navigated)="openDocument($event)"
          (trackOpened)="trackOpened.emit($event)"
        />
      }
    </dialog>
  `,
  styleUrl: './research-thread.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResearchThread {
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly injector = inject(Injector);
  private readonly chat = inject(ChatStore);
  private readonly sheet =
    viewChild.required<ElementRef<HTMLDialogElement>>('sheet');

  readonly turns = input.required<readonly ResearchTurn[]>();
  /** The document open in the page's panel: its source is marked in its answer. */
  readonly openDocumentId = input<string | null>(null);
  readonly opened = output<SourceOpening>();
  readonly trackOpened = output<TrackOpening>();
  readonly stopped = output();
  readonly retried = output();
  /** "Continuar varredura" on the last turn (KBC-030). */
  readonly continued = output();

  protected readonly topic = computed(() => this.chat.topicSlug() ?? '');
  protected readonly reading = signal<Reading | null>(null);
  protected readonly full = signal(false);
  private readonly drag = signal<{ start: number; now: number } | null>(null);
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

  /** The source marked in each answer: the one open in the sheet or in the page's panel. */
  protected readonly activeSources = computed(() => {
    const reading = this.reading();
    const id = this.openDocumentId();
    return new Map(
      this.turns().map((turn) => {
        if (reading)
          return [
            turn.id,
            reading.opening.question === turn.question
              ? reading.current.n
              : null,
          ];
        const open = turn.sources.find((source) => source.id === id);
        return [turn.id, open?.n ?? null];
      }),
    );
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
    const current = sources.find((source) => source.id === opened.id);
    if (!current || !this.isPhone()) {
      this.opened.emit(opening);
      return;
    }
    this.reading.set({ opening, current });
    this.full.set(false);
    afterNextRender(() => this.sheet().nativeElement.showModal(), {
      injector: this.injector,
    });
  }

  protected choose(source: CitedSource): void {
    this.reading.update((open) => open && { ...open, current: source });
  }

  /** "Abrir documento" or a related one: the page's document, out of the sheet. */
  protected openDocument(doc: DocumentRef): void {
    const reading = this.reading();
    this.closeSheet();
    if (!reading) return;
    this.chat.openSource(this.topic(), doc, {
      question: reading.opening.question,
      sources: [],
    });
    this.chat.leaveSources();
  }

  protected closeSheet(): void {
    this.sheet().nativeElement.close();
  }

  /** Native "close" (Escape, ✕, drag or backdrop): back to the citation that opened it. */
  protected sheetClosed(): void {
    const trigger = this.reading()?.opening.trigger ?? null;
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

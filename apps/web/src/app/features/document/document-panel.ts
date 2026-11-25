import { NgTemplateOutlet } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  documentSchema,
  type DocumentRef,
  type KbDocument,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { documentUrl } from '@core/api/kb-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import { injectAuthorshipLabels } from '@features/authorship/authorship-labels.js';
import type { CitedSource } from '@features/chat/chat-store.js';
import { RemoveDocumentDialog } from '@features/document-removals/remove-document-dialog.js';
import {
  UiBanner,
  UiButton,
  UiChip,
  UiCover,
  UiEmptyState,
  UiIcon,
  UiIconButton,
  UiMenu,
  UiMenuItem,
} from '@ui/index.js';
import { describeFacets } from '@core/i18n/facet-labels.js';
import { coverGradient } from '@ui/cover.js';
import {
  sectionIndex,
  splitIntoChunks,
  type SectionLink,
} from '@core/markdown/chunks.js';
import {
  countTerms,
  highlightTerms,
  markTerms,
} from '@core/markdown/highlight.js';
import { headingId, renderMarkdown } from '@core/markdown/render-markdown.js';
import type { TrackOpening } from '@features/research/track-opening.js';
import { DocumentLevel } from './document-level.js';
import { SeeAlsoSection } from './see-also.js';

const FEEDBACK_MS = 2000;

const countMarks = (html: string): number => html.split('<mark>').length - 1;

/**
 * A subject's text without a first heading that only repeats its name: the page head says it
 * already (chat-document-see-also, a stub subject is just "# Cabala").
 */
export function withoutTitleHeading(body: string, title: string): string {
  const fold = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
  const match = /^\s*#{1,6}[ \t]+([^\n]*)\n?/.exec(body);
  return match && fold(match[1] ?? '') === fold(title)
    ? body.slice(match[0].length)
    : body;
}

const foldText = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The share button's name by what its last tap did. */
const SHARE_LABELS: Record<'idle' | 'copied' | 'failed', () => string> = {
  idle: () => $localize`:@@panel.share:Compartilhar`,
  copied: () => $localize`:@@panel.shareCopied:Título e resumo copiados`,
  failed: () => $localize`:@@panel.shareFailed:Não consegui compartilhar`,
};

/** Index of the first chunk containing a term, or -1. */
function firstChunkWith(
  chunks: readonly string[],
  terms: readonly string[],
): number {
  if (terms.length === 0) return -1;
  return chunks.findIndex((chunk) => {
    const folded = foldText(chunk);
    return terms.some((term) => folded.includes(term));
  });
}
const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td';

type CopyState = 'idle' | 'copied' | 'failed';

/** Each panel's own ids: the page's panel and the phone's reading sheet may both exist. */
let nextPanel = 0;

/**
 * Reads one document beside the conversation (desktop) or full screen (mobile) — screens.md
 * T3. v2 (KBC-127): the document as a page (cover, the facets over the title, "Perguntar à
 * IA", the occurrences "1 de N" and "Sobre este documento"), and a source of an AI answer
 * with "Fonte ‹ ›", "Abrir documento", "Copiar trecho" and "Próximo trecho" (FR-1); also
 * inside the phone's reading sheet (FR-2). "Tela cheia" spreads it over the window.
 */
@Component({
  selector: 'app-document-panel',
  imports: [
    NgTemplateOutlet,
    RemoveDocumentDialog,
    SeeAlsoSection,
    AuthorshipBadge,
    DocumentLevel,
    UiBanner,
    UiButton,
    UiChip,
    UiCover,
    UiEmptyState,
    UiIcon,
    UiIconButton,
    UiMenu,
    UiMenuItem,
  ],
  templateUrl: './document-panel.html',
  styleUrl: './document-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.role]': 'inSheet() ? "tabpanel" : "dialog"',
    '[attr.aria-modal]': 'inSheet() ? null : "false"',
    '[attr.aria-labelledby]': 'labelledBy() ?? titleId',
    '[class.full]': 'full()',
    '[class.in-sheet]': 'inSheet()',
    '[class.page-mode]': 'page()',
    '[class.source-mode]': 'inSource()',
    '[class.subject]': 'subject()',
    '[class.failed-doc]': '!!document.error()',
    '[class.phone]': 'phone()',
    '[class.tools-stuck]': 'toolsStuck()',
    '(scroll)': 'readerScrolled($event)',
    '[style.--doc-tint]': 'tint()',
    '(keydown.escape)': 'closed.emit()',
  },
})
export class DocumentPanel {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly clipboard =
    inject(DOCUMENT).defaultView?.navigator.clipboard;
  private readonly navigator = inject(DOCUMENT).defaultView?.navigator;
  private readonly heading =
    viewChild.required<ElementRef<HTMLHeadingElement>>('heading');
  private readonly bodyRef = viewChild<ElementRef<HTMLElement>>('body');
  private readonly removal = viewChild<RemoveDocumentDialog>('removal');
  private readonly session = inject(SessionStore);

  readonly topic = input.required<string>();
  readonly documentId = input.required<string>();
  readonly fallbackTitle = input('');
  /** The question that led here; its words are highlighted in the text (KBC-003 FR-1). */
  readonly highlight = input<string | null>(null);
  readonly canGoBack = input(false);
  /** The text sources of the AI answer that opened it, for "Fonte ‹ ›" (KBC-127 FR-1). */
  readonly sources = input<readonly CitedSource[]>([]);
  /** The near-identical copies the search grouped with this document ("Cópias"). */
  readonly copies = input<readonly DocumentRef[]>([]);
  /** Inside the phone's reading sheet: its tabs and handle replace "Fonte ‹ ›" and ✕. */
  readonly inSheet = input(false);
  /** A phone's screen (cmDoc): "1 de 2 ⌃ ⌄" sits in the hero, not among the tools. */
  readonly phone = input(false);
  /** The element that names it instead of its title (the selected tab of a reading sheet). */
  readonly labelledBy = input<string | null>(null);
  /** False while the reader moves between a sheet's tabs: the focus stays on the tab. */
  readonly focusTitle = input(true);
  /** A source of an answer, also without its list (the sheet): "Abrir documento". */
  readonly sourceMode = input(false);
  /**
   * The document page of the search on desktop (chat-document): the page fills the main
   * panel and "Sobre este documento" is the right panel; ✕ sits at the end of the tools.
   */
  readonly page = input(false);
  /** "Perguntar à IA" only where the research view is available. */
  readonly canAskAi = input(false);
  readonly closed = output();
  readonly sourceChosen = output<CitedSource>();
  readonly documentOpened = output();
  /** "Perguntar à IA": the document's title, for the question to start from. */
  readonly askedAi = output<string>();
  readonly back = output();
  readonly navigated = output<DocumentRef>();
  /** A track linked in "Veja também" opens the T22 panel (KBC-101 AC-7). */
  readonly trackOpened = output<TrackOpening>();
  readonly conceptSelected = output<string>();
  /** The collection's name, for what is asked about leaving it (KBC-187). */
  readonly collectionTitle = input('');
  /** It left the collection: there is nothing to read here any more. */
  readonly removed = output();

  protected readonly document = httpResource(
    () => documentUrl(this.topic(), this.documentId()),
    {
      parse: (body) => documentSchema.parse(body),
    },
  );
  /** "Ver original" (KBC-148): the API streams it with the session cookie. */
  protected readonly originalUrl = computed(
    () => `${documentUrl(this.topic(), this.documentId())}/original`,
  );
  // A resource in error throws on value(); every read goes through this guard.
  protected readonly loaded = computed(() =>
    this.document.hasValue() ? this.document.value() : null,
  );
  protected readonly title = computed(
    () => this.loaded()?.title ?? this.fallbackTitle(),
  );
  /** A subject's synthesis (a concept's article): its shelves instead of "Sobre este documento". */
  protected readonly subject = computed(() => !!this.loaded()?.concept);
  /** Masters, and what was put in the collection: kb's own pages come from the documents. */
  protected readonly canRemove = computed(
    () => this.session.isMaster() && !this.subject() && !this.inSource(),
  );
  /** The document whose removal is asked: the dialog is there once it is. */
  protected readonly removing = signal<KbDocument | null>(null);
  protected readonly facets = computed(() => {
    const doc = this.loaded();
    return doc ? describeFacets(doc) : '';
  });
  protected readonly titleId = `document-title-${nextPanel++}`;
  /**
   * The page head's colour: the cover's (v2 pageHeader tint); a neutral one while it loads or
   * fails, when there is no cover yet (chat-document-loading, chat-document-error).
   */
  protected readonly tint = computed(() =>
    this.loaded() ? coverGradient(this.title())[0] : 'var(--tint-search)',
  );
  protected readonly full = linkedSignal({
    source: this.inSheet,
    computation: () => false,
  });
  protected readonly inSource = computed(
    () => this.sourceMode() || this.sources().length > 0,
  );
  /** "Fonte 2 de 4" and the source's [n], when the answer's list came along. */
  protected readonly sourceNav = computed(() => {
    const sources = this.sources();
    const at = sources.findIndex((one) => one.id === this.documentId());
    const source = sources[at];
    if (this.inSheet() || !source) return null;
    return { position: at + 1, total: sources.length, n: source.n };
  });
  protected readonly heroOccurrences = computed(
    () =>
      this.phone() && this.matches() > 0 && !this.inSheet() && !this.inSource(),
  );
  protected readonly nextLabel = computed(() =>
    this.inSource()
      ? $localize`:@@source.nextPassage:Próximo trecho`
      : $localize`:@@panel.next:Próxima ocorrência`,
  );
  protected readonly conceptLine = computed(() =>
    (this.loaded()?.concepts ?? []).join(' · '),
  );
  protected readonly labels = injectAuthorshipLabels();
  /** "OA" for "Outros autores", "ML" for "Mestre Laércio": the first letters of two words. */
  protected readonly authorInitials = computed(() =>
    this.labels()
      [this.loaded()?.authorship ?? 'outros-autores'].split(/\s+/)
      .filter((word) => /^\p{L}/u.test(word) && word.length > 2)
      .slice(0, 2)
      .map((word) => word.charAt(0).toUpperCase())
      .join(''),
  );
  protected readonly failedTitle = computed(
    () =>
      $localize`:@@panel.failedTitle:Não foi possível abrir “${this.title()}:title:”`,
  );
  protected readonly conceptButtons = computed(() =>
    (this.loaded()?.concepts ?? []).map((name) => ({
      name,
      label: $localize`:@@panel.filterByConcept:Filtrar a conversa por ${name}:concept:`,
    })),
  );

  private readonly terms = computed(() =>
    highlightTerms(this.highlight() ?? ''),
  );
  /** Long documents render a window of chunks to stay responsive (KBC-003). */
  private readonly chunks = computed(() => {
    const doc = this.loaded();
    const body = doc?.body ?? '';
    return splitIntoChunks(
      this.subject() && doc ? withoutTitleHeading(body, doc.title) : body,
    );
  });
  /** Each chunk is rendered and highlighted once per document (cache reset with the chunks). */
  private readonly chunkCache = computed(() => {
    this.chunks();
    this.terms();
    return new Map<number, string>();
  });
  /** Chunks on screen: starts at the one with the first occurrence and grows both ways. */
  protected readonly range = linkedSignal({
    source: this.chunks,
    computation: (chunks) => {
      const first = Math.max(0, firstChunkWith(chunks, this.terms()));
      return { start: first, end: first + 1 };
    },
  });
  protected readonly remainingPercent = computed(() =>
    this.percentOf(this.range().end, this.chunks().length),
  );
  protected readonly earlierPercent = computed(() =>
    this.percentOf(0, this.range().start),
  );
  protected readonly sections = computed(() =>
    this.chunks().length > 1 ? sectionIndex(this.chunks()) : [],
  );
  private readonly pendingSection = signal<{ id: string } | null>(null);

  protected readonly html = computed(() => {
    const { start, end } = this.range();
    return Array.from({ length: end - start }, (_, k) =>
      this.chunkHtml(start + k),
    ).join('');
  });
  /** Occurrences on screen and in the whole document (the counter shows both). */
  protected readonly matches = computed(() => countMarks(this.html()));
  protected readonly totalMatches = computed(() =>
    countTerms(this.loaded()?.body ?? '', this.terms()),
  );
  /** A source of an answer with none of the question's words: say so instead of marking. */
  protected readonly passageNotFound = computed(
    () =>
      this.inSource() && this.loaded() !== null && this.totalMatches() === 0,
  );
  /** Occurrence in focus; back to the first one on every new document. */
  protected readonly current = linkedSignal({
    source: this.documentId,
    computation: () => 0,
  });
  /** Bumped only when the reader moves between occurrences: reading more never scrolls back. */
  private readonly focusRequest = signal(0);
  protected readonly copyState = linkedSignal<string, CopyState>({
    source: this.documentId,
    computation: () => 'idle',
  });
  protected readonly errorText = computed(() => {
    const err = this.document.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });

  constructor() {
    // A new document starts at its top with focus on its title (also when switching in place).
    afterRenderEffect(() => {
      this.documentId();
      this.host.scrollTop = 0;
      if (untracked(this.focusTitle))
        this.heading().nativeElement.focus({ preventScroll: true });
    });
    // The occurrence in focus is outlined (DOM-only work).
    afterRenderEffect(() => {
      const current = this.current();
      this.marks().forEach((mark, index) =>
        mark.classList.toggle('current', index === current),
      );
    });
    // Scrolled into view when a document arrives and on ▲▼ only (never on "Continuar lendo").
    // On arrival the page stays at its top while the mark is already in sight (chat-document:
    // the cover, the tools and the first mark on one screen); ▲▼ centre it.
    let arrived: unknown = null;
    afterRenderEffect(() => {
      const loaded = this.loaded();
      this.focusRequest();
      const block = loaded === arrived ? 'center' : 'nearest';
      arrived = loaded;
      untracked(() => this.marks()[this.current()]?.scrollIntoView({ block }));
    });
    // A section picked in the index scrolls into view once its chunk is rendered.
    afterRenderEffect(() => this.scrollToSection(this.pendingSection()));
  }

  /** "Fonte ‹ ›": the answer's previous or next text source, round the list. */
  protected moveSource(delta: 1 | -1): void {
    const sources = this.sources();
    const at = sources.findIndex((one) => one.id === this.documentId());
    const next = sources[(at + delta + sources.length) % sources.length];
    if (next) this.sourceChosen.emit(next);
  }

  /** ▼ past the last occurrence on screen reads on into the next chunk; otherwise it wraps. */
  protected step(delta: 1 | -1): void {
    const count = this.matches();
    if (count === 0) return;
    const next = this.current() + delta;
    if (next >= count && this.range().end < this.chunks().length) {
      this.readMore();
    } else {
      this.current.set((next + count) % count);
    }
    this.focusRequest.update((n) => n + 1);
  }

  protected readMore(): void {
    this.range.update(({ start, end }) => ({
      start,
      end: Math.min(end + 1, this.chunks().length),
    }));
  }

  /** Shows the chunk before the window; the occurrence in focus keeps its place. */
  protected readEarlier(): void {
    const { start, end } = this.range();
    if (start === 0) return;
    this.current.update(
      (index) => index + countMarks(this.chunkHtml(start - 1)),
    );
    this.range.set({ start: start - 1, end });
  }

  protected goToSection(section: SectionLink): void {
    this.range.update(({ start, end }) => ({
      start: Math.min(start, section.chunk),
      end: Math.max(end, section.chunk + 1),
    }));
    // A new object every time, so picking the same section again scrolls again.
    this.pendingSection.set({ id: headingId(section.title) });
  }

  /** ⋯ "Sobre este documento": where the text ends, its authorship, subjects and copies. */
  protected askRemoval(doc: KbDocument): void {
    this.removing.set(doc);
    afterNextRender(() => this.removal()?.open(), { injector: this.injector });
  }

  protected goToAbout(): void {
    const about = this.host.querySelector<HTMLElement>('.about');
    about?.scrollIntoView({ block: 'start' });
    about?.querySelector<HTMLElement>('.about-title')?.focus();
  }

  protected async copyPassage(): Promise<void> {
    const block = this.marks()[this.current()]?.closest(BLOCK_SELECTOR);
    const text = block?.textContent?.trim();
    if (!text || !this.clipboard) return this.flashCopy('failed');
    try {
      await this.clipboard.writeText(text);
      this.flashCopy('copied');
    } catch {
      this.flashCopy('failed');
    }
  }

  /**
   * The page's tools lie on its head (actionBar) and stay at its top once the text scrolls
   * under them ("Próxima ocorrência" always at hand): then they take the page's colour.
   */
  protected readonly toolsStuck = signal(false);
  private readonly dom = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  protected readonly readerScrolled = (event: Event): void => {
    const reader = event.target as HTMLElement;
    const tools = reader.querySelector<HTMLElement>('.actions');
    const top = reader.getBoundingClientRect().top;
    const stuck =
      !!tools &&
      reader.scrollTop > 0 &&
      tools.getBoundingClientRect().top <= top + 1;
    if (stuck === this.toolsStuck()) return;
    // The occurrences' pill changes place (phone): the focus follows it to its twin.
    const focused = this.dom.activeElement;
    const from = focused?.closest('.occurrences');
    this.toolsStuck.set(stuck);
    if (!from || !(focused instanceof HTMLElement)) return;
    const buttons = [...from.querySelectorAll('button')];
    const index = buttons.indexOf(focused as HTMLButtonElement);
    if (index < 0) return;
    // After the render that draws the pill in its other place.
    afterNextRender(
      () =>
        reader
          .querySelector(
            stuck ? '.occurrences.in-tools' : '.occurrences.in-hero',
          )
          ?.querySelectorAll<HTMLButtonElement>('button')
          [index]?.focus(),
      { injector: this.injector },
    );
  };

  /** Compartilhar (actionBar): the system's share sheet, or the title and summary copied. */
  private readonly shared = signal<'idle' | 'copied' | 'failed'>('idle');
  protected readonly shareLabel = computed(() => SHARE_LABELS[this.shared()]());

  protected async share(doc: {
    title: string;
    summary: string | null;
  }): Promise<void> {
    const text = [doc.title, doc.summary].filter(Boolean).join('\n\n');
    try {
      if (this.navigator?.share) {
        await this.navigator.share({ title: doc.title, text });
        return;
      }
      if (!this.clipboard) throw new Error('no clipboard');
      await this.clipboard.writeText(text);
      this.shared.set('copied');
    } catch (error) {
      // Closing the share sheet is no failure.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.shared.set('failed');
    }
    setTimeout(() => this.shared.set('idle'), FEEDBACK_MS);
  }

  private flashCopy(state: CopyState): void {
    this.copyState.set(state);
    setTimeout(() => this.copyState.set('idle'), FEEDBACK_MS);
  }

  private chunkHtml(index: number): string {
    const cache = this.chunkCache();
    let html = cache.get(index);
    if (html === undefined) {
      html = markTerms(
        renderMarkdown(this.chunks()[index] ?? ''),
        this.terms(),
      );
      cache.set(index, html);
    }
    return html;
  }

  /** Angular's sanitizer drops id attributes from [innerHTML]: headings are matched by text. */
  private scrollToSection(pending: { id: string } | null): void {
    if (!pending) return;
    const headings =
      this.bodyRef()?.nativeElement.querySelectorAll<HTMLElement>(
        'h3, h4, h5',
      ) ?? [];
    [...headings]
      .find((h) => headingId(h.innerHTML) === pending.id)
      ?.scrollIntoView({ block: 'start' });
  }

  private percentOf(from: number, to: number): number {
    const chunks = this.chunks();
    const total = chunks.join('').length || 1;
    return Math.round((chunks.slice(from, to).join('').length / total) * 100);
  }

  private marks(): HTMLElement[] {
    this.html();
    return [
      ...(this.bodyRef()?.nativeElement.querySelectorAll<HTMLElement>('mark') ??
        []),
    ];
  }
}

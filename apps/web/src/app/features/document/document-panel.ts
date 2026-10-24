import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
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
import { documentSchema, type DocumentRef } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { documentUrl } from '@core/api/kb-api.js';
import { describeFacets } from '@core/i18n/facet-labels.js';
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
import { SeeAlsoSection } from './see-also.js';

const FEEDBACK_MS = 2000;

const countMarks = (html: string): number => html.split('<mark>').length - 1;

const foldText = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

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

/** Reads one document beside the conversation (desktop) or full screen (mobile) — screens.md T3. */
@Component({
  selector: 'app-document-panel',
  imports: [SeeAlsoSection],
  templateUrl: './document-panel.html',
  styleUrl: './document-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'dialog',
    'aria-modal': 'false',
    '[attr.aria-labelledby]': '"document-title"',
    '(keydown.escape)': 'closed.emit()',
  },
})
export class DocumentPanel {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly clipboard =
    inject(DOCUMENT).defaultView?.navigator.clipboard;
  private readonly heading =
    viewChild.required<ElementRef<HTMLHeadingElement>>('heading');
  private readonly bodyRef = viewChild<ElementRef<HTMLElement>>('body');

  readonly topic = input.required<string>();
  readonly documentId = input.required<string>();
  readonly fallbackTitle = input('');
  /** The question that led here; its words are highlighted in the text (KBC-003 FR-1). */
  readonly highlight = input<string | null>(null);
  readonly canGoBack = input(false);
  readonly closed = output();
  readonly back = output();
  readonly navigated = output<DocumentRef>();
  readonly conceptSelected = output<string>();

  protected readonly document = httpResource(
    () => documentUrl(this.topic(), this.documentId()),
    {
      parse: (body) => documentSchema.parse(body),
    },
  );
  // A resource in error throws on value(); every read goes through this guard.
  protected readonly loaded = computed(() =>
    this.document.hasValue() ? this.document.value() : null,
  );
  protected readonly title = computed(
    () => this.loaded()?.title ?? this.fallbackTitle(),
  );
  protected readonly facets = computed(() => {
    const doc = this.loaded();
    return doc ? describeFacets(doc) : '';
  });
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
  private readonly chunks = computed(() =>
    splitIntoChunks(this.loaded()?.body ?? ''),
  );
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
    afterRenderEffect(() => {
      this.loaded();
      this.focusRequest();
      untracked(() =>
        this.marks()[this.current()]?.scrollIntoView({ block: 'center' }),
      );
    });
    // A section picked in the index scrolls into view once its chunk is rendered.
    afterRenderEffect(() => this.scrollToSection(this.pendingSection()));
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

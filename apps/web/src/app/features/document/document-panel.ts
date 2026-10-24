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
import { highlightTerms, markTerms } from '@core/markdown/highlight.js';
import { headingId, renderMarkdown } from '@core/markdown/render-markdown.js';
import { SeeAlsoSection } from './see-also.js';

const FEEDBACK_MS = 2000;

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
  /** Long documents render a chunk at a time ("Continuar lendo") to stay responsive. */
  private readonly chunks = computed(() =>
    splitIntoChunks(this.loaded()?.body ?? ''),
  );
  /** Rendered up to the chunk with the first occurrence, so the highlight is on screen. */
  protected readonly shownChunks = linkedSignal({
    source: this.chunks,
    computation: (chunks) =>
      1 + Math.max(0, firstChunkWith(chunks, this.terms())),
  });
  protected readonly remainingPercent = computed(() => {
    const chunks = this.chunks();
    const shown = chunks.slice(0, this.shownChunks()).join('').length;
    const total = chunks.join('').length || 1;
    return Math.round(((total - shown) / total) * 100);
  });
  protected readonly sections = computed(() =>
    this.chunks().length > 1 ? sectionIndex(this.chunks()) : [],
  );
  private readonly pendingSection = signal<string | null>(null);

  protected readonly html = computed(() =>
    markTerms(
      renderMarkdown(this.chunks().slice(0, this.shownChunks()).join('\n\n')),
      this.terms(),
    ),
  );
  protected readonly matches = computed(
    () => this.html().split('<mark>').length - 1,
  );
  /** Occurrence in focus; back to the first one on every new document. */
  protected readonly current = linkedSignal({
    source: this.documentId,
    computation: () => 0,
  });
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
    // The occurrence in focus is outlined and scrolled into view (DOM-only work).
    afterRenderEffect(() => {
      const marks = this.marks();
      marks.forEach((mark, index) =>
        mark.classList.toggle('current', index === this.current()),
      );
      marks[this.current()]?.scrollIntoView({ block: 'center' });
    });
    // A section picked in the index scrolls into view once its chunk is rendered.
    afterRenderEffect(() => {
      const id = this.pendingSection();
      if (!id) return;
      // Angular's sanitizer drops id attributes from [innerHTML]: match headings by their text.
      const headings =
        this.bodyRef()?.nativeElement.querySelectorAll<HTMLElement>(
          'h3, h4, h5',
        ) ?? [];
      [...headings]
        .find((h) => headingId(h.innerHTML) === id)
        ?.scrollIntoView({ block: 'start' });
    });
  }

  protected step(delta: 1 | -1): void {
    const count = this.matches();
    if (count > 0)
      this.current.update((index) => (index + delta + count) % count);
  }

  protected readMore(): void {
    this.shownChunks.update((shown) =>
      Math.min(shown + 1, this.chunks().length),
    );
  }

  protected goToSection(section: SectionLink): void {
    this.shownChunks.update((shown) => Math.max(shown, section.chunk + 1));
    this.pendingSection.set(headingId(section.title));
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

  private marks(): HTMLElement[] {
    this.html();
    return [
      ...(this.bodyRef()?.nativeElement.querySelectorAll<HTMLElement>('mark') ??
        []),
    ];
  }
}

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
import { highlightTerms, markTerms } from '@core/markdown/highlight.js';
import { renderMarkdown } from '@core/markdown/render-markdown.js';
import { SeeAlsoSection } from './see-also.js';

const COPIED_FEEDBACK_MS = 2000;
const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td';

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
  private readonly terms = computed(() =>
    highlightTerms(this.highlight() ?? ''),
  );
  protected readonly html = computed(() =>
    renderMarkdown(markTerms(this.loaded()?.body ?? '', this.terms())),
  );
  protected readonly matches = computed(
    () => this.html().split('<mark>').length - 1,
  );
  /** Occurrence in focus; back to the first one on every new document. */
  protected readonly current = linkedSignal({
    source: this.html,
    computation: () => 0,
  });
  protected readonly copied = signal(false);
  protected readonly conceptButtons = computed(() =>
    (this.loaded()?.concepts ?? []).map((name) => ({
      name,
      label: $localize`:@@panel.filterByConcept:Filtrar a conversa por ${name}:concept:`,
    })),
  );
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
  }

  protected step(delta: 1 | -1): void {
    const count = this.matches();
    if (count > 0)
      this.current.update((index) => (index + delta + count) % count);
  }

  protected async copyPassage(): Promise<void> {
    const mark = this.marks()[this.current()];
    const block =
      mark?.closest(BLOCK_SELECTOR) ??
      this.bodyRef()?.nativeElement.querySelector(BLOCK_SELECTOR);
    const text = block?.textContent?.trim();
    if (!text || !this.clipboard) return;
    await this.clipboard.writeText(text);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), COPIED_FEEDBACK_MS);
  }

  private marks(): HTMLElement[] {
    this.html();
    return [
      ...(this.bodyRef()?.nativeElement.querySelectorAll<HTMLElement>('mark') ??
        []),
    ];
  }
}

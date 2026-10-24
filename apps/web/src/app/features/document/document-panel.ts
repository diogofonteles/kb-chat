import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { documentSchema } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { documentUrl } from '@core/api/kb-api.js';
import { describeFacets } from '@core/i18n/facet-labels.js';
import { renderMarkdown } from '@core/markdown/render-markdown.js';

/** Reads one document beside the conversation (desktop) or full screen (mobile) — screens.md T3. */
@Component({
  selector: 'app-document-panel',
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
  readonly topic = input.required<string>();
  readonly documentId = input.required<string>();
  readonly fallbackTitle = input('');
  readonly closed = output();

  private readonly heading =
    viewChild.required<ElementRef<HTMLHeadingElement>>('heading');

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
  protected readonly html = computed(() =>
    renderMarkdown(this.loaded()?.body ?? ''),
  );
  protected readonly errorText = computed(() => {
    const err = this.document.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });

  constructor() {
    afterNextRender(() => this.heading().nativeElement.focus());
  }
}

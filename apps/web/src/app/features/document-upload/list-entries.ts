import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import {
  recordingEntryListSchema,
  type RecordingEntry,
} from '@kb-chat/contracts';
import { listEntriesUrl } from '@core/documents/document-uploads-api.js';
import { UiBanner, UiButton } from '@ui/index.js';
import { RecordingChooser } from './recording-chooser.js';

/** What a channel or playlist holds, read when its row is shown: thousands are not in the list. */
@Component({
  selector: 'app-list-entries',
  imports: [RecordingChooser, UiBanner, UiButton],
  template: `
    <!-- The button pressed goes away, then what was said of it: the focus stays here. -->
    <div #box tabindex="-1" class="box">
      @if (entries(); as found) {
        <app-recording-chooser
          [entries]="found"
          [disabled]="disabled()"
          (picked)="picked.emit($event)"
        />
      } @else if (failed()) {
        <ui-banner
          tone="warn"
          title="Não consegui ler a lista"
          i18n-title="@@chooser.failed"
          role="alert"
        >
          <button
            uiBannerAction
            uiButton="white"
            size="sm"
            type="button"
            class="again"
            (click)="again()"
          >
            <span i18n="@@chooser.again">Tentar de novo</span>
          </button>
        </ui-banner>
      } @else {
        <p class="loading" role="status" i18n="@@chooser.loading">
          Lendo a lista…
        </p>
      }
    </div>
  `,
  styles: `
    .box:focus {
      outline: none;
    }

    .loading {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }

    .again {
      min-height: 2.75rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ListEntries {
  readonly listId = input.required<string>();
  readonly disabled = input(false);
  readonly picked = output<readonly string[]>();

  protected readonly held = httpResource(() => listEntriesUrl(this.listId()), {
    parse: (body) => onceEach(recordingEntryListSchema.parse(body).entries),
  });
  protected readonly entries = computed(() =>
    this.held.hasValue() ? this.held.value() : null,
  );
  protected readonly failed = computed(() => this.held.error() !== undefined);
  private readonly box = viewChild.required<ElementRef<HTMLElement>>('box');

  protected again(): void {
    this.box().nativeElement.focus({ preventScroll: true });
    this.held.reload();
  }
}

/** A playlist may have the same recording twice: it enters once. */
const onceEach = (entries: readonly RecordingEntry[]): RecordingEntry[] => [
  ...new Map(entries.map((one) => [one.url, one])).values(),
];

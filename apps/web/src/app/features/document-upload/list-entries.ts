import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { recordingEntryListSchema } from '@kb-chat/contracts';
import { listEntriesUrl } from '@core/documents/document-uploads-api.js';
import { UiBanner, UiButton } from '@ui/index.js';
import { RecordingChooser } from './recording-chooser.js';

/** What a channel or playlist holds, read when its row is shown: thousands are not in the list. */
@Component({
  selector: 'app-list-entries',
  imports: [RecordingChooser, UiBanner, UiButton],
  template: `
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
          (click)="held.reload()"
        >
          <span i18n="@@chooser.again">Tentar de novo</span>
        </button>
      </ui-banner>
    } @else {
      <p class="loading" role="status" i18n="@@chooser.loading">
        Lendo a lista…
      </p>
    }
  `,
  styles: `
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
    parse: (body) => recordingEntryListSchema.parse(body).entries,
  });
  protected readonly entries = computed(() =>
    this.held.hasValue() ? this.held.value() : null,
  );
  protected readonly failed = computed(() => this.held.error() !== undefined);
}

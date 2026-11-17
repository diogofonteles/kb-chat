import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { UiButton, UiIcon, UiPill } from '@ui/index.js';
import type { OpenedDocument } from './document-upload-dialog.js';
import { DocumentUploadsStore } from './document-uploads-store.js';
import { FAILURE_TEXTS, STATE_LABELS, WAITING_HINTS } from './upload-labels.js';

/**
 * "Documentos em processamento" (KBC-149 FR-2), in the Fila de processamento: each sent
 * document or link with its state in words, why it failed, and its link once ready.
 */
@Component({
  selector: 'app-document-uploads-section',
  imports: [UiButton, UiIcon, UiPill],
  template: `
    @if (rows().length > 0) {
      <section class="group" aria-labelledby="doc-uploads-title">
        <h3 id="doc-uploads-title" i18n="@@docUploads.title">
          Documentos em processamento
        </h3>
        <ul class="rows">
          @for (row of rows(); track row.upload.id) {
            <li class="row">
              <span class="art" aria-hidden="true">
                <ui-icon [name]="row.icon" [size]="20" />
              </span>
              <div class="text">
                <p class="name">{{ row.upload.name }}</p>
                <p class="meta">{{ row.topicTitle }}</p>
                @if (row.failure) {
                  <p class="why">{{ row.failure }}</p>
                } @else if (row.hint) {
                  <p class="hint">{{ row.hint }}</p>
                }
                @if (row.upload.detail) {
                  <p class="detail">{{ row.upload.detail }}</p>
                }
              </div>
              <ui-pill [tone]="row.tone">{{ row.state }}</ui-pill>
              @if (
                row.upload.state === 'ready' && row.upload.document;
                as doc
              ) {
                <button
                  uiButton="outline"
                  size="sm"
                  type="button"
                  (click)="open(row.upload.topic, doc)"
                >
                  <span i18n="@@docUploads.open">Abrir</span>
                </button>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
  styleUrl: './document-uploads-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentUploadsSection {
  private readonly store = inject(DocumentUploadsStore);
  /** Collection names by slug, for the line under each name. */
  readonly titles = input<ReadonlyMap<string, string>>(new Map());
  readonly documentOpened = output<OpenedDocument>();

  protected readonly rows = computed(() =>
    this.store.items().map((upload) => {
      const label = STATE_LABELS[upload.state];
      return {
        upload,
        state: label.text(),
        tone: label.tone,
        icon: upload.kind === 'file' ? ('file' as const) : ('link' as const),
        topicTitle: this.titles().get(upload.topic) ?? upload.topic,
        failure: upload.failure ? FAILURE_TEXTS[upload.failure]() : '',
        hint: WAITING_HINTS[upload.state]?.() ?? '',
      };
    }),
  );
  protected open(topic: string, doc: { id: string; title: string }): void {
    this.documentOpened.emit({ topic, ...doc });
  }
}

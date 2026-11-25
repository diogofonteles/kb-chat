import { formatNumber } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  DOCUMENT_BATCH_MAX_USD,
  type DocumentUpload,
} from '@kb-chat/contracts';
import { UiBanner, UiButton, UiIcon, UiIconButton, UiPill } from '@ui/index.js';
import { DocumentUploadsStore } from './document-uploads-store.js';
import { RecordingChooser } from './recording-chooser.js';
import {
  FAILURE_TEXTS,
  STATE_LABELS,
  hintOf,
  isWorking,
} from './upload-labels.js';

const ICONS = {
  file: 'file',
  url: 'link',
  recording: 'music',
  list: 'list',
} as const;

/** Rows shown before "Ver os outros". */
const FIRST_ROWS = 30;

/** A document opened from the list. */
export interface OpenedDocument {
  readonly topic: string;
  readonly id: string;
  readonly title: string;
}

/**
 * "Documentos em processamento" (KBC-149 FR-2), in the Fila de processamento and in
 * "Adicionar conteúdo" (there, only of the chosen collection): each sent document or link
 * with its state in words, why it failed or waits, what can be done, and its link once ready.
 */
@Component({
  selector: 'app-document-uploads-section',
  imports: [RecordingChooser, UiBanner, UiButton, UiIcon, UiIconButton, UiPill],
  template: `
    @if (rows().length > 0) {
      <section class="group" aria-labelledby="doc-uploads-title">
        <h3 id="doc-uploads-title" i18n="@@docUploads.title">
          Documentos em processamento
        </h3>
        @if (store.actionError(); as error) {
          <ui-banner
            tone="err"
            title="Não consegui fazer isso"
            i18n-title="@@docUploads.actionFailed"
            role="alert"
          >
            {{ error }}
          </ui-banner>
        }
        <ul class="rows">
          @for (row of shown(); track row.upload.id) {
            <li class="row">
              <span class="art" aria-hidden="true">
                <ui-icon [name]="row.icon" [size]="20" />
              </span>
              <div class="text">
                <p class="name">{{ row.upload.name }}</p>
                @if (row.topicTitle) {
                  <p class="meta">{{ row.topicTitle }}</p>
                }
                @if (row.failure) {
                  <p class="why">{{ row.failure }}</p>
                } @else if (row.held) {
                  <p class="why">{{ row.held }}</p>
                } @else if (row.hint) {
                  <p class="hint">{{ row.hint }}</p>
                }
                @if (row.upload.detail) {
                  <p class="detail">{{ row.upload.detail }}</p>
                }
              </div>
              <ui-pill [tone]="row.tone">{{ row.state }}</ui-pill>
              <div class="actions">
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
                @if (row.canRaise) {
                  <button
                    uiButton="outline"
                    size="sm"
                    type="button"
                    [disabled]="store.busyId() !== null"
                    (click)="store.raise(row.upload)"
                  >
                    <span i18n="@@docUploads.raise"
                      >Aumentar o teto em US$ 0,50</span
                    >
                  </button>
                }
                @if (row.canRetry) {
                  <button
                    uiButton="outline"
                    size="sm"
                    type="button"
                    [disabled]="store.busyId() !== null"
                    (click)="store.retry(row.upload)"
                  >
                    <span i18n="@@docUploads.retry">Tentar de novo</span>
                  </button>
                }
                @if (row.canRemove) {
                  <button
                    uiIconButton
                    class="remove"
                    type="button"
                    [size]="44"
                    [attr.aria-label]="row.removeLabel"
                    [disabled]="store.busyId() !== null"
                    (click)="store.remove(row.upload)"
                  >
                    <ui-icon name="close" [size]="18" />
                  </button>
                }
              </div>
              @if (row.upload.entries.length > 0) {
                <app-recording-chooser
                  class="chooser"
                  [entries]="row.upload.entries"
                  [disabled]="store.busyId() !== null"
                  (picked)="store.choose(row.upload, $event)"
                />
              }
            </li>
          }
        </ul>
        @if (hidden() > 0 || all()) {
          <button
            uiButton="ghost"
            size="sm"
            type="button"
            class="more"
            [attr.aria-expanded]="all()"
            (click)="all.set(!all())"
          >
            @if (all()) {
              <span i18n="@@docUploads.fewer">Mostrar menos</span>
            } @else {
              <span i18n="@@docUploads.others"
                >Ver os outros {{ hidden() }}</span
              >
            }
          </button>
        }
      </section>
    }
  `,
  styleUrl: './document-uploads-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentUploadsSection {
  private readonly locale = inject(LOCALE_ID);
  protected readonly store = inject(DocumentUploadsStore);
  /** Only this collection's; null: every one, each with its collection's name. */
  readonly topic = input<string | null>(null);
  /** Collection names by slug, for the line under each name. */
  readonly titles = input<ReadonlyMap<string, string>>(new Map());
  readonly documentOpened = output<OpenedDocument>();

  protected readonly all = signal(false);
  protected readonly rows = computed(() => {
    const topic = this.topic();
    return this.store
      .items()
      .filter((upload) => topic === null || upload.topic === topic)
      .map((upload) => this.rowOf(upload, topic === null));
  });

  /** A folder sends hundreds: the first ones, and the rest one press away. */
  protected readonly shown = computed(() =>
    this.all() ? this.rows() : this.rows().slice(0, FIRST_ROWS),
  );
  protected readonly hidden = computed(
    () => this.rows().length - this.shown().length,
  );

  private rowOf(upload: DocumentUpload, namesTopic: boolean) {
    const label = STATE_LABELS[upload.state];
    return {
      upload,
      state: label.text(),
      tone: label.tone,
      icon: ICONS[upload.kind],
      topicTitle: namesTopic
        ? (this.titles().get(upload.topic) ?? upload.topic)
        : '',
      failure: upload.failure ? FAILURE_TEXTS[upload.failure]() : '',
      held: this.heldText(upload),
      hint: hintOf(upload),
      canRaise:
        upload.heldBy === 'batch-cap' &&
        upload.batch !== null &&
        upload.batch.capUsd < DOCUMENT_BATCH_MAX_USD,
      canRetry: upload.retriable,
      canRemove: !isWorking(upload.state),
      removeLabel: $localize`:@@docUploads.remove:Tirar ${upload.name}:name: da lista`,
    };
  }

  private heldText(upload: DocumentUpload): string {
    if (upload.heldBy === 'month-cap')
      return $localize`:@@docUploads.heldMonth:O teto de gasto do mês foi atingido. Continua quando o dono aumentar ou o mês virar.`;
    if (upload.heldBy !== 'batch-cap' || !upload.batch) return '';
    const cap = formatNumber(upload.batch.capUsd, this.locale, '1.2-2');
    return $localize`:@@docUploads.heldBatch:O teto desta inclusão (US$ ${cap}:cap:) foi atingido. Aumente para continuar.`;
  }

  protected open(topic: string, doc: { id: string; title: string }): void {
    this.documentOpened.emit({ topic, ...doc });
  }
}

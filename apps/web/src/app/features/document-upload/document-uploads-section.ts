import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { DocumentUpload } from '@kb-chat/contracts';
import { UiBanner, UiButton, UiChip } from '@ui/index.js';
import { phaseOf, type UploadPhase } from './document-progress.js';
import { DocumentUploadRow } from './document-upload-row.js';
import { DocumentUploadsStore } from './document-uploads-store.js';
import { DocumentWorkCard } from './document-work-card.js';

/** Rows shown before "Ver os outros". */
const FIRST_ROWS = 30;
/** Past this many, the list can be looked at by how each item stands. */
const FILTERS_FROM = 13;

/** What needs a look first; then the line, in its order; then what is done. */
const ORDER: Record<UploadPhase, number> = {
  active: 0,
  yours: 1,
  failed: 2,
  waiting: 3,
  ready: 4,
};

type Filter = UploadPhase | 'all';

const FILTERS: readonly {
  readonly filter: Filter;
  readonly label: (n: number) => string;
}[] = [
  {
    filter: 'all',
    label: (n) => $localize`:@@docProgress.filter.all:Todos (${n}:count:)`,
  },
  {
    filter: 'active',
    label: (n) =>
      $localize`:@@docProgress.filter.active:Em andamento (${n}:count:)`,
  },
  {
    filter: 'waiting',
    label: (n) =>
      $localize`:@@docProgress.filter.waiting:Na fila (${n}:count:)`,
  },
  {
    filter: 'yours',
    label: (n) =>
      $localize`:@@docProgress.filter.yours:Esperam você (${n}:count:)`,
  },
  {
    filter: 'failed',
    label: (n) =>
      $localize`:@@docProgress.filter.failed:Falharam (${n}:count:)`,
  },
  {
    filter: 'ready',
    label: (n) => $localize`:@@docProgress.filter.ready:Prontos (${n}:count:)`,
  },
];

/** A document opened from the list. */
export interface OpenedDocument {
  readonly topic: string;
  readonly id: string;
  readonly title: string;
}

interface Row {
  readonly upload: DocumentUpload;
  readonly phase: UploadPhase;
  readonly topicTitle: string;
}

/**
 * "Documentos em processamento" (KBC-149 FR-2, KBC-184), in the Fila de processamento and in
 * "Adicionar conteúdo" (there, only of the chosen collection): how everything stands, then each
 * sent document or link, its steps and what can be done about it.
 */
@Component({
  selector: 'app-document-uploads-section',
  imports: [DocumentUploadRow, DocumentWorkCard, UiBanner, UiButton, UiChip],
  template: `
    @if (rows().length > 0) {
      <section class="group" aria-labelledby="doc-uploads-title">
        <h3
          #title
          id="doc-uploads-title"
          tabindex="-1"
          i18n="@@docUploads.title"
        >
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
        <app-document-work-card
          [uploads]="uploads()"
          [work]="store.work()"
          [at]="store.now()"
        />
        @if (filters().length > 0) {
          <div
            class="filters"
            role="group"
            aria-label="Mostrar"
            i18n-aria-label="@@docProgress.filters"
          >
            @for (one of filters(); track one.filter) {
              <button
                uiChip
                type="button"
                [selected]="filter() === one.filter"
                (click)="filter.set(one.filter)"
              >
                {{ one.text }}
              </button>
            }
          </div>
        }
        <ul class="rows">
          @for (row of shown(); track row.upload.id) {
            <li>
              <app-document-upload-row
                [upload]="row.upload"
                [topicTitle]="row.topicTitle"
                [busy]="store.busyId() !== null"
                [at]="store.now()"
                (opened)="open(row.upload.topic, $event)"
                (raised)="store.raise(row.upload)"
                (retried)="store.retry(row.upload)"
                (removed)="store.remove(row.upload)"
                (chosen)="store.choose(row.upload, $event)"
              />
            </li>
          }
        </ul>
        @if (found().length === 0) {
          <p class="none" i18n="@@docProgress.none">Nenhum item assim agora.</p>
        }
        @if (hidden() > 0 || all() || ready() > 0) {
          <div class="foot">
            @if (hidden() > 0 || all()) {
              <button
                uiButton="ghost"
                size="sm"
                type="button"
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
            @if (ready() > 0) {
              <button
                uiButton="ghost"
                size="sm"
                type="button"
                [disabled]="store.busyId() !== null"
                (click)="clear()"
              >
                <span i18n="@@docProgress.clear"
                  >Limpar prontos ({{ ready() }})</span
                >
              </button>
            }
          </div>
        }
      </section>
    }
  `,
  styleUrl: './document-uploads-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentUploadsSection {
  protected readonly store = inject(DocumentUploadsStore);
  private readonly title = viewChild<ElementRef<HTMLElement>>('title');
  /** Only this collection's; null: every one, each with its collection's name. */
  readonly topic = input<string | null>(null);
  /** Collection names by slug, for the line under each name. */
  readonly titles = input<ReadonlyMap<string, string>>(new Map());
  readonly documentOpened = output<OpenedDocument>();

  protected readonly all = signal(false);
  protected readonly filter = signal<Filter>('all');
  protected readonly uploads = computed(() => {
    const topic = this.topic();
    return this.store
      .items()
      .filter((upload) => topic === null || upload.topic === topic);
  });
  protected readonly rows = computed<readonly Row[]>(() =>
    this.uploads()
      .map((upload) => ({
        upload,
        phase: phaseOf(upload),
        topicTitle: this.topicTitleOf(upload),
      }))
      .sort(byPhase),
  );
  /** Only once there is enough to look through; a way none is in is not offered. */
  protected readonly filters = computed(() => {
    const rows = this.rows();
    if (rows.length < FILTERS_FROM) return [];
    return FILTERS.map(({ filter, label }) => {
      const n = rows.filter((row) => matches(row, filter)).length;
      return { filter, n, text: label(n) };
    }).filter(({ filter, n }) => n > 0 || filter === this.filter());
  });
  protected readonly found = computed(() => {
    const filter = this.filters().length > 0 ? this.filter() : 'all';
    return this.rows().filter((row) => matches(row, filter));
  });
  /** A folder sends hundreds: the first ones, and the rest one press away. */
  protected readonly shown = computed(() =>
    this.all() ? this.found() : this.found().slice(0, FIRST_ROWS),
  );
  protected readonly hidden = computed(
    () => this.found().length - this.shown().length,
  );
  protected readonly ready = computed(
    () => this.rows().filter(({ phase }) => phase === 'ready').length,
  );

  private topicTitleOf({ topic }: DocumentUpload): string {
    return this.topic() === null ? (this.titles().get(topic) ?? topic) : '';
  }

  protected open(topic: string, doc: { id: string; title: string }): void {
    this.documentOpened.emit({ topic, ...doc });
  }

  /** The button goes away with what it clears: the focus stays in the section. */
  protected clear(): void {
    this.title()?.nativeElement.focus();
    this.store.clearReady(this.topic());
  }
}

const matches = ({ phase }: Row, filter: Filter): boolean =>
  filter === 'all' || phase === filter;

const placeOf = ({ upload }: Row): number =>
  upload.progress.position ?? Number.MAX_SAFE_INTEGER;

/** By how each stands; those in line, in the line's order; the rest as they came. */
const byPhase = (a: Row, b: Row): number =>
  ORDER[a.phase] - ORDER[b.phase] || placeOf(a) - placeOf(b);

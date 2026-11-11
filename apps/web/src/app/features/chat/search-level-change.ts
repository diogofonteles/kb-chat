import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  levelChoicesSchema,
  type BulkLevelResult,
  type DocumentKey,
  type LevelChoice,
  type SearchHit,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { LevelsApi, levelChoicesUrl } from '@core/levels/levels-api.js';
import { UnassignedCountsStore } from '@core/levels/unassigned-counts-store.js';
import { BulkLevelBar } from '@features/collections/bulk-level-bar.js';
import { finalize } from 'rxjs';

const keyOf = (hit: Pick<SearchHit, 'topic' | 'id'>): string =>
  `${hit.topic}\n${hit.id}`;

/**
 * "Mudar nível" over the documents of a search (KBC-107 scope): for masters and whoever
 * classifies content (the API sends a level on each hit only to them), the documents found
 * are chosen and moved to one level, up to the person's own, in one request.
 */
@Component({
  selector: 'app-search-level-change',
  imports: [BulkLevelBar],
  template: `
    @if (hits().length > 0) {
      <div class="change">
        <button
          type="button"
          class="secondary"
          [attr.aria-expanded]="open()"
          (click)="open.set(!open())"
          i18n="@@searchLevel.toggle"
        >
          Mudar nível
        </button>
        @if (open()) {
          <fieldset class="pick">
            <legend i18n="@@searchLevel.legend">Documentos desta busca</legend>
            <button type="button" class="link" (click)="toggleAll()">
              @if (allChosen()) {
                <ng-container i18n="@@searchLevel.none"
                  >Desmarcar todos</ng-container
                >
              } @else {
                <ng-container i18n="@@searchLevel.all"
                  >Selecionar os {{ hits().length }} documentos</ng-container
                >
              }
            </button>
            <ul>
              @for (hit of hits(); track keyOf(hit)) {
                <li>
                  <label>
                    <input
                      #box
                      type="checkbox"
                      [checked]="chosen().has(keyOf(hit))"
                      (change)="toggle(hit, box.checked)"
                    />
                    <span class="title">{{ hit.title }}</span>
                    <span class="level">{{ levelText(hit) }}</span>
                  </label>
                </li>
              }
            </ul>
          </fieldset>
          <app-bulk-level-bar
            [count]="chosen().size"
            [choices]="choices()"
            [busy]="busy()"
            [error]="failure()"
            [actionLabel]="actionLabel"
            (applied)="apply($event)"
          />
        }
        <p class="visually-hidden" aria-live="polite">{{ announcement() }}</p>
      </div>
    }
  `,
  styles: `
    .change {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
    }
    .pick {
      display: grid;
      gap: var(--space-2);
      justify-self: stretch;
      margin: 0;
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    legend {
      padding: 0 var(--space-1);
      font-weight: 600;
    }
    ul {
      display: grid;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    label {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      min-height: var(--target);
      cursor: pointer;
    }
    input {
      width: 1.5rem;
      height: 1.5rem;
      margin: 0;
    }
    .title {
      overflow-wrap: anywhere;
    }
    .level {
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    app-bulk-level-bar {
      justify-self: stretch;
    }
    button {
      min-height: var(--target);
      padding: 0 var(--space-4);
      border-radius: var(--radius-sm);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .secondary {
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
    }
    .link {
      padding: 0;
      border: none;
      background: none;
      color: var(--color-accent-strong);
      text-decoration: underline;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchLevelChange {
  private readonly api = inject(LevelsApi);
  /** Made on first use: a page that never gives a level never asks for the counts. */
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** The collection searched. */
  readonly topic = input.required<string>();
  /** The search's documents: those with a level sent are the ones the person may move. */
  readonly results = input.required<readonly SearchHit[]>();

  protected readonly keyOf = keyOf;
  protected readonly actionLabel = $localize`:@@searchLevel.apply:Mudar nível`;
  protected readonly open = signal(false);
  protected readonly hits = computed(() =>
    this.results().filter((hit) => hit.level !== undefined && !hit.media),
  );
  protected readonly chosen = linkedSignal<
    readonly SearchHit[],
    ReadonlySet<string>
  >({
    source: () => this.hits(),
    computation: () => new Set<string>(),
  });
  protected readonly allChosen = computed(
    () => this.hits().length > 0 && this.chosen().size === this.hits().length,
  );
  private readonly levels = httpResource(
    () => (this.open() ? levelChoicesUrl(this.topic()) : undefined),
    { parse: (body) => levelChoicesSchema.parse(body) },
  );
  protected readonly choices = computed<readonly LevelChoice[]>(() =>
    this.levels.hasValue() ? this.levels.value().levels : [],
  );
  /** Levels given here, over what the search sent. */
  private readonly given = signal<ReadonlyMap<string, LevelChoice>>(new Map());
  protected readonly busy = signal(false);
  protected readonly failure = signal('');
  protected readonly announcement = signal('');

  protected levelText(hit: SearchHit): string {
    const level = this.given().get(keyOf(hit)) ?? hit.level;
    return level
      ? $localize`:@@searchLevel.current:Nível: ${level.code}:code:`
      : $localize`:@@searchLevel.unassigned:Sem nível`;
  }

  protected toggle(hit: SearchHit, on: boolean): void {
    const next = new Set(this.chosen());
    if (on) next.add(keyOf(hit));
    else next.delete(keyOf(hit));
    this.chosen.set(next);
  }

  protected toggleAll(): void {
    this.chosen.set(
      this.allChosen() ? new Set() : new Set(this.hits().map(keyOf)),
    );
  }

  protected apply(level: LevelChoice): void {
    const ids = this.hits()
      .filter((hit) => this.chosen().has(keyOf(hit)))
      .map(({ topic, id }) => ({ topic, id }));
    if (ids.length === 0 || this.busy()) return;
    this.busy.set(true);
    this.failure.set('');
    this.api
      .setLevels(this.topic(), { level: level.id, ids })
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (result) => this.moved(ids, result),
        error: (err: unknown) =>
          this.failure.set(errorMessage(toUiErrorCode(err))),
      });
  }

  /** What the screen says after a change; only with nothing skipped is every chosen one known to have moved. */
  private moved(ids: readonly DocumentKey[], result: BulkLevelResult): void {
    if (result.skipped === 0) {
      const given = new Map(this.given());
      for (const id of ids) given.set(keyOf(id), result.level);
      this.given.set(given);
    }
    this.chosen.set(new Set());
    this.injector.get(UnassignedCountsStore).refresh();
    const { updated } = result;
    const code = result.level.code;
    this.announcement.set(
      updated === 1
        ? $localize`:@@searchLevel.doneOne:1 documento foi para ${code}:code:.`
        : $localize`:@@searchLevel.done:${updated}:count: documentos foram para ${code}:code:.`,
    );
  }
}

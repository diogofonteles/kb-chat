import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  authorshipSchema,
  unassignedOriginSchema,
  type Authorship,
  type BulkLevelRequest,
  type LevelChoice,
  type UnassignedDocument,
  type UnassignedFilter,
  type UnassignedOrigin,
  type UnassignedPage,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { authorshipLabelsOf } from '@core/i18n/facet-labels.js';
import { LevelsApi } from '@core/levels/levels-api.js';
import { UnassignedCountsStore } from '@core/levels/unassigned-counts-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { finalize, map } from 'rxjs';
import { BulkLevelBar } from './bulk-level-bar.js';

const PAGE = 10;

const ORIGIN_LABELS: Record<UnassignedOrigin, () => string> = {
  text: () => $localize`:@@unassigned.originText:Texto`,
  audio: () => $localize`:@@unassigned.originAudio:Áudio`,
  ocr: () => $localize`:@@unassigned.originOcr:OCR`,
};

const keyOf = (doc: Pick<UnassignedDocument, 'topic' | 'id'>): string =>
  `${doc.topic}\n${doc.id}`;

/** The filter fields, as the selects and the date hold them ('' = any). */
interface FilterForm {
  readonly collection: string;
  readonly origin: UnassignedOrigin | '';
  readonly authorship: Authorship | '';
  /** null: any folder ('' is the collection's root). */
  readonly folder: string | null;
  readonly since: string;
}

const NO_FILTERS: FilterForm = {
  collection: '',
  origin: '',
  authorship: '',
  folder: null,
  since: '',
};

/** A page of the queue and the filter it answers. */
interface Shown {
  readonly filter: UnassignedFilter;
  readonly page: UnassignedPage;
}

/** What the person picked: some rows, or every row the filters keep. */
type Selection =
  | { readonly kind: 'rows'; readonly keys: ReadonlySet<string> }
  | { readonly kind: 'filtered' };

const NOTHING: Selection = { kind: 'rows', keys: new Set() };

/** The filters the API takes, without the empty ones. */
const toFilter = (form: FilterForm): UnassignedFilter => ({
  ...(form.collection && { collection: form.collection }),
  ...(form.origin && { origin: form.origin }),
  ...(form.authorship && { authorship: form.authorship }),
  ...(form.folder !== null && { folder: form.folder }),
  ...(form.since && { since: form.since }),
});

/**
 * "Sem nível (N)" on T24 (KBC-107 FR-6): the documents that arrived from kb without a level,
 * filtered, a page at a time, chosen by row or as "os N filtrados", and given a level in one
 * request. Masters and holders of "Classificar nível de conteúdo" see it.
 */
@Component({
  selector: 'app-unassigned-section',
  imports: [BulkLevelBar, DatePipe],
  templateUrl: './unassigned-section.html',
  styleUrl: './unassigned-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnassignedSection {
  private readonly api = inject(LevelsApi);
  /** Made on first use: a page that never gives a level never asks for the counts. */
  private readonly injector = inject(Injector);
  private readonly chat = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly result = viewChild<ElementRef<HTMLElement>>('result');

  /** The collection whose queue this is (a top-level one). */
  readonly topic = input.required<string>();
  /** Told after levels were given, so the page reloads its counts. */
  readonly changed = output();

  protected readonly form = signal<FilterForm>(NO_FILTERS);
  private readonly filter = computed(() => toFilter(this.form()));
  protected readonly filtered = computed(
    () => Object.keys(this.filter()).length > 0,
  );
  /**
   * The first page with the filter that made it (R1-1): what is on screen, the bulk and
   * "Carregar mais" always go with the filter of the page they came from.
   */
  protected readonly first = rxResource({
    params: () => ({ topic: this.topic(), filter: this.filter() }),
    stream: ({ params }) =>
      this.api
        .unassigned(params.topic, { ...params.filter, limit: PAGE })
        .pipe(map((page): Shown => ({ filter: params.filter, page }))),
  });
  /** The last answer, kept while the next filter loads (no flash of the empty state). */
  private readonly shown = linkedSignal<Shown | null, Shown | null>({
    source: () => (this.first.hasValue() ? this.first.value() : null),
    computation: (next, previous) => next ?? previous?.value ?? null,
  });
  private readonly page = computed(() => this.shown()?.page ?? null);
  /** A new filter (or a reload) is on its way: nothing acts on the page being replaced. */
  protected readonly stale = computed(() => this.first.isLoading());
  protected readonly known = computed(() => this.shown() !== null);
  /** Pages after the first ("Carregar mais"); emptied with each first page. */
  private readonly more = linkedSignal<Shown | null, UnassignedPage[]>({
    source: () => this.shown(),
    computation: () => [],
  });
  protected readonly items = computed(() => [
    ...(this.page()?.items ?? []),
    ...this.more().flatMap((one) => one.items),
  ]);
  private readonly nextCursor = computed(() => {
    const more = this.more();
    return (more.at(-1) ?? this.page())?.nextCursor ?? null;
  });
  protected readonly hasMore = computed(() => this.nextCursor() !== null);
  protected readonly total = computed(() => this.page()?.total ?? 0);
  protected readonly matched = computed(() => this.page()?.matched ?? 0);
  protected readonly facets = computed(() => this.page()?.facets ?? null);
  protected readonly choices = computed<readonly LevelChoice[]>(
    () => this.page()?.levels ?? [],
  );

  protected readonly selection = linkedSignal<Shown | null, Selection>({
    source: () => this.shown(),
    computation: () => NOTHING,
  });
  protected readonly selectedCount = computed(() => {
    const selection = this.selection();
    return selection.kind === 'filtered' ? this.matched() : selection.keys.size;
  });
  protected readonly allFiltered = computed(
    () => this.selection().kind === 'filtered',
  );

  protected readonly loadingMore = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal('');
  protected readonly moreFailed = signal(false);
  protected readonly announcement = signal('');

  private readonly authorshipLabels = computed(() =>
    authorshipLabelsOf(this.chat.topic()?.mainAuthor?.name ?? null),
  );

  protected originLabel(origin: UnassignedOrigin): string {
    return ORIGIN_LABELS[origin]();
  }

  protected authorshipLabel(authorship: Authorship): string {
    return this.authorshipLabels()[authorship];
  }

  protected collectionLabel(slug: string): string {
    return (
      this.chat.topicList().find((one) => one.slug === slug)?.title ?? slug
    );
  }

  protected folderLabel(folder: string): string {
    return folder || $localize`:@@unassigned.rootFolder:(raiz)`;
  }

  protected selected(doc: UnassignedDocument): boolean {
    const selection = this.selection();
    return selection.kind === 'filtered' || selection.keys.has(keyOf(doc));
  }

  protected toggle(doc: UnassignedDocument, on: boolean): void {
    const current = this.selection();
    const keys = new Set(
      current.kind === 'filtered' ? this.items().map(keyOf) : current.keys,
    );
    if (on) keys.add(keyOf(doc));
    else keys.delete(keyOf(doc));
    this.selection.set({ kind: 'rows', keys });
  }

  protected toggleAll(): void {
    this.selection.set(this.allFiltered() ? NOTHING : { kind: 'filtered' });
  }

  protected setFilter(change: Partial<FilterForm>): void {
    this.form.update((form) => ({ ...form, ...change }));
  }

  /** The selects hand over text: only a value the API knows is kept. */
  protected setOrigin(value: string): void {
    const parsed = unassignedOriginSchema.safeParse(value);
    this.setFilter({ origin: parsed.success ? parsed.data : '' });
  }

  protected setAuthorship(value: string): void {
    const parsed = authorshipSchema.safeParse(value);
    this.setFilter({ authorship: parsed.success ? parsed.data : '' });
  }

  /** The folder select's "any" is its first option, apart from the root's ''. */
  protected setFolder(value: string, any: boolean): void {
    this.setFilter({ folder: any ? null : value });
  }

  protected clearFilters(): void {
    this.form.set(NO_FILTERS);
  }

  protected loadMore(): void {
    const cursor = this.nextCursor();
    const base = this.shown();
    if (!cursor || !base || this.loadingMore() || this.stale()) return;
    this.loadingMore.set(true);
    this.moreFailed.set(false);
    this.api
      .unassigned(this.topic(), { ...base.filter, cursor, limit: PAGE })
      .pipe(
        finalize(() => this.loadingMore.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        // A page of a list that has since been replaced is dropped (R1-1).
        next: (page) => {
          if (this.shown() === base)
            this.more.update((pages) => [...pages, page]);
        },
        error: () => this.moreFailed.set(true),
      });
  }

  /** One request for the whole choice; the selection stays when it fails (MA-26). */
  protected give(level: LevelChoice): void {
    const shown = this.shown();
    if (!shown || this.busy() || this.stale()) return;
    const body = this.requestFor(level, shown);
    if (!body) return;
    this.busy.set(true);
    this.failure.set('');
    this.api
      .setLevels(this.topic(), body)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (result) => {
          this.announcement.set(this.resultText(result));
          // R1-2: the focus goes to what happened, which stays when the bar goes.
          afterNextRender(() => this.result()?.nativeElement.focus(), {
            injector: this.injector,
          });
          this.first.reload();
          this.injector.get(UnassignedCountsStore).refresh();
          this.changed.emit();
        },
        error: (err: unknown) =>
          this.failure.set(errorMessage(toUiErrorCode(err))),
      });
  }

  private requestFor(
    level: LevelChoice,
    shown: Shown,
  ): BulkLevelRequest | null {
    const selection = this.selection();
    if (selection.kind === 'filtered')
      return {
        level: level.id,
        filter: { ...shown.filter, asOf: shown.page.asOf },
      };
    const ids = this.items()
      .filter((doc) => selection.keys.has(keyOf(doc)))
      .map(({ topic, id }) => ({ topic, id }));
    return ids.length > 0 ? { level: level.id, ids } : null;
  }

  private resultText(result: {
    readonly level: LevelChoice;
    readonly updated: number;
    readonly skipped: number;
  }): string {
    const { code } = result.level;
    const { updated, skipped } = result;
    const done =
      updated === 1
        ? $localize`:@@unassigned.doneOne:1 documento foi para ${code}:code:.`
        : $localize`:@@unassigned.done:${updated}:count: documentos foram para ${code}:code:.`;
    if (skipped === 0) return done;
    return `${done} ${$localize`:@@unassigned.skipped:${skipped}:count: não puderam ser classificados.`}`;
  }
}

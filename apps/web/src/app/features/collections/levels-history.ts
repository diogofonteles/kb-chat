import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  LEVEL_AUDIT_KINDS,
  type LevelAuditItem,
  type LevelAuditKind,
  type LevelAuditPage,
  type LevelAuditQuery,
} from '@kb-chat/contracts';
import { LevelsApi } from '@core/levels/levels-api.js';
import { finalize } from 'rxjs';

/** The filters as the form holds them ('' = any). */
interface HistoryFilter {
  readonly kind: LevelAuditKind | '';
  readonly actor: string;
  readonly from: string;
  readonly to: string;
  /** One item or person, from a row's "Só este item". */
  readonly target: { readonly id: string; readonly label: string } | null;
}

const NO_FILTER: HistoryFilter = {
  kind: '',
  actor: '',
  from: '',
  to: '',
  target: null,
};

const PAGE = 20;

const KIND_LABELS: Record<LevelAuditKind, () => string> = {
  'scale.create': () => $localize`:@@history.kindCreate:Nível criado`,
  'scale.rename': () => $localize`:@@history.kindRename:Nível renomeado`,
  'scale.reorder': () => $localize`:@@history.kindReorder:Ordem da escala`,
  'scale.delete': () => $localize`:@@history.kindDelete:Nível apagado`,
  'scale.clear': () => $localize`:@@history.kindClear:Todos os níveis tirados`,
  'scale.undone': () => $localize`:@@history.kindUndone:Desfeito`,
  'person.level': () => $localize`:@@history.kindPerson:Nível de pessoa`,
  'item.level': () => $localize`:@@history.kindItem:Nível de item`,
  bulk: () => $localize`:@@history.kindBulk:Lote`,
};

const NONE = () => $localize`:@@history.noLevel:Sem nível`;
const UNRECORDED = () => $localize`:@@history.unrecorded:nenhum registrado`;

/** What one line says, by its kind ("CI → CDC: 'Aula 12'"). */
const WHAT: Record<LevelAuditKind, (item: LevelAuditItem) => string> = {
  'scale.create': (item) =>
    $localize`:@@history.whatCreate:Criou o nível ${item.after ?? ''}:code:`,
  'scale.rename': (item) =>
    item.before === item.after
      ? $localize`:@@history.whatDescribe:Mudou a descrição de ${item.after ?? ''}:code:`
      : $localize`:@@history.whatRename:Renomeou ${item.before ?? ''}:before: → ${item.after ?? ''}:after:`,
  'scale.reorder': (item) =>
    $localize`:@@history.whatReorder:Ordem: ${item.before ?? ''}:before: → ${item.after ?? ''}:after:`,
  'scale.delete': (item) =>
    $localize`:@@history.whatDelete:Apagou ${item.before ?? ''}:code:: conteúdo → ${item.moves?.content ?? ''}:content:, pessoas → ${item.moves?.people ?? ''}:people:`,
  'scale.undone': () => '',
  'scale.clear': (item) =>
    $localize`:@@history.whatClear:Tirou todos os níveis (${item.before ?? ''}:codes:)`,
  // A person with no level recorded holds the lowest (ADR 0036 §2): "nenhum registrado".
  'person.level': (item) =>
    $localize`:@@history.whatPerson:${item.before ?? UNRECORDED()}:before: → ${item.after ?? UNRECORDED()}:after:: ${item.targetLabel ?? item.target ?? ''}:person:`,
  'item.level': (item) =>
    $localize`:@@history.whatItem:${item.before ?? NONE()}:before: → ${item.after ?? NONE()}:after:: “${item.targetLabel ?? item.target ?? ''}:title:”`,
  bulk: (item) => {
    const n =
      (item.count?.documents ?? 0) +
      (item.count?.people ?? 0) +
      (item.count?.media ?? 0);
    return $localize`:@@history.whatBulk:Lote: ${n}:count: itens → ${item.after ?? ''}:code:`;
  },
};

/** The start or the end of a local day (`YYYY-MM-DD`), as an ISO instant. */
const localInstant = (day: string, edge: 'start' | 'end'): string =>
  new Date(
    `${day}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}`,
  ).toISOString();

/** The API's query: the filters set, the page size. */
const toQuery = (topic: string, filter: HistoryFilter): LevelAuditQuery => ({
  topic,
  limit: PAGE,
  ...(filter.kind && { kind: filter.kind }),
  ...(filter.actor.trim() && { actor: filter.actor.trim() }),
  // The local day as instants, as the list shows the local time (R1-9).
  ...(filter.from && { from: localInstant(filter.from, 'start') }),
  ...(filter.to && { to: localInstant(filter.to, 'end') }),
  ...(filter.target && { target: filter.target.id }),
});

/**
 * "Histórico de níveis" on T24 (KBC-108 FR-4, BR-5): masters read who changed which level,
 * when, before → after and while acting as whom, newest first, a page at a time. Collapsed
 * until opened: nothing is asked before.
 */
@Component({
  selector: 'app-levels-history',
  imports: [DatePipe],
  templateUrl: './levels-history.html',
  styleUrl: './levels-history.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LevelsHistory {
  private readonly api = inject(LevelsApi);
  private readonly destroyRef = inject(DestroyRef);

  /** The top-level collection whose history this is. */
  readonly topic = input.required<string>();
  /** Grows with each change made on the page: the open list reads itself again (R1-12). */
  readonly revision = input(0);

  /** The kinds a filter offers (an undone mark is never shown). */
  protected readonly kinds = LEVEL_AUDIT_KINDS.filter(
    (kind) => kind !== 'scale.undone',
  );
  protected readonly open = signal(false);
  protected readonly filter = signal<HistoryFilter>(NO_FILTER);
  protected readonly first = rxResource({
    params: () =>
      this.open()
        ? {
            query: toQuery(this.topic(), this.filter()),
            revision: this.revision(),
          }
        : undefined,
    stream: ({ params }) => this.api.history(params.query),
  });
  /** Pages after the first ("Carregar mais"), emptied with each first page. */
  private readonly more = linkedSignal<
    LevelAuditPage | undefined,
    LevelAuditPage[]
  >({
    source: () => (this.first.hasValue() ? this.first.value() : undefined),
    computation: () => [],
  });
  protected readonly items = computed(() => [
    ...(this.first.hasValue() ? (this.first.value()?.items ?? []) : []),
    ...this.more().flatMap((page) => page.items),
  ]);
  private readonly nextCursor = computed(() => {
    const last =
      this.more().at(-1) ??
      (this.first.hasValue() ? this.first.value() : undefined);
    return last?.nextCursor ?? null;
  });
  protected readonly hasMore = computed(() => this.nextCursor() !== null);
  protected readonly loadingMore = signal(false);
  protected readonly moreFailed = signal(false);

  protected toggle(): void {
    this.open.update((open) => !open);
  }

  protected kindLabel(kind: LevelAuditKind): string {
    return KIND_LABELS[kind]();
  }

  protected what(item: LevelAuditItem): string {
    return WHAT[item.kind](item);
  }

  protected who(item: LevelAuditItem): string {
    const { byName, actingAsName } = item;
    return actingAsName
      ? $localize`:@@history.actingAs:${byName}:by: agindo como ${actingAsName}:as:`
      : byName;
  }

  /** "Só este item" / "Só esta pessoa": the rows about the same item or person. */
  protected onlyLabel(item: LevelAuditItem): string {
    return item.subject === 'person'
      ? $localize`:@@history.onlyPerson:Só esta pessoa`
      : $localize`:@@history.onlyItem:Só este item`;
  }

  /** The visible words first, then whom they are about (WCAG 2.5.3). */
  protected onlyAria(item: LevelAuditItem): string {
    return `${this.onlyLabel(item)}: ${item.targetLabel ?? item.target ?? ''}`;
  }

  protected canFilterBy(item: LevelAuditItem): boolean {
    const filterable = ['document', 'media', 'person'];
    return (
      item.target !== null &&
      filterable.includes(item.subject ?? '') &&
      this.filter().target?.id !== item.target
    );
  }

  protected only(item: LevelAuditItem): void {
    if (!item.target) return;
    const label = item.targetLabel ?? item.target;
    this.change({ target: { id: item.target, label } });
  }

  protected change(next: Partial<HistoryFilter>): void {
    this.filter.update((filter) => ({ ...filter, ...next }));
  }

  protected changeKind(value: string): void {
    const kind = this.kinds.find((one) => one === value) ?? '';
    this.change({ kind });
  }

  protected loadMore(): void {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.moreFailed.set(false);
    // A page asked for another filter is dropped (PD-03): the list changed meanwhile.
    const from = this.first.hasValue() ? this.first.value() : undefined;
    this.api
      .history({ ...toQuery(this.topic(), this.filter()), cursor })
      .pipe(
        finalize(() => this.loadingMore.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (page) => {
          const current = this.first.hasValue()
            ? this.first.value()
            : undefined;
          if (current === from) this.more.update((pages) => [...pages, page]);
        },
        error: () => this.moreFailed.set(true),
      });
  }
}

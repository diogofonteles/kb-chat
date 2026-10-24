import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  SEE_ALSO_GROUPS,
  type DocumentRef,
  type RelatedDocument,
  type SeeAlso,
  type SeeAlsoGroupName,
} from '@kb-chat/contracts';
import { KbApi } from '@core/api/kb-api.js';
import { describeFacets } from '@core/i18n/facet-labels.js';

const GROUP_TITLES: Record<SeeAlsoGroupName, string> = {
  exampleOf: $localize`:@@seeAlso.exampleOf:É exemplo de`,
  extends: $localize`:@@seeAlso.extends:Aprofunda`,
  related: $localize`:@@seeAlso.related:Relacionados`,
  examples: $localize`:@@seeAlso.examples:Exemplos`,
  extendedBy: $localize`:@@seeAlso.extendedBy:Aprofundado por`,
  relatedFrom: $localize`:@@seeAlso.relatedFrom:Relacionados a este assunto`,
};

interface ItemView extends DocumentRef {
  readonly facets: string;
}

interface GroupView {
  readonly name: SeeAlsoGroupName;
  readonly title: string;
  readonly items: readonly ItemView[];
  readonly total: number;
  readonly loading: boolean;
  readonly failed: boolean;
}

/** References loaded per "Ver mais" click. */
const PAGE_SIZE = 50;

const toItem = (ref: RelatedDocument): ItemView => ({
  id: ref.id,
  title: ref.title,
  facets: describeFacets(ref),
});

/** "Veja também" in the document panel (screens.md T3, KBC-003 BR-1/BR-3). */
@Component({
  selector: 'app-see-also',
  templateUrl: './see-also.html',
  styleUrl: './see-also.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SeeAlsoSection {
  private readonly api = inject(KbApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly topic = input.required<string>();
  readonly documentId = input.required<string>();
  readonly seeAlso = input.required<SeeAlso>();
  readonly opened = output<DocumentRef>();

  /** Items loaded with "ver todos", reset whenever another document is shown. */
  private readonly expanded = linkedSignal<
    SeeAlso,
    Partial<Record<SeeAlsoGroupName, readonly RelatedDocument[]>>
  >({
    source: this.seeAlso,
    computation: () => ({}),
  });

  /** Groups with a "Ver mais" request in flight or failed (one request per group at a time). */
  private readonly loading = linkedSignal<
    SeeAlso,
    ReadonlySet<SeeAlsoGroupName>
  >({
    source: this.seeAlso,
    computation: () => new Set(),
  });
  private readonly failed = linkedSignal<
    SeeAlso,
    ReadonlySet<SeeAlsoGroupName>
  >({
    source: this.seeAlso,
    computation: () => new Set(),
  });

  protected readonly groups = computed<GroupView[]>(() =>
    SEE_ALSO_GROUPS.map((name) => ({
      name,
      title: GROUP_TITLES[name],
      items: (this.expanded()[name] ?? this.seeAlso()[name].items).map(toItem),
      total: this.seeAlso()[name].total,
      loading: this.loading().has(name),
      failed: this.failed().has(name),
    })).filter((group) => group.total > 0),
  );

  /** Loads the next page of a group; ignored while that group is already loading. */
  protected showMore(group: GroupView): void {
    if (group.loading) return;
    const already =
      this.expanded()[group.name] ?? this.seeAlso()[group.name].items;
    this.loading.update((names) => new Set([...names, group.name]));
    this.failed.update(
      (names) => new Set([...names].filter((name) => name !== group.name)),
    );
    this.api
      .relations(this.topic(), this.documentId(), {
        group: group.name,
        offset: already.length,
        limit: PAGE_SIZE,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          this.expanded.update((all) => ({
            ...all,
            [group.name]: [...already, ...page.items],
          }));
          this.done(group.name);
        },
        error: () => {
          this.failed.update((names) => new Set([...names, group.name]));
          this.done(group.name);
        },
      });
  }

  private done(name: SeeAlsoGroupName): void {
    this.loading.update(
      (names) => new Set([...names].filter((n) => n !== name)),
    );
  }
}

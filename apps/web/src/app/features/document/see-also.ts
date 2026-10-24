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
  type SeeAlso,
  type SeeAlsoGroupName,
} from '@kb-chat/contracts';
import { KbApi } from '@core/api/kb-api.js';

const GROUP_TITLES: Record<SeeAlsoGroupName, string> = {
  exampleOf: $localize`:@@seeAlso.exampleOf:É exemplo de`,
  extends: $localize`:@@seeAlso.extends:Aprofunda`,
  related: $localize`:@@seeAlso.related:Relacionados`,
  examples: $localize`:@@seeAlso.examples:Exemplos`,
  extendedBy: $localize`:@@seeAlso.extendedBy:Aprofundado por`,
  relatedFrom: $localize`:@@seeAlso.relatedFrom:Relacionados a este assunto`,
};

interface GroupView {
  readonly name: SeeAlsoGroupName;
  readonly title: string;
  readonly items: readonly DocumentRef[];
  readonly total: number;
}

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
    Partial<Record<SeeAlsoGroupName, readonly DocumentRef[]>>
  >({
    source: this.seeAlso,
    computation: () => ({}),
  });

  protected readonly groups = computed<GroupView[]>(() =>
    SEE_ALSO_GROUPS.map((name) => ({
      name,
      title: GROUP_TITLES[name],
      items: this.expanded()[name] ?? this.seeAlso()[name].items,
      total: this.seeAlso()[name].total,
    })).filter((group) => group.total > 0),
  );

  /** Loads the next page of a group (event handler: the subscription ends with the request). */
  protected showMore(group: GroupView): void {
    this.api
      .relations(this.topic(), this.documentId(), {
        group: group.name,
        offset: group.items.length,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((page) =>
        this.expanded.update((all) => ({
          ...all,
          [group.name]: [...group.items, ...page.items],
        })),
      );
  }
}

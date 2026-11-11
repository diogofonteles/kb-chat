import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  linkedSignal,
  output,
  viewChild,
} from '@angular/core';
import type { LevelScales, Topic } from '@kb-chat/contracts';

/** What the master asked the bar to do: one level of one collection for the selection. */
export interface PeopleLevelRequest {
  readonly collection: string;
  readonly level: string;
}

/**
 * "Nível em [acervo]: [nível] · Aplicar" (T9, KBC-109 FR-5): one level for the people
 * selected. No level is chosen in advance (SL-28). Presentational: the people page applies it.
 */
@Component({
  selector: 'app-people-level-bar',
  template: `
    <div class="bar" role="group" aria-labelledby="level-bar-title">
      <p id="level-bar-title" class="title" i18n="@@peopleLevel.title">
        Nível para várias pessoas
      </p>
      <div class="fields">
        <label class="field">
          <span i18n="@@peopleLevel.collection">Nível em</span>
          <select
            #collectionSelect
            class="select"
            [disabled]="busy()"
            (change)="chooseCollection(collectionSelect.value)"
          >
            @for (scale of choices(); track scale.collection) {
              <option
                [value]="scale.collection"
                [selected]="scale.collection === collection()"
              >
                {{ scale.title }}
              </option>
            }
          </select>
        </label>
        <label class="field">
          <span i18n="@@peopleLevel.level">Nível</span>
          <select
            #levelSelect
            class="select"
            [disabled]="busy()"
            (change)="level.set(levelSelect.value)"
          >
            <option
              value=""
              disabled
              [selected]="level() === ''"
              i18n="@@peopleLevel.choose"
            >
              Escolha
            </option>
            @for (one of levels(); track one.id) {
              <option [value]="one.id" [selected]="one.id === level()">
                {{ one.code }}
              </option>
            }
          </select>
        </label>
      </div>
      <div class="actions">
        <button
          #applyLevelButton
          type="button"
          class="secondary"
          [disabled]="busy() || selectedCount() === 0 || level() === ''"
          (click)="applyLevel()"
          i18n="@@peopleLevel.apply"
        >
          Aplicar nível às selecionadas ({{ selectedCount() }})
        </button>
      </div>
    </div>
  `,
  styleUrl: './ai-assignment-bar.css',
  styles: `
    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
    }
    .fields .field {
      flex: 1 1 12rem;
      min-width: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeopleLevelBar {
  readonly scales = input.required<LevelScales['items']>();
  readonly topics = input.required<readonly Topic[]>();
  readonly selectedCount = input(0);
  readonly busy = input(false);
  readonly apply = output<PeopleLevelRequest>();
  /** Where focus goes back after a failure (WCAG 2.4.3). */
  readonly applyButton =
    viewChild<ElementRef<HTMLButtonElement>>('applyLevelButton');

  /** Each collection with levels, by its title. */
  protected readonly choices = computed(() =>
    this.scales().map((scale) => ({
      ...scale,
      title:
        this.topics().find((topic) => topic.slug === scale.collection)?.title ??
        scale.collection,
    })),
  );
  protected readonly collection = linkedSignal(
    () => this.scales()[0]?.collection ?? '',
  );
  protected readonly levels = computed(
    () =>
      this.scales().find((scale) => scale.collection === this.collection())
        ?.levels ?? [],
  );
  /** Another collection, another scale: the level is chosen again. */
  protected readonly level = linkedSignal({
    source: this.collection,
    computation: () => '',
  });

  protected chooseCollection(collection: string): void {
    this.collection.set(collection);
  }

  protected applyLevel(): void {
    const level = this.level();
    if (level === '' || this.busy()) return;
    this.apply.emit({ collection: this.collection(), level });
  }
}

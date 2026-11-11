import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Topic } from '@kb-chat/contracts';
import { levelsPagePath } from '@core/levels/levels-api.js';
import { UnassignedCountsStore } from '@core/levels/unassigned-counts-store.js';

/**
 * The sidebar's "N documentos sem nível" (KBC-107 FR-6, AC-9): under the chosen collection,
 * for masters and whoever classifies content, linking to its "Sem nível" on T24. Gone at 0.
 */
@Component({
  selector: 'app-unassigned-notice',
  imports: [RouterLink],
  template: `
    @if (count() > 0) {
      <a class="notice" [routerLink]="path()" (click)="opened.emit()">
        <span aria-hidden="true">⚠</span>
        {{ text() }}
      </a>
    }
  `,
  styles: `
    .notice {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      min-height: var(--target);
      padding: 0 var(--space-3);
      border: 1px solid var(--color-danger);
      border-radius: var(--radius-sm);
      color: var(--color-danger);
      font-size: var(--text-sm);
      font-weight: 600;
      text-decoration: none;
    }
    .notice:hover {
      background: var(--color-surface-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnassignedNotice {
  private readonly counts = inject(UnassignedCountsStore);

  /** The collection chosen in the sidebar. */
  readonly topic = input.required<Topic | null>();
  /** The link was followed: the drawer closes. */
  readonly opened = output();

  private readonly root = computed(() => {
    const topic = this.topic();
    return topic ? (topic.parent ?? topic.slug) : '';
  });
  protected readonly count = computed(() =>
    this.root() ? this.counts.countOf(this.root()) : 0,
  );
  protected readonly path = computed(() => levelsPagePath(this.root()));
  protected readonly text = computed(() => {
    const count = this.count();
    return count === 1
      ? $localize`:@@unassigned.noticeOne:1 documento sem nível`
      : $localize`:@@unassigned.notice:${count}:count: documentos sem nível`;
  });
}

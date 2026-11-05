import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { QUEUE_PAGE_PATH } from '@core/media/preparation-api.js';
import { ProcessingQueueStore } from './processing-queue-store.js';
import { queueStateText } from './queue-labels.js';

/** How many audios the block shows; the page has the rest. */
const SHOWN = 3;

/** The queue, in brief, on the library (KBC-090): nothing at all when nothing is there. */
@Component({
  selector: 'app-queue-summary',
  imports: [RouterLink],
  template: `
    @if (lines().length > 0) {
      <section class="summary" aria-labelledby="queue-summary-title">
        <div class="top">
          <h3 id="queue-summary-title">{{ titleText() }}</h3>
          <a [routerLink]="path" i18n="@@queue.open">Ver a fila</a>
        </div>
        <ul>
          @for (line of lines(); track line.id) {
            <li>
              <span class="name">{{ line.title }}</span>
              <span class="state">{{ line.state }}</span>
            </li>
          }
        </ul>
        @if (hiddenCount() > 0) {
          <p class="more" i18n="@@queue.more">e mais {{ hiddenCount() }}</p>
        }
      </section>
    }
  `,
  styles: `
    .summary {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-left: 3px solid var(--color-accent);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }

    .top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-1) var(--space-3);
    }

    h3 {
      margin: 0;
      font-size: var(--text-md);
    }

    a {
      display: inline-block;
      padding-block: var(--space-1);
      color: var(--color-accent-strong);
      font-weight: 600;
    }

    ul {
      display: grid;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    li {
      display: flex;
      flex-wrap: wrap;
      gap: 0 var(--space-2);
      overflow-wrap: anywhere;
      min-width: 0;
    }

    .name {
      min-width: 0;
      font-weight: 600;
    }

    .state,
    .more {
      min-width: 0;
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueueSummary {
  private readonly store = inject(ProcessingQueueStore);
  protected readonly path = QUEUE_PAGE_PATH;
  /** What needs the person first: with three at work it would never show. */
  private readonly shown = computed(() => {
    const items = this.store.items();
    return [
      ...items.filter(({ phase }) => phase === 'attention'),
      ...items.filter(({ phase }) => phase === 'running' || phase === 'next'),
    ];
  });
  protected readonly lines = computed(() =>
    this.shown()
      .slice(0, SHOWN)
      .map((item) => ({
        id: item.mediaId,
        title: item.title,
        state: queueStateText(item),
      })),
  );
  protected readonly hiddenCount = computed(() =>
    Math.max(0, this.shown().length - SHOWN),
  );
  protected readonly titleText = computed(() => {
    const active = this.store.active();
    if (active === 0)
      return $localize`:@@queue.summary.waiting:Áudios esperando por você`;
    return active === 1
      ? $localize`:@@queue.summary.one:1 áudio em processamento`
      : $localize`:@@queue.summary.many:${active}:count: áudios em processamento`;
  });
}

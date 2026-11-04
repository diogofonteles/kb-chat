import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { movedBookmarksSchema } from '@kb-chat/contracts';
import {
  MOVED_BOOKMARKS_URL,
  TrackRevisionsApi,
} from '@core/media/track-revisions-api.js';
import { movedText } from './track-edit-labels.js';

/**
 * "1 marcador foi movido para a gravação completa porque a faixa mudou" (KBC-073 BR-4): said to
 * the owner of the bookmark until they say they read it. On a track's page, only that track's.
 */
@Component({
  selector: 'app-moved-bookmarks-notice',
  imports: [RouterLink],
  template: `
    @for (entry of entries(); track entry.mediaId) {
      <div class="moved" role="status">
        <p>
          <strong>{{ entry.title }}:</strong> {{ textOf(entry.count) }}
        </p>
        <span class="links">
          <a
            [routerLink]="['/midia', entry.recordingId]"
            i18n="@@trackEdit.moved.see"
            >Ver a gravação</a
          >
          <button
            type="button"
            class="secondary"
            (click)="acknowledge()"
            i18n="@@trackEdit.moved.ok"
          >
            Entendi
          </button>
        </span>
      </div>
    }
  `,
  styleUrl: './track-edit.css',
  styles: `
    .moved {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      margin-bottom: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    p {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .links {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MovedBookmarksNotice {
  private readonly api = inject(TrackRevisionsApi);
  private readonly destroyRef = inject(DestroyRef);

  /** A track: only what left it. Left out: everything of the person's. */
  readonly mediaId = input<string | null>(null);

  private readonly read = httpResource(() => MOVED_BOOKMARKS_URL, {
    parse: (body) => movedBookmarksSchema.parse(body).moved,
  });
  protected readonly entries = computed(() => {
    if (!this.read.hasValue()) return [];
    const id = this.mediaId();
    const moved = this.read.value();
    return id === null ? moved : moved.filter((one) => one.mediaId === id);
  });

  protected textOf(count: number): string {
    return movedText({ count });
  }

  protected acknowledge(): void {
    this.api
      .acknowledgeMoved()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.read.reload());
  }
}

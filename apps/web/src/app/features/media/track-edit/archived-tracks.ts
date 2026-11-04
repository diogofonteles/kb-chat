import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { archivedTracksSchema, type MediaItem } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import {
  TrackRevisionsApi,
  archivedTracksUrl,
} from '@core/media/track-revisions-api.js';
import { restoreFailureText } from './track-restore-failure.js';

/** "Faixas apagadas" of a recording (KBC-073 FR-3): nothing shows while there are none. */
@Component({
  selector: 'app-archived-tracks',
  imports: [DatePipe, RouterLink],
  template: `
    @if (tracks().length > 0) {
      <section aria-labelledby="archived-tracks-title">
        <h3 id="archived-tracks-title" i18n="@@trackEdit.archived.title">
          Faixas apagadas
        </h3>
        @if (failure(); as text) {
          <p class="error" role="alert">{{ text }}</p>
        }
        <ul>
          @for (track of tracks(); track track.mediaId) {
            <li>
              <span class="what">
                <a [routerLink]="['/midia', track.mediaId]">{{
                  track.title
                }}</a>
                <span class="note">
                  {{ clock(track.startMs) }} a {{ clock(track.endMs) }} ·
                  <ng-container i18n="@@trackEdit.archived.until"
                    >restaura até
                    {{ track.restorableUntil | date: 'dd/MM' }}</ng-container
                  >
                </span>
              </span>
              <button
                type="button"
                class="secondary"
                [disabled]="busy()"
                (click)="restore(track.mediaId)"
                i18n="@@trackEdit.restore"
              >
                Restaurar
              </button>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styleUrl: './track-edit.css',
  styles: `
    h3 {
      margin: 0 0 var(--space-2);
      font-size: var(--text-md);
    }
    ul {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .what {
      display: grid;
      min-width: 0;
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArchivedTracks {
  private readonly api = inject(TrackRevisionsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly recordingId = input.required<string>();
  readonly restored = output<MediaItem>();

  private readonly read = httpResource(
    () => archivedTracksUrl(this.recordingId()),
    { parse: (body) => archivedTracksSchema.parse(body).tracks },
  );
  protected readonly tracks = computed(() =>
    this.read.hasValue() ? this.read.value() : [],
  );
  protected readonly busy = signal(false);
  protected readonly failure = signal('');

  protected clock(ms: number): string {
    return formatClock(ms);
  }

  protected restore(id: string): void {
    this.busy.set(true);
    this.failure.set('');
    this.api
      .restore(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (item) => {
          this.busy.set(false);
          this.read.reload();
          this.restored.emit(item);
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.failure.set(restoreFailureText(err));
        },
      });
  }
}

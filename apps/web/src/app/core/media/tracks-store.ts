import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { mediaTracksSchema, type ApprovedTrack } from '@kb-chat/contracts';
import { adjacentTrack, trackAt } from '@kb-chat/player-core';
import { SessionStore } from '@core/auth/session-store.js';
import { catchError, map, of, tap, type Observable } from 'rxjs';
import { mediaTracksUrl } from './media-edit-api.js';
import { MediaEngine } from './media-engine.js';

interface LoadedTracks {
  readonly mediaId: string;
  readonly tracks: readonly ApprovedTrack[];
}

/**
 * The approved tracks of what plays (KBC-066 FR-9): the player's marks and list, and the
 * mini-player's title, which outlives the page. Only with `media-tracks` (BR-8): without it
 * nothing is asked and the player stays as it was (AC-13).
 */
@Injectable({ providedIn: 'root' })
export class TracksStore {
  private readonly http = inject(HttpClient);
  private readonly engine = inject(MediaEngine);
  private readonly session = inject(SessionStore);
  private readonly loaded = signal<LoadedTracks | null>(null);

  /** The tracks of the media in the engine. */
  readonly tracks = computed<readonly ApprovedTrack[]>(() => {
    const loaded = this.loaded();
    return loaded && loaded.mediaId === this.engine.source()?.id
      ? loaded.tracks
      : [];
  });
  readonly current = computed(() =>
    trackAt(this.tracks(), this.engine.playback().currentMs),
  );
  readonly hasPrevious = computed(() => this.adjacent(-1) !== null);
  readonly hasNext = computed(() => this.adjacent(1) !== null);

  /** Reads a media's tracks; a failure leaves the player as it is without them. */
  load(mediaId: string): Observable<readonly ApprovedTrack[]> {
    if (!this.session.can('media-tracks')) {
      this.loaded.set(null);
      return of([]);
    }
    return this.http.get(mediaTracksUrl(mediaId)).pipe(
      map((body) => mediaTracksSchema.parse(body).tracks),
      catchError(() => of<readonly ApprovedTrack[]>([])),
      tap((tracks) => this.loaded.set({ mediaId, tracks })),
    );
  }

  go(track: ApprovedTrack): void {
    this.engine.seek(track.startMs);
  }

  /** "Faixa anterior" and "Próxima faixa"; false when there is none to go to. */
  step(direction: 1 | -1): boolean {
    const track = this.adjacent(direction);
    if (track) this.go(track);
    return track !== null;
  }

  private adjacent(direction: 1 | -1): ApprovedTrack | null {
    return adjacentTrack(this.tracks(), {
      ms: this.engine.playback().currentMs,
      direction,
    });
  }
}

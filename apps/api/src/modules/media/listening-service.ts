import {
  MEDIA_COMPLETION_RATIO,
  type MediaPreferences,
  type MediaProgress,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { ListeningStorePort } from '../../ports/listening-store.js';
import type { MediaActor, MediaService } from './media-service.js';

/** Before any choice: normal speed, remaining time on the right (screens.md T15). */
export const DEFAULT_PREFERENCES: MediaPreferences = {
  speed: 1,
  showRemaining: true,
};

export interface ListeningServiceDeps {
  readonly listening: ListeningStorePort;
  /** Who sees which media (404 otherwise), with its length. */
  readonly media: MediaService;
  readonly now?: () => Date;
}

/**
 * Each person's way of listening (KBC-041): the speed and time display they chose, for
 * every media and device (BR-1), and where they stopped in each media (BR-2). The last
 * write wins, by the server's clock.
 */
export class ListeningService {
  constructor(private readonly deps: ListeningServiceDeps) {}

  preferences(actor: MediaActor): MediaPreferences {
    return (
      this.deps.listening.preferencesOf(actor.principal) ?? DEFAULT_PREFERENCES
    );
  }

  savePreferences(
    actor: MediaActor,
    preferences: MediaPreferences,
  ): MediaPreferences {
    this.deps.listening.savePreferences({
      principal: actor.principal,
      preferences,
      now: this.now(),
    });
    return preferences;
  }

  /**
   * The person's position in a media they can see. From 95% of its length the media is
   * heard: the position goes back to 0 and the time it was heard is kept (BR-2).
   */
  saveProgress(
    actor: MediaActor,
    mediaId: string,
    positionMs: number,
  ): MediaProgress {
    const item = this.deps.media.get(actor, mediaId);
    const durationMs = item.durationMs;
    if (item.status !== 'ready' || durationMs === null)
      throw new AppError('MEDIA_NOT_READY', 'This media cannot be played yet');
    if (positionMs > durationMs)
      throw new AppError('VALIDATION_FAILED', 'The position is past the end', {
        details: { field: 'positionMs' },
      });
    const now = this.now();
    const heard = positionMs >= durationMs * MEDIA_COMPLETION_RATIO;
    const progress = heard
      ? { positionMs: 0, completedAt: now.toISOString() }
      : { positionMs, completedAt: item.completedAt };
    this.deps.listening.saveProgress({
      principal: actor.principal,
      mediaId,
      progress,
      now,
    });
    return { ...progress, positionUpdatedAt: now.toISOString() };
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}

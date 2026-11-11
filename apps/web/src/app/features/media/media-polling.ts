import { InjectionToken } from '@angular/core';

/** While anything is queued or converting, the list refreshes this often (as T5 does). */
export const MEDIA_POLL_MS = new InjectionToken<number>('MEDIA_POLL_MS', {
  providedIn: 'root',
  factory: () => 5_000,
});

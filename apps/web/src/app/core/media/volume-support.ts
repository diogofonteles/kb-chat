import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';

/**
 * Whether the page may set the volume (KBC-041 FR-9): on iPhone and iPad the volume of a
 * page is read-only (the device's buttons rule), so the player hides its volume control.
 * Known only by trying: set a test element's volume and wait for it to report the change.
 */
export function probeVolume(
  createElement: () => HTMLMediaElement,
  timeoutMs = 1_000,
): Promise<boolean> {
  const probe = createElement();
  return new Promise((resolve) => {
    const finish = (answer: boolean) => {
      clearTimeout(timer);
      probe.removeEventListener('volumechange', changed);
      resolve(answer);
    };
    const changed = () => finish(probe.volume === 0.5);
    const timer = setTimeout(() => finish(false), timeoutMs);
    probe.addEventListener('volumechange', changed);
    probe.volume = 0.5;
    if (probe.volume !== 0.5) finish(false);
  });
}

/** The answer for this browser, asked once per app. */
export const VOLUME_SUPPORT = new InjectionToken<Promise<boolean>>(
  'VOLUME_SUPPORT',
  {
    providedIn: 'root',
    factory: () => {
      const document = inject(DOCUMENT);
      return probeVolume(() => document.createElement('audio'));
    },
  },
);

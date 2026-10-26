import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';

/** Leaves the app for another site (OpenRouter's consent page, KBC-022); a fake in tests. */
export const GO_TO_URL = new InjectionToken<(url: string) => void>(
  'GO_TO_URL',
  {
    providedIn: 'root',
    factory: () => {
      const view = inject(DOCUMENT).defaultView;
      return (url: string) => view?.location.assign(url);
    },
  },
);

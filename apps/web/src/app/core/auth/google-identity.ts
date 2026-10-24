import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Observable, shareReplay } from 'rxjs';

/** The Google Identity Services script (ADR 0008); allow it in any Content-Security-Policy. */
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/** The part of `google.accounts.id` kb-chat uses. */
export interface GoogleAccountsId {
  initialize(options: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    ux_mode?: 'popup' | 'redirect';
  }): void;
  renderButton(
    parent: HTMLElement,
    options: Record<string, string | number>,
  ): void;
  disableAutoSelect(): void;
}

interface GoogleWindow {
  google?: { accounts?: { id?: GoogleAccountsId } };
}

const accountsOf = (view: Window | null): GoogleAccountsId | undefined =>
  (view as (Window & GoogleWindow) | null)?.google?.accounts?.id;

/** Loads the script once and hands out `google.accounts.id`. */
@Injectable({ providedIn: 'root' })
export class GoogleIdentity {
  private readonly document = inject(DOCUMENT);

  readonly accounts$: Observable<GoogleAccountsId> =
    new Observable<GoogleAccountsId>((subscriber) => {
      const loaded = accountsOf(this.document.defaultView);
      if (loaded) {
        subscriber.next(loaded);
        subscriber.complete();
        return;
      }
      const script = this.document.createElement('script');
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        const accounts = accountsOf(this.document.defaultView);
        if (accounts) subscriber.next(accounts);
        else
          subscriber.error(new Error('Google Identity Services did not start'));
        subscriber.complete();
      };
      script.onerror = () =>
        subscriber.error(new Error('Google Identity Services did not load'));
      this.document.head.appendChild(script);
    }).pipe(shareReplay({ bufferSize: 1, refCount: false }));

  /** After "Sair": Google does not sign the same account in again by itself. */
  disableAutoSelect(): void {
    accountsOf(this.document.defaultView)?.disableAutoSelect();
  }
}

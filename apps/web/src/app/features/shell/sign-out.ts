import { Injectable, inject } from '@angular/core';
import { GoogleIdentity } from '@core/auth/google-identity.js';
import { SessionStore } from '@core/auth/session-store.js';

/** "Sair" (the avatar menu and the phone's Menu): ends the session without Google's auto sign-in. */
@Injectable({ providedIn: 'root' })
export class SignOut {
  private readonly google = inject(GoogleIdentity);
  private readonly session = inject(SessionStore);

  run(): void {
    this.google.disableAutoSelect();
    // The page starts over at the login screen once the session is gone (SessionStore).
    this.session.signOut().subscribe();
  }
}

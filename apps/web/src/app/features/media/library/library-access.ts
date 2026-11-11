import type { SessionStore } from '@core/auth/session-store.js';

/**
 * Whether the person has the library (KBC-051 BR-1): the server's media on, "Ouvir mídia"
 * and "Biblioteca de mídia" (masters have every feature).
 */
export const hasLibrary = (session: SessionStore): boolean =>
  session.me()?.media === true &&
  session.can('media') &&
  session.can('media-library');

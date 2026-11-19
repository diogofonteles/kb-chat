import type { SessionStore } from '@core/auth/session-store.js';

/**
 * Whether the person has the library (KBC-051 BR-1): the server's media on, "Ouvir mídia"
 * and "Biblioteca de mídia" (masters have every feature).
 */
export const hasLibrary = (session: SessionStore): boolean =>
  session.me()?.media === true &&
  session.can('media') &&
  session.can('media-library');

/**
 * "Todas as mídias" (the Biblioteca pin): the library of every collection, only by that
 * explicit choice and only while the address says so (`/biblioteca?acervos=todos`). Without
 * it the library is the chosen collection's, with its sub-collections (ADR 0028 §6); the
 * account never brings "every collection" back by itself (owner, 2026-11-19).
 */
export const ALL_COLLECTIONS_PARAM = 'acervos';
export const ALL_COLLECTIONS_VALUE = 'todos';

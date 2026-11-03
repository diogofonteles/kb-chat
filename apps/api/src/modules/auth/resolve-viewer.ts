import type { FastifyRequest } from 'fastify';
import type { StoredSession } from '../../ports/session-store.js';
import type { ActAsService } from './act-as-service.js';
import type { PeopleService } from './people-service.js';
import type { Viewer } from './person.js';
import { sessionTokenOf } from './routes.js';
import type { SessionService } from './session-service.js';

export interface ViewerSources {
  readonly people: PeopleService;
  readonly sessions: SessionService;
  /** Masters acting as a person (KBC-060); without it nobody acts as anyone. */
  readonly actAs?: ActAsService;
}

/** Who a request acts for, and the session it came with. */
export interface ResolvedViewer {
  readonly viewer: Viewer;
  readonly session: StoredSession;
}

/**
 * The person behind the request's session cookie, or null (no, expired or revoked session).
 * While a master acts as someone (KBC-060), the person's view, with the master as `actor`.
 */
export async function resolveViewer(
  request: FastifyRequest,
  { people, sessions, actAs }: ViewerSources,
): Promise<ResolvedViewer | null> {
  const token = sessionTokenOf(request);
  if (!token) return null;
  const session = await sessions.resolve(token);
  if (!session) return null;
  const person = await people.find(session.personId);
  if (!person) return null;
  const own = people.viewerOf(person);
  const viewer = actAs ? await actAs.viewerFor(session, own) : own;
  return { viewer, session };
}

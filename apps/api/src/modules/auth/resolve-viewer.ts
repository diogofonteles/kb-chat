import type { FastifyRequest } from 'fastify';
import type { PeopleService } from './people-service.js';
import type { Viewer } from './person.js';
import { sessionTokenOf } from './routes.js';
import type { SessionService } from './session-service.js';

export interface ViewerSources {
  readonly people: PeopleService;
  readonly sessions: SessionService;
}

/** The person behind the request's session cookie, or null (no, expired or revoked session). */
export async function resolveViewer(
  request: FastifyRequest,
  { people, sessions }: ViewerSources,
): Promise<Viewer | null> {
  const token = sessionTokenOf(request);
  if (!token) return null;
  const session = await sessions.resolve(token);
  if (!session) return null;
  const person = await people.find(session.personId);
  return person ? people.viewerOf(person) : null;
}

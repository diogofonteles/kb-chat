import type { Me } from '@kb-chat/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parentOfRequest } from './access.js';
import { isSecureHost, sessionCookie } from './cookie.js';
import type { PeopleService } from './people-service.js';
import { toMe, type StoredPerson } from './person.js';
import type { SessionService } from './session-service.js';

export interface SessionOpening {
  readonly people: PeopleService;
  readonly sessions: SessionService;
  readonly topics: () => readonly string[];
  /** The media library is on (KB_CHAT_MEDIA); off when not given. */
  readonly mediaEnabled?: boolean;
}

/** A new session cookie for `person` (ADR 0008), the same for Google and one-time codes. */
export async function openSession(
  deps: SessionOpening,
  person: StoredPerson,
  http: { readonly request: FastifyRequest; readonly reply: FastifyReply },
): Promise<Me> {
  const token = await deps.sessions.create(person.id);
  http.request.log.info({ personId: person.id }, 'signed in');
  http.reply.header(
    'set-cookie',
    sessionCookie(token, isSecureHost(http.request.headers.host)),
  );
  return toMe(deps.people.viewerOf(person), {
    topics: deps.topics(),
    media: deps.mediaEnabled ?? false,
    parentOf: parentOfRequest(http.request),
  });
}

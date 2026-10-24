import { hostnameOf } from '../../plugins/host-guard.js';
import { SESSION_TTL_MS } from './session-service.js';

export const SESSION_COOKIE = 'kbchat_session';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Secure everywhere except plain-HTTP localhost (ADR 0008). */
export const isSecureHost = (hostHeader: string | undefined): boolean =>
  !LOCAL_HOSTS.has(hostnameOf(hostHeader).toLowerCase());

/** The value of one cookie in a `Cookie` header. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name)
      return part.slice(at + 1).trim();
  }
  return undefined;
}

const attributes = (secure: boolean, maxAgeS: number): string =>
  [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');

export const sessionCookie = (token: string, secure: boolean): string =>
  `${SESSION_COOKIE}=${token}; ${attributes(secure, SESSION_TTL_MS / 1000)}`;

export const clearedSessionCookie = (secure: boolean): string =>
  `${SESSION_COOKIE}=; ${attributes(secure, 0)}`;

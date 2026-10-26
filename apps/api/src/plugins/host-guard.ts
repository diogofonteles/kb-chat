import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../app-error.js';

export interface HostGuardOptions {
  readonly allowedHosts: readonly string[];
}

/** "localhost:3000" → "localhost"; "[::1]:3000" → "[::1]". */
export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('['))
    return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

/** Refuses requests whose Host is not allowlisted, against DNS rebinding (ADR 0005). */
const hostGuard: FastifyPluginAsync<HostGuardOptions> = async (
  app,
  options,
) => {
  const allowed = new Set(
    options.allowedHosts.map((host) => host.toLowerCase()),
  );
  app.addHook('onRequest', async (request) => {
    if (!allowed.has(hostnameOf(request.headers.host).toLowerCase())) {
      throw new AppError('FORBIDDEN_HOST', 'Host not allowed');
    }
  });
};

export default fp(hostGuard, { name: 'host-guard' });

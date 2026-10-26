import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../app-error.js';

export interface CsrfGuardOptions {
  /** WEB_ORIGIN: the only origin allowed to change state. */
  readonly webOrigin: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF for the cookie session (ADR 0008, ND-23): every state-changing `/api/` request
 * carries `X-Requested-With: kb-chat`, which a cross-site form cannot set and CORS only
 * lets WEB_ORIGIN send, and a present `Origin` must be WEB_ORIGIN. The MCP turns live
 * outside `/api/` and authenticate with their turn token instead.
 */
const csrfGuard: FastifyPluginAsync<CsrfGuardOptions> = async (
  app,
  { webOrigin },
) => {
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith('/api/'))
      return;
    const origin = request.headers.origin;
    const header = request.headers[CSRF_HEADER];
    if (header !== CSRF_HEADER_VALUE || (origin && origin !== webOrigin))
      throw new AppError('CSRF_REJECTED', 'Cross-site request refused');
  });
};

export default fp(csrfGuard, { name: 'csrf-guard' });

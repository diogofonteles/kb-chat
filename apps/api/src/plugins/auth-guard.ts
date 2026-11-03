import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../app-error.js';
import {
  denialOf,
  resolveViewer,
  type ViewerSources,
} from '../modules/auth/index.js';

/**
 * The single access guard (ADR 0008, FR-4): reads the route's `config.access` and refuses
 * with 401 (no session), 404 (unseen collection) or 403 (feature or role). A route with
 * no declaration still needs a session; the route-coverage test keeps every one declared.
 */
const authGuard: FastifyPluginAsync<ViewerSources> = async (app, sources) => {
  app.decorateRequest('viewer', null);
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config.access ?? {};
    if (access.public) return;
    const resolved = await resolveViewer(request, sources);
    if (!resolved) throw new AppError('UNAUTHENTICATED', 'Sign in first');
    request.viewer = resolved.viewer;
    request.session = resolved.session;
    const denial = denialOf(access, resolved.viewer, request.params);
    if (denial) throw denial;
  });
  // A write while acting is audited before it runs (KBC-060 FR-4, NFR-2): also a route
  // that answers by streaming (research, SSE), which never reaches onSend.
  app.addHook('preHandler', async (request) => {
    const viewer = request.viewer;
    if (!viewer?.actor || !sources.actAs || SAFE.has(request.method)) return;
    if (ACTING_ITSELF.has(routeOf(request))) return;
    await sources.actAs.recordWrite(viewer, {
      method: request.method,
      route: routeOf(request),
    });
  });
};

/** Ending the acting is its own audit line ("end"), not a write. */
const ACTING_ITSELF = new Set(['/api/v1/act-as', '/api/v1/auth/logout']);

const routeOf = (request: FastifyRequest): string =>
  request.routeOptions.url ?? request.url;

/** Methods that read: not audited one by one (ADR 0027). */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export default fp(authGuard, { name: 'auth-guard' });

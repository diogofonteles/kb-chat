import type { FastifyPluginAsync } from 'fastify';
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
  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config.access ?? {};
    if (access.public) return;
    const viewer = await resolveViewer(request, sources);
    if (!viewer) throw new AppError('UNAUTHENTICATED', 'Sign in first');
    request.viewer = viewer;
    const denial = denialOf(access, viewer, request.params);
    if (denial) throw denial;
  });
};

export default fp(authGuard, { name: 'auth-guard' });

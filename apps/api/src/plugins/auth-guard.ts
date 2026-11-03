import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../app-error.js';
import { OWN_VIEW, VIEW_HEADER } from '@kb-chat/contracts';
import {
  denialOf,
  resolveViewer,
  type Viewer,
  type ViewerSources,
} from '../modules/auth/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** A write audited while acting (its refusal is audited too). */
    auditedWrite: boolean;
  }
  interface FastifyInstance {
    /** "METHOD /route" of every route only the person may use (KBC-060 BR-4). */
    personOnlyRoutes: ReadonlySet<string>;
  }
}

/**
 * The single access guard (ADR 0008, FR-4): reads the route's `config.access` and refuses
 * with 401 (no session), 404 (unseen collection) or 403 (feature or role). A route with
 * no declaration still needs a session; the route-coverage test keeps every one declared.
 */
const authGuard: FastifyPluginAsync<ViewerSources> = async (app, sources) => {
  app.decorateRequest('viewer', null);
  app.decorateRequest('session', null);
  app.decorateRequest('auditedWrite', false);
  registerPersonOnly(app);
  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config.access ?? {};
    if (access.public) return;
    const resolved = await resolveViewer(request, sources);
    if (!resolved) throw new AppError('UNAUTHENTICATED', 'Sign in first');
    request.viewer = resolved.viewer;
    request.session = resolved.session;
    const denial = denialOf(access, resolved.viewer, request.params);
    if (denial) throw denial;
    assertSameView(request, resolved.viewer);
  });
  registerActingAudit(app, sources);
};

/** The routes only the person may use, as declared (a test keeps the list honest). */
function registerPersonOnly(app: FastifyInstance): void {
  const personOnly = new Set<string>();
  app.decorate('personOnlyRoutes', personOnly);
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    if (!access || !('notWhileActing' in access)) return;
    for (const method of [route.method].flat().filter((m) => m !== 'HEAD'))
      personOnly.add(`${method} ${route.url}`);
  });
}

/**
 * A write while acting is audited before it runs (KBC-060 FR-4, NFR-2), also a route that
 * answers by streaming (research, SSE); one refused after that changed nothing, and the
 * audit says so.
 */
function registerActingAudit(
  app: FastifyInstance,
  sources: ViewerSources,
): void {
  const audited = (request: FastifyRequest) =>
    request.viewer?.actor !== undefined &&
    sources.actAs !== undefined &&
    !SAFE.has(request.method) &&
    !ACTING_ITSELF.has(routeOf(request));
  app.addHook('preHandler', async (request) => {
    if (!audited(request) || !request.viewer || !sources.actAs) return;
    await sources.actAs.recordWrite(request.viewer, {
      method: request.method,
      route: routeOf(request),
    });
    request.auditedWrite = true;
  });
  app.addHook('onResponse', async (request, reply) => {
    if (!request.auditedWrite || reply.statusCode < 400) return;
    if (!request.viewer || !sources.actAs) return;
    await sources.actAs.recordWrite(request.viewer, {
      method: request.method,
      route: routeOf(request),
      refused: true,
    });
  });
}

/**
 * A write from a tab that still shows another view (the person's after it ended, or the
 * master's after it started elsewhere) is refused before it runs (KBC-060 BR-3).
 */
function assertSameView(request: FastifyRequest, viewer: Viewer): void {
  if (SAFE.has(request.method)) return;
  const sent = request.headers[VIEW_HEADER];
  if (typeof sent !== 'string') return;
  const current = viewer.actor ? viewer.person.id : OWN_VIEW;
  if (sent !== current)
    throw new AppError('VIEW_CHANGED', 'This tab shows another view');
}

/** Ending the acting is its own audit line ("end"), not a write. */
const ACTING_ITSELF = new Set(['/api/v1/act-as', '/api/v1/auth/logout']);

const routeOf = (request: FastifyRequest): string =>
  request.routeOptions.url ?? request.url;

/** Methods that read: not audited one by one (ADR 0027). */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export default fp(authGuard, { name: 'auth-guard' });

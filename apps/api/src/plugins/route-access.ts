import type { FastifyPluginAsync, HTTPMethods } from 'fastify';
import fp from 'fastify-plugin';
import type { RouteAccess } from '../modules/auth/index.js';

export interface RouteAccessEntry {
  readonly method: HTTPMethods | HTTPMethods[];
  readonly url: string;
  readonly access: RouteAccess | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered after this plugin, with its declared access (NFR-2). */
    readonly routeAccess: readonly RouteAccessEntry[];
  }
}

const GUARDED_PREFIX = '/api/v1/';

/**
 * The fitness function of ADR 0008 (NFR-2): an `/api/v1` route without `config.access`
 * fails at registration, so the app does not even start; the table feeds the route test.
 */
const routeAccess: FastifyPluginAsync = async (app) => {
  const table: RouteAccessEntry[] = [];
  app.decorate('routeAccess', table);
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    if (route.url.startsWith(GUARDED_PREFIX) && access === undefined)
      throw new Error(
        `${String(route.method)} ${route.url} declares no config.access (ADR 0008)`,
      );
    table.push({ method: route.method, url: route.url, access });
  });
};

export default fp(routeAccess, { name: 'route-access' });

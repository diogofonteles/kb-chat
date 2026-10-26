import type { Feature } from '@kb-chat/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../app-error.js';
import { canSeeTopic, hasFeature, isMaster, type Viewer } from './person.js';

/**
 * What a route requires (ADR 0008), declared in its `config.access`; the auth guard is the
 * only place that enforces it. `{}` means a signed-in person.
 */
export type RouteAccess =
  | { readonly public: true }
  | {
      readonly public?: never;
      /** The route param naming a collection: one the person cannot see is 404. */
      readonly topicParam?: 'topic';
      readonly feature?: Feature;
      readonly master?: true;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyRequest {
    /** The signed-in person, set by the auth guard; null on public routes. */
    viewer: Viewer | null;
  }
}

/** Health, login and the token-authenticated MCP turns. */
export const PUBLIC: RouteAccess = { public: true };
export const SIGNED_IN: RouteAccess = {};

const topicOf = (params: unknown, name: string): unknown =>
  typeof params === 'object' && params !== null
    ? (params as Record<string, unknown>)[name]
    : undefined;

/**
 * Why the viewer may not use the route, or null: an unseen collection is 404 (it is not
 * even confirmed to exist), then a missing feature or role is 403.
 */
export function denialOf(
  access: RouteAccess,
  viewer: Viewer,
  params: unknown,
): AppError | null {
  if (access.public) return null;
  if (access.topicParam) {
    const topic = topicOf(params, access.topicParam);
    if (typeof topic !== 'string' || !canSeeTopic(viewer.person, topic))
      return new AppError('TOPIC_NOT_FOUND', 'Unknown topic');
  }
  if (access.master && !isMaster(viewer.person))
    return new AppError('FORBIDDEN', 'Only a master may do this');
  if (access.feature && !hasFeature(viewer.person, access.feature))
    return new AppError('FORBIDDEN', 'This feature is not enabled');
  return null;
}

/** The signed-in person of a request behind the guard. */
export function viewerOf(request: FastifyRequest): Viewer {
  if (!request.viewer) throw new AppError('UNAUTHENTICATED', 'Sign in first');
  return request.viewer;
}

export const principalOf = (request: FastifyRequest): string =>
  viewerOf(request).principal;

/** A check inside a route whose body decides the feature (PUT /settings with `ai`). */
export function assertFeature(request: FastifyRequest, feature: Feature): void {
  if (!hasFeature(viewerOf(request).person, feature))
    throw new AppError('FORBIDDEN', 'This feature is not enabled');
}

export const canSee = (request: FastifyRequest, topic: string): boolean =>
  canSeeTopic(viewerOf(request).person, topic);

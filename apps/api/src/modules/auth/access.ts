import type { StoredSession } from '../../ports/session-store.js';
import type { Feature } from '@kb-chat/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../app-error.js';
import {
  NO_PARENT,
  canSeeTopic,
  hasFeature,
  isMaster,
  type ParentOf,
  type Viewer,
} from './person.js';

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
      /** A feature, or several that are all needed (KBC-051: the library needs `media` too). */
      readonly feature?: Feature | readonly Feature[];
      readonly master?: true;
      /** Only the person may do this, never a master acting as them (KBC-060 BR-4). */
      readonly notWhileActing?: true;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyInstance {
    /** The collection tree (ADR 0028): access to a parent reaches its sub-collections. */
    topicParentOf?: ParentOf;
    /** What access levels decide around a person (KBC-103, ADR 0036); none: no levels. */
    levelHooks?: LevelHooks;
  }
  interface FastifyRequest {
    /** The signed-in person, set by the auth guard; null on public routes. */
    viewer: Viewer | null;
    /** The session the request came with (KBC-060: acting lives on it). */
    session: StoredSession | null;
  }
}

/** What the access-levels module answers to the routes that are not its own (KBC-103). */
export interface LevelHooks {
  /** FR-8: the person's level code per top-level collection with a scale they see. */
  codesOf(person: Viewer['person'], parentOf: ParentOf): Record<string, string>;
  /** BR-10: research and media of a scaled collection stay with masters until KBC-104/105. */
  closedUntilLevelsReachIt(person: Viewer['person'], topic: string): boolean;
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
/** What the route was asked about: its params, and the collection tree (ADR 0028). */
export interface AccessTarget {
  readonly params: unknown;
  readonly parentOf?: ParentOf;
}

export function denialOf(
  access: RouteAccess,
  viewer: Viewer,
  { params, parentOf = NO_PARENT }: AccessTarget,
): AppError | null {
  if (access.public) return null;
  if (access.notWhileActing && viewer.actor)
    return new AppError('NOT_WHILE_ACTING', 'Only the person may do this');
  if (access.topicParam) {
    const topic = topicOf(params, access.topicParam);
    if (
      typeof topic !== 'string' ||
      !canSeeTopic(viewer.person, topic, parentOf)
    )
      return new AppError('TOPIC_NOT_FOUND', 'Unknown topic');
  }
  if (access.master && !isMaster(viewer.person))
    return new AppError('FORBIDDEN', 'Only a master may do this');
  if (!hasFeatures(viewer.person, access.feature))
    return new AppError('FORBIDDEN', 'This feature is not enabled');
  return null;
}

/** True when the person has every feature the route names (none named: true). */
function hasFeatures(
  person: Viewer['person'],
  feature: Feature | readonly Feature[] | undefined,
): boolean {
  if (feature === undefined) return true;
  const needed: readonly Feature[] =
    typeof feature === 'string' ? [feature] : feature;
  return needed.every((one) => hasFeature(person, one));
}

/** The signed-in person of a request behind the guard. */
export function viewerOf(request: FastifyRequest): Viewer {
  if (!request.viewer) throw new AppError('UNAUTHENTICATED', 'Sign in first');
  return request.viewer;
}

export const principalOf = (request: FastifyRequest): string =>
  viewerOf(request).principal;

/** Inside a route: refuses what only the person may do while a master acts as them. */
export function assertNotActing(request: FastifyRequest): void {
  if (viewerOf(request).actor)
    throw new AppError('NOT_WHILE_ACTING', 'Only the person may do this');
}

/** The session of a request behind the guard. */
export function sessionOf(request: FastifyRequest): StoredSession {
  if (!request.session) throw new AppError('UNAUTHENTICATED', 'Sign in first');
  return request.session;
}

/** A check inside a route whose body decides the feature (PUT /settings with `ai`). */
export function assertFeature(request: FastifyRequest, feature: Feature): void {
  if (!hasFeature(viewerOf(request).person, feature))
    throw new AppError('FORBIDDEN', 'This feature is not enabled');
}

export const canSee = (request: FastifyRequest, topic: string): boolean =>
  canSeeTopic(viewerOf(request).person, topic, parentOfRequest(request));

/** The tree the app registered, or none (exact grants only). */
export const parentOfRequest = (request: FastifyRequest): ParentOf =>
  request.server.topicParentOf ?? NO_PARENT;

/** The person's level codes for `/me` (KBC-103 FR-8). */
export const levelCodesOf = (request: FastifyRequest): Record<string, string> =>
  request.server.levelHooks?.codesOf(
    viewerOf(request).person,
    parentOfRequest(request),
  ) ?? {};

/**
 * The media of a collection the person may reach: one they see, and, in a collection with
 * levels, only for masters until media carries a level (KBC-103 BR-10, KBC-105).
 */
export function canSeeMedia(request: FastifyRequest, topic: string): boolean {
  const hooks = request.server.levelHooks;
  // Without the levels' answer nothing is known to be open (fail-closed).
  if (!hooks) throw new Error('The level hooks are not registered');
  return (
    canSee(request, topic) &&
    !hooks.closedUntilLevelsReachIt(viewerOf(request).person, topic)
  );
}

/**
 * BR-10: AI research in a collection with levels waits for KBC-104; without the levels'
 * answer it fails rather than open (fail-closed).
 */
export function assertResearchOpen(
  request: FastifyRequest,
  topic: string,
): void {
  const hooks = request.server.levelHooks;
  if (!hooks) throw new Error('The level hooks are not registered');
  if (hooks.closedUntilLevelsReachIt(viewerOf(request).person, topic))
    throw new AppError('LEVELS_PENDING', 'Research waits for levels here');
}

/**
 * BR-10: in a collection the person sees whose media waits for levels (KBC-105), whatever
 * reaches its media (adding, listing its subjects or speakers) answers LEVELS_PENDING, the
 * same for every name, so nothing in it is confirmed.
 */
export function assertMediaOpen(request: FastifyRequest, topic: string): void {
  if (canSee(request, topic) && !canSeeMedia(request, topic))
    throw new AppError('LEVELS_PENDING', 'Media waits for levels here');
}

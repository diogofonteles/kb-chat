import type { FastifyRequest } from 'fastify';
import { parentOfRequest, viewerOf } from '../auth/index.js';
import type { ContentGate } from './content-gate.js';
import type { LevelView } from './level-view.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The content gate (KBC-103, ADR 0036 §7), decorated by the composition root. */
    contentGate?: ContentGate;
  }
}

/**
 * The signed-in person's view of `topic` (the one a master acts as, while acting). An app
 * built without the gate fails the request rather than answer open (fail-closed).
 */
export function levelViewOf(request: FastifyRequest, topic: string): LevelView {
  const gate = request.server.contentGate;
  if (!gate) throw new Error('The content gate is not registered');
  return gate.viewFor(viewerOf(request).person, topic);
}

/** One view per top-level collection, for a request that spans several (the topic list). */
export function levelViewsOf(
  request: FastifyRequest,
): (topic: string) => LevelView {
  const views = new Map<string, LevelView>();
  return (topic) => {
    const known = views.get(topic);
    if (known) return known;
    const view = levelViewOf(request, topic);
    views.set(topic, view);
    return view;
  };
}

/**
 * The signed-in person's view of what they stored in `topic` (KBC-110): closed when they no
 * longer see the collection at all, else today's view.
 */
export function storedLevelViewOf(
  request: FastifyRequest,
  topic: string,
): LevelView {
  const gate = request.server.contentGate;
  if (!gate) throw new Error('The content gate is not registered');
  return gate.storedViewFor(
    viewerOf(request).person,
    topic,
    parentOfRequest(request),
  );
}

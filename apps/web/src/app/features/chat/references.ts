import type { MediaHit, SearchHit } from '@kb-chat/contracts';

/** One line of the results: a document card or a spoken passage (KBC-039 FR-6). */
export type Reference =
  | { readonly kind: 'text'; readonly key: string; readonly hit: SearchHit }
  | { readonly kind: 'audio'; readonly key: string; readonly hit: MediaHit };

/** A spoken passage's identity: its media and where it starts. */
export const passageKey = (
  hit: Pick<MediaHit, 'mediaId' | 'startMs'>,
): string => `${hit.mediaId}@${hit.startMs}`;

/**
 * Documents and passages mixed by relevance (both scored 0–1): each keeps its own order
 * (the passages' puts normal confidence first, BR-3), and a passage goes before the first
 * document it outscores.
 */
export function mixReferences(
  items: readonly SearchHit[],
  media: readonly MediaHit[],
): Reference[] {
  const passages = media.map(toPassage);
  const mixed: Reference[] = [];
  for (const hit of items) {
    mixed.push(...takeWhileAbove(passages, hit.score));
    mixed.push({ kind: 'text', key: `text:${hit.topic}:${hit.id}`, hit });
  }
  return [...mixed, ...passages];
}

/** Removes and returns the passages at the head that outscore `score`. */
function takeWhileAbove(passages: Reference[], score: number): Reference[] {
  let count = 0;
  while (count < passages.length && passageScore(passages[count]) > score)
    count++;
  return passages.splice(0, count);
}

const toPassage = (hit: MediaHit): Reference => ({
  kind: 'audio',
  key: `audio:${passageKey(hit)}`,
  hit,
});

const passageScore = (reference: Reference | undefined): number =>
  reference?.kind === 'audio' ? reference.hit.score : 0;

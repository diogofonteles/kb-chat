import type { SearchHit } from '@kb-chat/contracts';
import type { TrackLinksPort } from '../../ports/media-search.js';
import { excerptOf, passageScore, unmark } from './media-hits.js';

/**
 * One card per track (KBC-101 BR-8, FR-9): a track's card on the page carries the passage
 * where the words are said, as the "Na fala" card would have shown it (its minute and its
 * sentence with the words marked), and the better of the two scores. A track whose speech
 * does not hold the words keeps the passage of its index snippet.
 */
export function withSpokenPassages(
  items: readonly SearchHit[],
  {
    passages,
    terms,
  }: {
    readonly passages: Pick<TrackLinksPort, 'bestPassages'>;
    readonly terms: readonly string[];
  },
): SearchHit[] {
  const ids = items.flatMap((item) => (item.media ? [item.media.mediaId] : []));
  const best = new Map(
    passages.bestPassages(terms, ids).map((match) => [match.mediaId, match]),
  );
  return items.map((item) => {
    const match = item.media && best.get(item.media.mediaId);
    if (!item.media || !match) return item;
    return {
      ...item,
      score: Math.max(item.score, passageScore(match.marked)),
      media: {
        ...item.media,
        startMs: match.startMs,
        endMs: match.endMs,
        spoken: excerptOf(unmark(match.marked)),
      },
    };
  });
}

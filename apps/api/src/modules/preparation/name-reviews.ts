import type { NameReview, VoiceLabel } from '@kb-chat/contracts';
import type { VoiceText } from '../../ports/track-proposal-store.js';
import { mentionsName } from '../media-edit/index.js';

/**
 * The titles a wrong name may still be in (KBC-090): a one-word name, what a person wrote and a
 * refused name are never rewritten, so a person looks at them before they are published.
 */
export function nameReviewsOf(input: {
  readonly texts: readonly VoiceText[];
  readonly labels: readonly Pick<VoiceLabel, 'voice' | 'name' | 'kind'>[];
  readonly refused: readonly number[];
  readonly tracks: readonly {
    readonly id: string;
    readonly title: string | null;
  }[];
}): NameReview[] {
  const { texts, labels, refused, tracks } = input;
  return texts.flatMap(({ voice, name, written }) => {
    const label = labels.find((one) => one.voice === voice);
    const given = label?.kind === 'person' ? label.name : null;
    const isRefused = refused.includes(voice);
    if (!isRefused && (given === null || given === name)) return [];
    const wrong = isRefused ? (written ?? name) : name;
    const mentioned = tracks.flatMap(({ id, title }) =>
      title !== null && mentionsName(title, wrong, given)
        ? [{ id, title }]
        : [],
    );
    return mentioned.length > 0
      ? [{ voice, name: wrong, tracks: mentioned }]
      : [];
  });
}

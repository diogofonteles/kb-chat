import {
  holdsName,
  mentionsName,
  type NameReview,
  type VoiceLabel,
} from '@kb-chat/contracts';
import type { VoiceText } from '../../ports/track-proposal-store.js';

interface ReviewTrack {
  readonly id: string;
  readonly title: string | null;
}

/** The tracks whose title still says one of the wrong names, in their order. */
function saying(
  tracks: readonly ReviewTrack[],
  wrongs: readonly string[],
  right: string | null,
): { name: string; tracks: { id: string; title: string }[] } | null {
  const says = (title: string, wrong: string) =>
    mentionsName(title, wrong, right);
  const name = wrongs.find((wrong) =>
    tracks.some(({ title }) => title !== null && says(title, wrong)),
  );
  if (name === undefined) return null;
  return {
    name,
    tracks: tracks.flatMap(({ id, title }) =>
      title !== null && wrongs.some((wrong) => says(title, wrong))
        ? [{ id, title }]
        : [],
    ),
  };
}

/**
 * The titles a wrong name may still be in (KBC-090): a one-word name, what a person wrote, a
 * title the right name did not fit in and a refused name are never rewritten, so a person looks
 * at them before they are published. Both the suggested name and the one last written may be in
 * the text; one review per voice, named by the wrong name the titles say. A name a person gave
 * a voice, or part of one, is never wrong: those titles say who someone is (KBC-102).
 */
export function nameReviewsOf(input: {
  readonly texts: readonly VoiceText[];
  readonly labels: readonly Pick<VoiceLabel, 'voice' | 'name' | 'kind'>[];
  readonly refused: readonly number[];
  readonly tracks: readonly ReviewTrack[];
}): NameReview[] {
  const { texts, labels, refused, tracks } = input;
  const names = labels.flatMap(({ kind, name }) =>
    kind === 'person' && name !== null ? [name] : [],
  );
  return texts.flatMap(({ voice, name, written }) => {
    const label = labels.find((one) => one.voice === voice);
    const given = label?.kind === 'person' ? label.name : null;
    // What the words should say: nothing for a refused name, else the name given or suggested.
    const right = refused.includes(voice) ? null : (given ?? name);
    const wrongs = [...new Set([written ?? name, name])].filter(
      (one) => one !== right && !names.some((given) => holdsName(given, one)),
    );
    const review = saying(tracks, wrongs, right);
    return review ? [{ voice, ...review }] : [];
  });
}

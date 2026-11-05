import type { VoiceSuggestion } from '@kb-chat/contracts';
import type { MediaEditStorePort } from '../../ports/media-edit-store.js';
import type { StoredVoiceLabel } from '../../ports/speaker-store.js';

export interface VoiceNameFixerDeps {
  readonly suggestions: (mediaId: string) => readonly VoiceSuggestion[];
  /** The names of the newest separation; empty before one. */
  readonly labels: (mediaId: string) => readonly StoredVoiceLabel[];
  readonly edits: Pick<MediaEditStorePort, 'rewriteProposedTexts'>;
  readonly now?: () => Date;
}

/** A name as a whole, not a piece of a longer word; any case, as a title may set it. */
const nameIn = (name: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}])`,
    'giu',
  );

/** The text with a wrong name changed; as it was when the right one would not fit. */
export function withNameFixed(
  text: string,
  { from, to }: NameFix,
  max: number,
): string {
  const fixed = text.replace(nameIn(from), () => to);
  return fixed.length <= max ? fixed : text;
}

/** A wrong name and the one a person gave. */
export interface NameFix {
  readonly from: string;
  readonly to: string;
}

/** Where a suggested name lost to the one a person gave; never another voice's own name. */
export function fixesOf(
  suggestions: readonly VoiceSuggestion[],
  labels: readonly StoredVoiceLabel[],
): NameFix[] {
  const given = new Map(
    labels.flatMap((label) =>
      label.speaker ? [[label.voice, label.speaker.name] as const] : [],
    ),
  );
  const standing = new Set(given.values());
  return suggestions.flatMap(({ voice, name }) => {
    const to = given.get(voice);
    if (!name || !to || name === to || standing.has(name)) return [];
    return [{ from: name, to }];
  });
}

/**
 * The AI writes a name it suggests into the text of its tracks, as plain words: who asks and
 * who answers follow the voice by themselves, these do not. Once a person says who the voice
 * is, the text follows. It starts from what the run suggested against what a person gave, so
 * it needs no record of its own, can run any number of times, and also reaches the windows
 * of a run still going, which keep writing the old name (KBC-090).
 */
export class VoiceNameFixer {
  private readonly now: () => Date;

  constructor(private readonly deps: VoiceNameFixerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  fix(mediaId: string): void {
    const fixes = fixesOf(
      this.deps.suggestions(mediaId),
      this.deps.labels(mediaId),
    );
    if (fixes.length === 0) return;
    this.deps.edits.rewriteProposedTexts({
      mediaId,
      rewrite: (text, max) =>
        fixes.reduce((now, fix) => withNameFixed(now, fix, max), text),
      now: this.now(),
    });
  }
}

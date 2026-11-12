import { TRACK_TITLE_MAX, nameIn } from '@kb-chat/contracts';
import type { MediaEditStorePort } from '../../ports/media-edit-store.js';
import type { StoredVoiceLabel } from '../../ports/speaker-store.js';
import type {
  TrackProposalStorePort,
  VoiceText,
} from '../../ports/track-proposal-store.js';
import type {
  ChangeAuthor,
  TrackRevisionStorePort,
} from '../../ports/track-revision-store.js';

export interface VoiceNameFixerDeps {
  readonly proposals: Pick<
    TrackProposalStorePort,
    'voiceTexts' | 'markWritten'
  >;
  /** The names of the newest separation; empty before one. */
  readonly labels: (mediaId: string) => readonly StoredVoiceLabel[];
  /** The voices whose suggested name a person refused. */
  readonly refused: (mediaId: string) => readonly number[];
  readonly edits: Pick<
    MediaEditStorePort,
    | 'edit'
    | 'proposedTrackIds'
    | 'rewriteProposedDraft'
    | 'rewriteSuggestedSummaries'
  >;
  readonly revisions: Pick<
    TrackRevisionStorePort,
    'atomically' | 'tracks' | 'renameProposed' | 'record' | 'touch'
  >;
  readonly now?: () => Date;
}

/** A wrong name and the one that takes its place. */
export interface NameFix {
  readonly from: string;
  readonly to: string;
}

/** A single word can be anyone ("São Pedro"): it never decides a rewrite. */
const isFullName = (name: string): boolean => /\s/u.test(name.trim());

/** The text with the wrong name changed; as it was when nothing or nothing that fits would. */
export function withNameFixed(
  text: string,
  { from, to }: NameFix,
  max: number,
): string {
  const normal = text.normalize('NFC');
  const wanted = to.normalize('NFC');
  // "Márcio da Rós" holding the old "Márcio da": what is already right is left out.
  const pieces = nameIn(from).test(wanted)
    ? normal.split(new RegExp(`(${nameIn(wanted).source})`, 'giu'))
    : [normal];
  const fixed = pieces
    .map((piece, index) =>
      index % 2 === 1 ? piece : piece.replace(nameIn(from), () => wanted),
    )
    .join('');
  return fixed === normal || fixed.length > max ? text : fixed;
}

/** Every voice's correction: what its words may say now and what they should. */
export function fixesOf(input: {
  readonly texts: readonly VoiceText[];
  readonly labels: readonly StoredVoiceLabel[];
  readonly refused: readonly number[];
}): (NameFix & { readonly text: VoiceText })[] {
  const { texts, labels, refused } = input;
  const given = new Map(
    labels.flatMap((label) =>
      label.speaker ? [[label.voice, label.speaker.name] as const] : [],
    ),
  );
  const others = new Set(given.values());
  return texts.flatMap((text) => {
    const { voice, name, written } = text;
    const audience = labels.some((one) => one.voice === voice && one.audience);
    if (!isFullName(name) || audience || refused.includes(voice)) return [];
    const to = given.get(voice) ?? name;
    return [...new Set([written ?? name, name])]
      .filter((from) => from !== to && isFullName(from) && !others.has(from))
      .map((from) => ({ from, to, text }));
  });
}

/**
 * The AI writes a name it suggests into its titles as plain words: who asks and who answers
 * follow the voice, these do not. Once a person says who the voice is, the words follow, by
 * these rules: only what the AI wrote and no person touched, only the whole suggested name, and
 * never a one-word name, which may be someone else (those tracks go to the person's review).
 * What was written is recorded only when some text changed, so a second correction or an undo
 * starts from what the text says. A published
 * title changes as any other change of a track: with its history and a new version.
 */
export class VoiceNameFixer {
  private readonly now: () => Date;

  constructor(private readonly deps: VoiceNameFixerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** `author` is who corrected: a run writing its windows has none and changes no publication. */
  fix(mediaId: string, author: ChangeAuthor | null): void {
    const { proposals, labels, refused, revisions } = this.deps;
    const fixes = fixesOf({
      texts: proposals.voiceTexts(mediaId),
      labels: labels(mediaId),
      refused: refused(mediaId),
    });
    if (fixes.length === 0) return;
    // Only a fix that changed some text moves what was written: one that changed nothing (a
    // one-word name, a title it does not fit in) leaves the words the text still says.
    const applied = new Set<number>();
    const rewrite = (text: string, max: number) =>
      fixes.reduce((now, fix, index) => {
        const next = withNameFixed(now, fix, max);
        if (next !== now) applied.add(index);
        return next;
      }, text);
    revisions.atomically(() => {
      this.rewriteTitles(mediaId, { rewrite, author });
      this.deps.edits.rewriteSuggestedSummaries(mediaId, rewrite);
      for (const { text, to } of fixes.filter((_, at) => applied.has(at)))
        proposals.markWritten(text.runId, text.voice, to);
    });
  }

  private rewriteTitles(
    mediaId: string,
    input: {
      readonly rewrite: (text: string, max: number) => string;
      readonly author: ChangeAuthor | null;
    },
  ): void {
    const { rewrite, author } = input;
    const { edits } = this.deps;
    if (edits.edit(mediaId)?.status !== 'approved')
      edits.rewriteProposedDraft({ mediaId, rewrite, now: this.now() });
    else if (author) this.revisePublished(mediaId, { rewrite, author });
  }

  private revisePublished(
    mediaId: string,
    input: {
      readonly rewrite: (text: string, max: number) => string;
      readonly author: ChangeAuthor;
    },
  ): void {
    const { rewrite, author } = input;
    const { edits, revisions } = this.deps;
    const proposed = edits.proposedTrackIds(mediaId);
    for (const track of revisions.tracks(mediaId)) {
      if (!proposed.has(track.trackId)) continue;
      const after = rewrite(track.title, TRACK_TITLE_MAX);
      if (after === track.title) continue;
      revisions.renameProposed(track, after, author.now);
      revisions.record(
        track.mediaId,
        [{ field: 'title', before: track.title, after }],
        author,
      );
      revisions.touch(track.mediaId);
    }
  }
}

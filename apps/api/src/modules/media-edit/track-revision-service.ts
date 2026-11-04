import { randomUUID } from 'node:crypto';
import {
  TRACK_RESTORE_MS,
  timingProblems,
  type ArchivedTracks,
  type Author,
  type MediaItem,
  type MovedBookmarks,
  type TrackBoundsRequest,
  type TrackEditView,
  type TrackHistory,
  type TrackImpact,
  type TrackPatch,
  type TrackProblem,
  type TrackSpeaker,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { DiarizationStorePort } from '../../ports/diarization-store.js';
import type { MediaEditStorePort } from '../../ports/media-edit-store.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type {
  SpeakerStorePort,
  VoiceLabelStorePort,
} from '../../ports/speaker-store.js';
import type {
  ChangeAuthor,
  NewChange,
  RevisableTrack,
  TrackRevisionStorePort,
  TrackRole,
} from '../../ports/track-revision-store.js';
import type { TrackSubjectStorePort } from '../../ports/track-subject-store.js';
import type {
  MediaActor,
  TrackCall,
  VoiceNamesService,
} from '../media/index.js';
import type { TrackPublisher } from './track-publisher.js';

export interface TrackRevisionDeps {
  readonly revisions: TrackRevisionStorePort;
  readonly publisher: Pick<
    TrackPublisher,
    'afterRecordingEdit' | 'afterRestore' | 'retryCuts'
  >;
  readonly edits: Pick<MediaEditStorePort, 'edit'>;
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  readonly files: Pick<MediaFilesPort, 'remove'>;
  readonly summaries: Pick<TrackSubjectStorePort, 'read' | 'writeSummary'>;
  readonly speakers: Pick<SpeakerStorePort, 'get' | 'list'>;
  readonly diarizations: Pick<DiarizationStorePort, 'latest'>;
  readonly voiceLabels: Pick<VoiceLabelStorePort, 'labels'>;
  readonly names: Pick<VoiceNamesService, 'name'>;
  /** The item as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => MediaItem;
  readonly rootOf: (topic: string) => string;
  readonly authorOf: (topic: string, slug: string) => Author | null;
  readonly now?: () => Date;
}

const ROLES: readonly TrackRole[] = ['asker', 'answerer'];

/** How long a replaced cut stays for who is on it (BR-3). */
const OLD_CUT_MS = 24 * 60 * 60 * 1000;

const stale = () =>
  new AppError('EDIT_STALE', 'Someone else changed this track');

const conflict = (reason: string, message: string) =>
  new AppError('MEDIA_CONFLICT', message, { details: { reason } });

const invalid = (problems: readonly TrackProblem[]) =>
  new AppError('TRACKS_INVALID', 'These bounds cannot be kept', {
    details: { problems },
  });

const speakerIdOf = (track: RevisableTrack, role: TrackRole) =>
  role === 'asker' ? track.askerSpeakerId : track.answererSpeakerId;

const voiceOf = (track: RevisableTrack, role: TrackRole) =>
  role === 'asker' ? track.askerVoice : track.answererVoice;

const askedOf = (patch: TrackPatch, role: TrackRole) =>
  role === 'asker' ? patch.askerSpeakerId : patch.answererSpeakerId;

const boundsText = ({ startMs, endMs }: { startMs: number; endMs: number }) =>
  `${startMs}-${endMs}`;

/**
 * Changing a track after its approval (KBC-073): its details on the same id, its bounds through
 * a new cut, its archive, and the record of all that. A recording whose edit is open is left
 * alone: its next approval replaces every row this writes.
 */
export class TrackRevisionService {
  private readonly now: () => Date;

  constructor(private readonly deps: TrackRevisionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  read(actor: MediaActor, mediaId: string): TrackEditView {
    const { record, track } = this.live(actor, mediaId);
    const parent = this.parentOf(track.parentId);
    const [stored] = this.deps.summaries.read([mediaId]);
    return {
      mediaId,
      recordingId: parent.id,
      recordingTitle: parent.title,
      topic: parent.topic,
      version: record.track?.version ?? 0,
      title: track.title,
      summary: stored?.summary ?? null,
      ordinal: track.ordinal,
      startMs: track.startMs,
      endMs: track.endMs,
      recordingDurationMs: parent.durationMs ?? track.endMs,
      asker: this.speakerOf(track, 'asker', parent),
      answerer: this.speakerOf(track, 'answerer', parent),
      cut: track.cut,
      locked: this.deps.edits.edit(parent.id)?.status !== 'approved',
      tracks: this.deps.revisions.tracks(parent.id).map((one) => ({
        id: one.mediaId,
        ordinal: one.ordinal,
        title: one.title,
        startMs: one.startMs,
        endMs: one.endMs,
      })),
    };
  }

  patch(call: TrackCall, patch: TrackPatch): void {
    const { track } = this.writable(call.actor, call.mediaId);
    const author = this.authorOf(call.actor);
    const { revisions, publisher } = this.deps;
    const scope = patch.scope ?? 'track';
    revisions.atomically(() => {
      if (!revisions.bump(call.mediaId, call.expectedVersion)) throw stale();
      const changes = [
        ...this.renamed(track, patch),
        ...this.summarized(call, patch),
      ];
      revisions.record(call.mediaId, changes, author);
      for (const role of ROLES) this.applySpeaker({ call, track, role, patch, scope, author });
      publisher.afterRecordingEdit(track.parentId);
    });
  }

  private renamed(track: RevisableTrack, patch: TrackPatch): NewChange[] {
    const { title } = patch;
    if (title === undefined || title === track.title) return [];
    this.deps.revisions.rename(track, title, this.now());
    return [{ field: 'title', before: track.title, after: title }];
  }

  private summarized(call: TrackCall, patch: TrackPatch): NewChange[] {
    const { summary } = patch;
    if (summary === undefined) return [];
    const [stored] = this.deps.summaries.read([call.mediaId]);
    const before = stored?.summary ?? null;
    if (before === summary) return [];
    this.deps.summaries.writeSummary({
      mediaId: call.mediaId,
      summary,
      principal: call.actor.principal,
      now: this.now(),
    });
    return [{ field: 'summary', before, after: summary }];
  }

  private applySpeaker(input: {
    readonly call: TrackCall;
    readonly track: RevisableTrack;
    readonly role: TrackRole;
    readonly patch: TrackPatch;
    readonly scope: 'track' | 'recording';
    readonly author: ChangeAuthor;
  }): void {
    const { track, role, patch, scope } = input;
    const speakerId = askedOf(patch, role);
    if (speakerId === undefined) return;
    if (speakerId === speakerIdOf(track, role)) return;
    this.assertOwnSpeaker(track.parentId, speakerId);
    if (scope === 'recording') this.nameVoice(input, speakerId);
    else this.nameHere(input, speakerId);
  }

  private nameHere(
    input: {
      readonly track: RevisableTrack;
      readonly role: TrackRole;
      readonly author: ChangeAuthor;
    },
    speakerId: string | null,
  ): void {
    const { track, role, author } = input;
    const { revisions } = this.deps;
    const parent = this.parentOf(track.parentId);
    const before = this.speakerOf(track, role, parent).name;
    revisions.setSpeaker(track, { role, speakerId });
    const moved = revisions.track(track.mediaId);
    const after = moved && this.speakerOf(moved, role, parent).name;
    revisions.record(
      track.mediaId,
      [{ field: role, before, after: after ?? null }],
      author,
    );
  }

  /** The voice's name, and every track that followed it (FR-1); a track's own choice stays. */
  private nameVoice(
    input: {
      readonly call: TrackCall;
      readonly track: RevisableTrack;
      readonly role: TrackRole;
      readonly author: ChangeAuthor;
    },
    speakerId: string | null,
  ): void {
    const { call, track, role, author } = input;
    const voice = voiceOf(track, role);
    const latest = this.deps.diarizations.latest(track.parentId);
    if (voice === null || !latest)
      throw conflict('no-voice', 'This track has no voice to name');
    const parent = this.parentOf(track.parentId);
    const named = this.labelsOf(track.parentId);
    const before = this.deps.revisions
      .tracks(track.parentId)
      .map((one) => ({ one, shown: this.shownNames(one, parent) }));
    this.deps.names.name(
      call.actor,
      { mediaId: track.parentId, voice },
      { version: latest.version, speakerId, audience: false },
    );
    this.deps.revisions.setSpeaker(track, { role, speakerId: null });
    this.deps.revisions.followVoice({
      parentId: track.parentId,
      voice,
      former: named.get(voice) ?? null,
    });
    for (const { one, shown } of before)
      this.recordNames({ track: one, shown, parent, author });
  }

  private shownNames(track: RevisableTrack, parent: MediaRecord) {
    return {
      asker: this.speakerOf(track, 'asker', parent).name,
      answerer: this.speakerOf(track, 'answerer', parent).name,
    };
  }

  /** Who this write changed: the history of each, and their open forms are old now. */
  private recordNames(input: {
    readonly track: RevisableTrack;
    readonly shown: Readonly<Record<TrackRole, string | null>>;
    readonly parent: MediaRecord;
    readonly author: ChangeAuthor;
  }): void {
    const { track, shown, parent, author } = input;
    const { revisions } = this.deps;
    const current = revisions.track(track.mediaId);
    if (!current) return;
    const now = this.shownNames(current, parent);
    const changes = ROLES.flatMap((role): NewChange[] =>
      shown[role] === now[role]
        ? []
        : [{ field: role, before: shown[role], after: now[role] }],
    );
    if (changes.length === 0) return;
    revisions.record(track.mediaId, changes, author);
    revisions.touch(track.mediaId);
  }

  /** "Ajustar início e fim" (FR-2): the cut runs on the worker, the file changes when it lands. */
  bounds(call: TrackCall, asked: TrackBoundsRequest): TrackEditView {
    const { track } = this.writable(call.actor, call.mediaId);
    if (track.cut === 'running')
      throw conflict('cut-running', 'A cut of this track is on its way');
    this.assertFits(track, asked);
    if (track.startMs === asked.startMs && track.endMs === asked.endMs)
      return this.read(call.actor, call.mediaId);
    const { revisions } = this.deps;
    revisions.atomically(() => {
      if (!revisions.bump(call.mediaId, call.expectedVersion)) throw stale();
      revisions.moveBounds({
        track,
        ...asked,
        jobId: randomUUID(),
        now: this.now(),
      });
      revisions.record(
        call.mediaId,
        [
          {
            field: 'bounds',
            before: boundsText(track),
            after: boundsText(asked),
          },
        ],
        this.authorOf(call.actor),
      );
    });
    return this.read(call.actor, call.mediaId);
  }

  /** The rules of the bar again: the client's check is a courtesy (BR-5, AC-6). */
  private assertFits(track: RevisableTrack, asked: TrackBoundsRequest): void {
    const parent = this.parentOf(track.parentId);
    const others = this.deps.revisions
      .tracks(track.parentId)
      .filter((one) => one.mediaId !== track.mediaId)
      .map((one) => ({
        id: one.trackId,
        startMs: one.startMs,
        endMs: one.endMs,
      }));
    const problems = timingProblems(
      [...others, { id: track.trackId, ...asked }],
      parent.durationMs,
    );
    if (problems.length > 0) throw invalid(problems);
  }

  retryCut(call: TrackCall): TrackEditView {
    const { record, track } = this.writable(call.actor, call.mediaId);
    if (record.track?.version !== call.expectedVersion) throw stale();
    if (track.cut !== 'failed' || !this.deps.publisher.retryCuts(track.parentId))
      throw conflict('no-failed-cuts', 'No cut failed');
    return this.read(call.actor, call.mediaId);
  }

  /** "Apagar faixa" (FR-3): the row goes aside; file, positions and bookmarks stay (BR-7). */
  archive(actor: MediaActor, mediaId: string): void {
    const { track } = this.writable(actor, mediaId);
    if (track.cut !== 'none')
      throw conflict('cut-running', 'A cut of this track is on its way');
    const author = this.authorOf(actor);
    const { revisions } = this.deps;
    revisions.atomically(() => {
      revisions.archive(track, author.now);
      revisions.record(
        mediaId,
        [{ field: 'archived', before: null, after: null }],
        author,
      );
    });
  }

  /** Within the window, in a place still free (BR-5, BR-7). */
  restore(actor: MediaActor, mediaId: string): MediaItem {
    this.deps.findMedia(actor, mediaId);
    const record = this.deps.store.getMedia(mediaId);
    const link = record?.track;
    if (!link) throw conflict('not-a-track', 'Only a track is restored');
    if (record.archivedAt === null)
      throw conflict('not-archived', 'This track was not deleted');
    this.assertEditOf(link.parentId);
    if (this.isPast(record.archivedAt))
      throw conflict('restore-expired', 'Past its window to come back');
    this.assertFree(link);
    const author = this.authorOf(actor);
    const { revisions, publisher } = this.deps;
    revisions.atomically(() => {
      revisions.restore({
        mediaId,
        trackId: randomUUID(),
        principal: actor.principal,
        now: author.now,
      });
      revisions.record(
        mediaId,
        [{ field: 'restored', before: null, after: null }],
        author,
      );
      publisher.afterRestore(link.parentId, mediaId);
    });
    return this.deps.findMedia(actor, mediaId);
  }

  private isPast(archivedAt: string): boolean {
    return this.now().getTime() - Date.parse(archivedAt) > TRACK_RESTORE_MS;
  }

  private assertFree(link: { parentId: string; startMs: number; endMs: number }) {
    const taken = this.deps.revisions
      .tracks(link.parentId)
      .find((one) => one.startMs < link.endMs && one.endMs > link.startMs);
    if (taken)
      throw new AppError('MEDIA_CONFLICT', 'Its place was taken', {
        details: { reason: 'restore-overlap', track: taken.title },
      });
  }

  archived(actor: MediaActor, recordingId: string): ArchivedTracks {
    this.deps.findMedia(actor, recordingId);
    const since = new Date(this.now().getTime() - TRACK_RESTORE_MS);
    return {
      tracks: this.deps.revisions
        .archived(recordingId, since)
        .map((one) => ({
          ...one,
          restorable: true,
          restorableUntil: new Date(
            Date.parse(one.archivedAt) + TRACK_RESTORE_MS,
          ).toISOString(),
        })),
    };
  }

  impact(actor: MediaActor, mediaId: string): TrackImpact {
    this.deps.findMedia(actor, mediaId);
    return this.deps.revisions.impact(mediaId);
  }

  history(actor: MediaActor, mediaId: string): TrackHistory {
    this.deps.findMedia(actor, mediaId);
    return { changes: this.deps.revisions.history(mediaId) };
  }

  /** The janitor's turn: the records stay, for the lists that name them (BR-7). */
  async purge(): Promise<void> {
    const now = this.now().getTime();
    const { revisions, files } = this.deps;
    await files.remove([
      ...revisions.takeOldFiles(new Date(now - OLD_CUT_MS)),
      ...revisions.takeArchivedFiles(new Date(now - TRACK_RESTORE_MS)),
    ]);
  }

  movedBookmarks(actor: MediaActor): MovedBookmarks {
    return {
      moved: [...this.deps.revisions.movedBookmarks(actor.principal)],
    };
  }

  acknowledgeMoved(actor: MediaActor): void {
    this.deps.revisions.acknowledgeMoved(actor.principal);
  }

  private speakerOf(
    track: RevisableTrack,
    role: TrackRole,
    parent: MediaRecord,
  ): TrackSpeaker {
    const voice = voiceOf(track, role);
    const own = speakerIdOf(track, role);
    const speakerId =
      own ?? (voice === null ? null : (this.labelsOf(parent.id).get(voice) ?? null));
    return { voice, speakerId, name: this.nameOf(speakerId, parent.topic) };
  }

  private nameOf(speakerId: string | null, topic: string): string | null {
    if (speakerId === null) return null;
    const speaker = this.deps.speakers.get(speakerId);
    if (!speaker) return null;
    const { authorSlug } = speaker;
    const author = authorSlug ? this.deps.authorOf(topic, authorSlug) : null;
    return author?.name ?? speaker.name;
  }

  private labelsOf(parentId: string): ReadonlyMap<number, string> {
    const latest = this.deps.diarizations.latest(parentId);
    if (!latest) return new Map();
    return new Map(
      this.deps.voiceLabels
        .labels(latest.id)
        .flatMap((label) =>
          label.speaker ? [[label.voice, label.speaker.id] as const] : [],
        ),
    );
  }

  private assertOwnSpeaker(parentId: string, speakerId: string | null): void {
    if (speakerId === null) return;
    const parent = this.parentOf(parentId);
    const known = this.deps.speakers
      .list(this.deps.rootOf(parent.topic))
      .some((one) => one.id === speakerId);
    if (!known)
      throw new AppError('VALIDATION_FAILED', 'Unknown speaker', {
        details: { field: 'speaker' },
      });
  }

  private parentOf(parentId: string): MediaRecord {
    const parent = this.deps.store.getMedia(parentId);
    if (!parent) throw new AppError('MEDIA_NOT_FOUND', 'Unknown recording');
    return parent;
  }

  /** The published track as this person may see it, approved or not. */
  private live(actor: MediaActor, mediaId: string) {
    this.deps.findMedia(actor, mediaId);
    const record = this.deps.store.getMedia(mediaId);
    const track = this.deps.revisions.track(mediaId);
    if (!record?.track || !track || record.archivedAt !== null)
      throw conflict('not-a-track', 'This is not a live track');
    return { record, track };
  }

  private writable(actor: MediaActor, mediaId: string) {
    const live = this.live(actor, mediaId);
    this.assertEditOf(live.track.parentId);
    return live;
  }

  private assertEditOf(parentId: string): void {
    if (this.deps.edits.edit(parentId)?.status !== 'approved')
      throw conflict('edit-open', 'This recording is being edited');
  }

  private authorOf(actor: MediaActor): ChangeAuthor {
    return {
      principal: actor.principal,
      name: actor.displayName ?? actor.principal,
      now: this.now(),
    };
  }
}

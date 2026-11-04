import type {
  FreeSubject,
  ProposalFailure,
  SubjectRun,
} from '@kb-chat/contracts';

/** A free subject, with the collection it belongs to. */
export interface StoredFreeSubject extends FreeSubject {
  readonly collection: string;
}

export type LinkStatus = 'suggested' | 'accepted' | 'refused';

/** A subject as a link names it, resolved by the service against the collection. */
export type LinkTarget =
  | { readonly kind: 'concept'; readonly name: string }
  | { readonly kind: 'free'; readonly id: string }
  | { readonly kind: 'new'; readonly name: string };

/** A row of `media_subject_links`; refused ones are not read. */
export interface StoredLink {
  readonly id: string;
  readonly mediaId: string;
  readonly kind: LinkTarget['kind'];
  readonly status: Exclude<LinkStatus, 'refused'>;
  readonly name: string;
  /** The free subject's id and collection; null otherwise. */
  readonly freeId: string | null;
  readonly collection: string | null;
}

export interface StoredTrackSubjects {
  readonly mediaId: string;
  readonly version: number;
  readonly summary: string | null;
  readonly suggestedSummary: string | null;
  readonly links: readonly StoredLink[];
}

/** Who writes to a track, on which version of it. */
export interface SubjectWrite {
  readonly mediaId: string;
  readonly expectedVersion: number;
  readonly principal: string;
  readonly now: Date;
}

/** A new subject accepted: the free subject it becomes, when it does not exist yet. */
export interface NewFreeSubject {
  readonly id: string;
  readonly collection: string;
  readonly name: string;
  readonly key: string;
}

export interface SubjectDecision {
  readonly linkId: string;
  /** Set on a "Novo assunto" (BR-2). */
  readonly creates: NewFreeSubject | null;
}

/** What a run left for one track. */
export interface TrackSuggestions {
  readonly mediaId: string;
  readonly subjects: readonly LinkTarget[];
  readonly summary: string | null;
}

export interface NewSubjectRun {
  readonly id: string;
  readonly mediaId: string;
  /** The approval it reads. */
  readonly editVersion: number;
  readonly principal: string;
  readonly model: string;
  readonly spendId: string;
  readonly estimateUsd: number;
  readonly now: Date;
}

/** How a run ended, with what it left when it went well. */
export interface SubjectRunEnd {
  readonly runId: string;
  readonly spendId: string;
  readonly failure: ProposalFailure | null;
  readonly spentUsd: number;
  readonly suggestions: readonly TrackSuggestions[];
  readonly now: Date;
}

/**
 * Subjects in `media.db` (KBC-069, ADR 0029 §6): free subjects, links, summaries and the
 * AI's runs. A write that names an old version changes nothing and answers null.
 */
export interface TrackSubjectStorePort {
  freeSubjects(collection: string): FreeSubject[];
  freeSubject(id: string): StoredFreeSubject | null;
  /** False when the collection already has that key. */
  createFree(input: NewFreeSubject & { by: string; now: Date }): boolean;
  /** The tracks in `mediaIds`, in that order; one with nothing yet comes empty, version 0. */
  read(mediaIds: readonly string[]): StoredTrackSubjects[];
  /** The accepted list and the summary, replaced. What left the list is refused. */
  save(
    write: SubjectWrite & {
      readonly accepted: readonly LinkTarget[];
      readonly summary: string | null;
    },
  ): number | null;
  decide(
    write: SubjectWrite & {
      readonly accept: readonly SubjectDecision[];
      readonly refuse: readonly string[];
      readonly summary: 'accept' | 'refuse' | null;
    },
  ): number | null;
  /** Tracks with this accepted subject (`concept:<key>` or `free:<id>`): KBC-070 reads this. */
  acceptedLinks(subjectKey: string): string[];
  /** Starts a run; null when the recording already has one running. */
  startRun(run: NewSubjectRun): SubjectRun | null;
  run(runId: string): SubjectRun | null;
  latestRun(mediaId: string): SubjectRun | null;
  /** An earlier run of this approval went well: it does not run again (FR-3). */
  hasDoneRun(mediaId: string, editVersion: number): boolean;
  /** Ends a run and its reservation in one transaction, writing its suggestions. */
  finishRun(end: SubjectRunEnd): void;
  /** Closes what a stopped API left running; how many. */
  interruptRunning(now: Date): number;
}

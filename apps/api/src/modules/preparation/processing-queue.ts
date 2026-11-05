import type {
  MediaItem,
  NextAction,
  PreparationPlan,
  PreparationStage,
  PreparationStep,
  ProcessingQueueItem,
  QueueAction,
  QueuePhase,
  RetryStage,
} from '@kb-chat/contracts';
import { retryStageSchema } from '@kb-chat/contracts';
import type { ActiveJob } from '../../ports/preparation-store.js';

/** A line of work, from its first to its last: the workers take the oldest job (FIFO). */
type Line = 'conversion' | 'transcriber';

const LINE_OF: Record<ActiveJob['kind'], Line> = {
  transcode: 'conversion',
  // One Mac takes both, in one line (ADR 0023).
  transcribe: 'transcriber',
  diarize: 'transcriber',
};

/** Each audio's place in the line it waits in: 1 is the next one taken. */
export function positionsOf(
  jobs: readonly ActiveJob[],
): ReadonlyMap<string, number> {
  const taken: Record<Line, number> = { conversion: 0, transcriber: 0 };
  const positions = new Map<string, number>();
  for (const { mediaId, kind, status } of jobs) {
    if (status !== 'queued') continue;
    const line = LINE_OF[kind];
    taken[line] += 1;
    if (!positions.has(mediaId)) positions.set(mediaId, taken[line]);
  }
  return positions;
}

/** What an audio with no plan is having done, so the same stages can be read from it. */
export function impliedPlan(
  item: Pick<MediaItem, 'transcription'>,
  separating: boolean,
): PreparationPlan {
  return {
    transcribe: item.transcription.status !== 'none',
    speakers: separating,
    tracks: 'none',
    subjects: false,
    acceptedUsd: null,
  };
}

const PHASE_OF: Partial<Record<PreparationStage['state'], QueuePhase>> = {
  running: 'running',
  queued: 'next',
  waiting: 'next',
};

/** A stage the transcriber does and that waits for it. */
const waitsOnTranscriber = (stage: PreparationStage | undefined): boolean =>
  stage?.state === 'queued' &&
  (stage.stage === 'transcribe' || stage.stage === 'speakers');

interface QueueFacts {
  readonly item: Pick<MediaItem, 'id' | 'title' | 'topic'>;
  readonly stages: readonly PreparationStage[];
  readonly next: NextAction | null;
  readonly position: number | null;
  /** The step of its plan; null with no plan. */
  readonly step: PreparationStep | null;
  /** The person may move this audio on: "Precisa de você" is only that. */
  readonly canEdit: boolean;
  /** Whether a transcriber can take this stage now. */
  readonly transcriberOn: (stage: PreparationStage) => boolean;
}

/** The click that gets a stopped audio going; only a plan can be retried from the queue. */
function retryOf(
  current: PreparationStage,
  step: PreparationStep | null,
): { action: QueueAction; retryStage: RetryStage | null } {
  if (!current.canRetry) return { action: 'continue', retryStage: null };
  const stage = retryStageSchema.safeParse(current.stage);
  return {
    action: 'retry',
    retryStage: step !== null && stage.success ? stage.data : null,
  };
}

function actionOf(
  facts: QueueFacts,
  current: PreparationStage | undefined,
): { action: QueueAction | null; retryStage: RetryStage | null } {
  const none = { action: null, retryStage: null };
  if (!facts.canEdit) return none;
  if (current?.state === 'failed') return retryOf(current, facts.step);
  if (facts.step === 3) return { action: 'continue', retryStage: null };
  if (facts.next) return { action: facts.next, retryStage: null };
  if (current?.state === 'blocked')
    return { action: 'continue', retryStage: null };
  return none;
}

/** One audio as the queue shows it: the first stage not done says where it is. */
export function queueItemOf(facts: QueueFacts): ProcessingQueueItem {
  const { item, stages, position, step } = facts;
  const index = stages.findIndex(({ state }) => state !== 'done');
  const current = stages[index];
  const after = stages.slice(index + 1).find(({ state }) => state !== 'done');
  const moves = actionOf(facts, current);
  const atWork = current && PHASE_OF[current.state];
  return {
    mediaId: item.id,
    title: item.title,
    topic: item.topic,
    phase: atWork ?? (moves.action === null ? 'stopped' : 'attention'),
    stage: current?.stage ?? null,
    state: current?.state ?? null,
    percent: current?.percent ?? null,
    cuts: current?.cuts ?? null,
    windows: current?.windows ?? null,
    failure: current?.failure ?? null,
    blockedBy: current?.blockedBy ?? null,
    position: current?.state === 'queued' ? position : null,
    nextStage: index < 0 ? null : (after?.stage ?? null),
    waitsForTranscriber:
      current !== undefined &&
      waitsOnTranscriber(current) &&
      !facts.transcriberOn(current),
    ...moves,
    step,
  };
}

const PHASE_ORDER: Record<QueuePhase, number> = {
  running: 0,
  next: 1,
  attention: 2,
  stopped: 3,
};

/** A line with nothing to say or do: all done, and no plan or person it waits for. */
export const isGhost = ({ stage, action }: ProcessingQueueItem): boolean =>
  stage === null && action === null;

/** At work, then the line in order, then what waits for a person; else as they came. */
export function inQueueOrder(
  items: readonly ProcessingQueueItem[],
): ProcessingQueueItem[] {
  const place = ({ position }: ProcessingQueueItem) =>
    position ?? Number.MAX_SAFE_INTEGER;
  return items.toSorted(
    (a, b) =>
      PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || place(a) - place(b),
  );
}

/** Those at work or in line: the sidebar's count. */
export const activeCountOf = (items: readonly ProcessingQueueItem[]): number =>
  items.filter(({ phase }) => phase === 'running' || phase === 'next').length;

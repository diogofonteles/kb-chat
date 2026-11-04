import type {
  OptionRefusal,
  PlanRefusals,
  PreparationOptionId,
  PreparationPlan,
} from '@kb-chat/contracts';

/** What decides an option for one person and one recording. */
export interface PlanContext {
  readonly canEdit: boolean;
  readonly canPropose: boolean;
  /** Already on the recording, or asked by this plan. */
  readonly hasTranscript: boolean;
  readonly hasVoices: boolean;
}

type Refused = PlanRefusals['options'][number];

const refused = (
  option: PreparationOptionId,
  refusal: OptionRefusal,
): Refused => ({ option, refusal });

/** Voices need the words (BR-1). */
export function speakersRefusal(context: PlanContext): OptionRefusal | null {
  if (!context.canEdit) return 'permission';
  return context.hasTranscript ? null : 'dependency';
}

export function manualRefusal(context: PlanContext): OptionRefusal | null {
  return speakersRefusal(context);
}

/** Proposing reads the words and the voices (BR-1), and is a permission of its own. */
export function aiRefusal(context: PlanContext): OptionRefusal | null {
  if (!context.canEdit || !context.canPropose) return 'permission';
  return context.hasTranscript && context.hasVoices ? null : 'dependency';
}

/**
 * Why each option of a plan cannot go on (FR-1). Subjects wait for KBC-069: nothing can run
 * them yet, so asking is refused rather than ignored.
 */
export function planRefusals(
  plan: PreparationPlan,
  context: PlanContext,
): Refused[] {
  const found: Refused[] = [];
  const add = (option: PreparationOptionId, refusal: OptionRefusal | null) => {
    if (refusal) found.push(refused(option, refusal));
  };
  if (plan.speakers) add('speakers', speakersRefusal(context));
  if (plan.tracks === 'manual') add('manual', manualRefusal(context));
  if (plan.tracks === 'ai') {
    add('ai', aiRefusal(context));
    // Nothing paid without the amount the person saw (BR-4).
    if (plan.acceptedUsd === null) add('ai', 'no-estimate');
  }
  if (plan.subjects) add('subjects', 'unavailable');
  return found;
}

/** A plan that needs more than the transcription goes through the guided flow (AC-15). */
export const isGuided = (plan: PreparationPlan): boolean =>
  plan.speakers || plan.tracks !== 'none';

import type { LlmMessage, LlmPrice } from '../../ports/llm.js';
import { tokensOf } from '../spend/index.js';
import { SYSTEM_PROMPT, windowPrompt, type FixedContext } from './prompt.js';
import { wordsOf, type NameEvidence } from './proposal-validation.js';
import { splitWindows, voiceStats, type PromptSegment } from './windows.js';

/** Output budget per window: enough for ~40 compact tracks (KBC-063: 3,000 held one window). */
export const MAX_OUTPUT_TOKENS = 3_000;
/** Room for the previous window's tracks, which only exist once the run goes. */
const PREVIOUS_TRACKS_CHARS = 1_500;

/** Everything a run needs, computed once for the estimate and the run alike. */
export interface ProposalPlan {
  readonly mediaId: string;
  readonly transcriptId: string;
  readonly model: string;
  readonly price: LlmPrice;
  readonly windows: readonly (readonly PromptSegment[])[];
  readonly context: FixedContext;
  readonly evidence: NameEvidence;
  /** The upper bound of one pass over every window (no retry), in US$. */
  readonly estimateUsd: number;
}

/** US$ of one call: the prompt priced as input plus the whole output budget. */
export function callCeiling(
  messages: readonly LlmMessage[],
  price: LlmPrice,
): number {
  const prompt = messages.map((message) => message.content).join('\n');
  return tokensOf(prompt) * price.input + MAX_OUTPUT_TOKENS * price.output;
}

/** The messages of one window, before any retry. */
export function windowMessages(
  plan: Pick<ProposalPlan, 'windows' | 'context'>,
  index: number,
  previous: Parameters<typeof windowPrompt>[0]['previous'],
): LlmMessage[] {
  const window = plan.windows[index] ?? [];
  const before = plan.windows[index - 1]?.at(-1) ?? null;
  const user = windowPrompt({
    context: plan.context,
    window,
    before,
    position: { index, total: plan.windows.length },
    previous,
  });
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function estimateOf(
  plan: Pick<ProposalPlan, 'windows' | 'context'>,
  price: LlmPrice,
): number {
  const padding = tokensOf('x'.repeat(PREVIOUS_TRACKS_CHARS)) * price.input;
  const total = plan.windows.reduce(
    (sum, _window, index) =>
      sum + callCeiling(windowMessages(plan, index, []), price) + padding,
    0,
  );
  return Math.ceil(total * 1e6) / 1e6;
}

/** The plan of a run over these segments, with the model's price. */
export function buildPlan(input: {
  readonly mediaId: string;
  readonly transcriptId: string;
  readonly segments: readonly PromptSegment[];
  readonly context: Omit<FixedContext, 'voices'>;
  readonly model: { readonly id: string; readonly price: LlmPrice };
}): ProposalPlan {
  const { segments, model } = input;
  const context = { ...input.context, voices: voiceStats(segments) };
  const windows = splitWindows(segments);
  const evidence: NameEvidence = {
    voices: new Set(context.voices.map((stat) => stat.voice)),
    spoken: wordsOf(segments.map((segment) => segment.text).join(' ')),
    knownNames: [
      ...context.knownNames,
      ...(context.author ? [context.author] : []),
    ],
  };
  return {
    mediaId: input.mediaId,
    transcriptId: input.transcriptId,
    model: model.id,
    price: model.price,
    windows,
    context,
    evidence,
    estimateUsd: estimateOf({ windows, context }, model.price),
  };
}

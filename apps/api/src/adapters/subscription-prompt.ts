import { researchSystemPrompt } from '../modules/research/index.js';
import type { ResearchProfile, ResearchTurn } from '@kb-chat/contracts';

/** The research rules of a topic and profile for a subscription CLI. */
export type SubscriptionPrompt = (
  topic: string,
  profile: ResearchProfile,
) => string;

/**
 * The research rules of a subscription turn (ADR 0006/0007): the same prompt as the
 * in-API loop, so Claude Code and Codex search, grep with find_text before concluding
 * absence, cite [n], mark "(fora do acervo)" and never narrate. The composition root passes
 * one with the topic's title; this default names the topic by its slug.
 */
export const defaultSubscriptionPrompt: SubscriptionPrompt = (topic, profile) =>
  researchSystemPrompt(topic, profile);

const escape = (text: string): string =>
  text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The question and the previous turns as the CLI's stdin (KBC-008 BR-4: text only). */
export function subscriptionTurnInput(
  question: string,
  history: readonly ResearchTurn[],
): string {
  const turns = history.map(
    (turn) =>
      `<turn>\n<question>${escape(turn.question)}</question>\n<answer>${escape(turn.answer)}</answer>\n</turn>`,
  );
  const context =
    turns.length > 0
      ? `Previous turns of this conversation:\n<conversation>\n${turns.join('\n')}\n</conversation>\n\n`
      : '';
  return `${context}<question>${escape(question)}</question>\n`;
}

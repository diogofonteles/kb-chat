import {
  MAX_SWEEP_PHRASES,
  sweepPlanSchema,
  type SweepPlan,
} from '@kb-chat/contracts';
import { z } from 'zod';
import type { ToolDefinition } from '../../../ports/llm.js';
import { foldName } from '../tool-output.js';

/** The exhaustive orchestrator's planning tool (KBC-030, ADR 0021). */
export const PLAN_SWEEP_TOOL = 'plan_sweep';
/** Tool steps the orchestrator may take before the app sweeps with the default plan. */
export const PLAN_STEPS = 12;

const parameters: Record<string, unknown> = {
  ...z.toJSONSchema(sweepPlanSchema, { io: 'input', target: 'draft-07' }),
};
delete parameters['$schema'];

export const PLAN_SWEEP_DEFINITION: ToolDefinition = {
  name: PLAN_SWEEP_TOOL,
  description: `Entrega ao aplicativo o plano da varredura completa; o aplicativo lê todos os documentos do conjunto em lotes e só depois pede a resposta. target: o conjunto (authorship, entity, source, subjects; vazio = acervo inteiro). phrases: até ${MAX_SWEEP_PHRASES} expressões literais que acham os trechos relevantes (variantes, singular e plural; teste antes com find_text); sem phrases, cada documento é lido inteiro, o que custa muito mais. extract: o que tirar de cada documento (por exemplo, "livros citados de forma positiva, com o trecho"). Chame uma vez, quando o conjunto e as expressões estiverem certos.`,
  parameters,
};

/** The question names the Mestre (Laércio, "o Mestre"). */
const NAMES_MESTRE = /\blaercio\b|\bmestre\b/u;

/**
 * The plan when the orchestrator answers or spends its steps without planning (ADR 0021):
 * the Mestre's documents when the question names him, else the whole topic; no phrases (every
 * document read whole, the estimate says what that costs); the question as the extraction.
 */
export function defaultPlan(question: string): SweepPlan {
  const mestre = NAMES_MESTRE.test(foldName(question));
  return sweepPlanSchema.parse({
    target: mestre ? { authorship: 'mestre-laercio' } : {},
    extract: question.trim().slice(0, 1000).padEnd(3, '?'),
  });
}

import { sweepPlanSchema, type SweepPlan } from '@kb-chat/contracts';
import type { ToolDefinition } from '../../../ports/llm.js';
import type {
  ResearchToolResult,
  ResearchToolsPort,
} from '../../../ports/research-tools.js';
import { parsedArgs } from '../tool-context.js';
import { PLAN_SWEEP_DEFINITION, PLAN_SWEEP_TOOL } from './plan-tool.js';

const PLANNED =
  'Plano registrado: o aplicativo varre o conjunto inteiro agora. Encerre sem escrever resposta.';

/**
 * A subscription CLI's tools while it plans an exhaustive sweep (KBC-030, ADR 0021): the
 * turn's research tools plus plan_sweep, which records the plan and tells the runner to end
 * the planning pass.
 */
export class PlanningTools implements ResearchToolsPort {
  plan: SweepPlan | null = null;
  private sources: ResearchToolResult['sources'] = [];

  constructor(
    private readonly inner: ResearchToolsPort,
    private readonly onPlan: () => void,
  ) {}

  definitions(): readonly ToolDefinition[] {
    return [...this.inner.definitions(), PLAN_SWEEP_DEFINITION];
  }

  async call(name: string, args: unknown): Promise<ResearchToolResult> {
    if (name !== PLAN_SWEEP_TOOL) {
      const result = await this.inner.call(name, args);
      this.sources = result.sources;
      return result;
    }
    const plan = parsedArgs(sweepPlanSchema, args);
    if (typeof plan === 'string')
      return { text: plan, steps: [], sources: this.sources };
    this.plan = plan;
    this.onPlan();
    return {
      text: PLANNED,
      steps: [{ kind: 'sweep', text: 'Planejando a varredura completa' }],
      sources: this.sources,
    };
  }
}

/** A CLI call that must not use any tool (a sweep batch, the final answer). */
export const NO_TOOLS: ResearchToolsPort = {
  definitions: () => [],
  call: async (name) => {
    throw new Error(`No tools in this call: ${name}`);
  },
};

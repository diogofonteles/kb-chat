import type { ResearchStep } from '@kb-chat/contracts';
import type { ResearchTurn, TurnStep } from './research-turn.js';

const countOf = (steps: readonly TurnStep[], kind: ResearchStep['kind']) =>
  steps.filter((step) => step.kind === kind).length;

/** The sub-researcher that took a step (KBC-018), or null for the main agent. */
export const agentOf = (step: TurnStep): number | null =>
  step.kind !== 'thought' && step.agent ? step.agent : null;

/** How a steps line reads: a tool step as the server wrote it, a thought or a sub-researcher prefixed. */
export function stepText(step: TurnStep): string {
  if (step.kind === 'thought')
    return $localize`:@@research.thought:Pensando: ${step.text}:thought:`;
  const agent = agentOf(step);
  return agent === null
    ? step.text
    : $localize`:@@research.agentStep:Pesquisador ${agent}:agent:: ${step.text}:step:`;
}

const agents = (n: number): string =>
  n === 1
    ? $localize`:@@research.agentOne:1 pesquisador`
    : $localize`:@@research.agents:${n}:count: pesquisadores`;

/** Sub-researchers that worked on the turn (ADR 0014). */
const agentCount = (steps: readonly TurnStep[]): number =>
  new Set(steps.map(agentOf).filter((agent) => agent !== null)).size;

const searched = (n: number): string =>
  n === 1
    ? $localize`:@@research.searchedOnce:Pesquisou 1 vez`
    : $localize`:@@research.searched:Pesquisou ${n}:count: vezes`;

const read = (n: number): string =>
  n === 1
    ? $localize`:@@research.readOne:leu 1 documento`
    : $localize`:@@research.read:leu ${n}:count: documentos`;

const stepCount = (n: number): string =>
  n === 1
    ? $localize`:@@research.stepOne:1 passo de pesquisa`
    : $localize`:@@research.steps:${n}:count: passos de pesquisa`;

/**
 * The discreet line above an answer: the current step while the agent works, then what it did
 * ("Pesquisou 3 vezes · leu 4 documentos"). A restored turn only knows how many steps it took.
 */
export function describeSteps(turn: ResearchTurn): string {
  if (turn.phase === 'streaming') {
    const last = turn.steps.at(-1);
    return last
      ? stepText(last)
      : $localize`:@@research.working:Pesquisando no acervo…`;
  }
  const searches = countOf(turn.steps, 'search');
  const reads = documentsRead(turn.steps);
  const deepened =
    turn.escalated || turn.steps.some((s) => s.kind === 'deepen');
  const parts = [
    ...(searches > 0 ? [searched(searches)] : []),
    ...(reads > 0 ? [read(reads)] : []),
    // A restored turn only kept its step count.
    ...(searches + reads === 0 && turn.stepCount > 0
      ? [stepCount(turn.stepCount)]
      : []),
    ...(deepened
      ? [$localize`:@@research.deepened:aprofundou a pesquisa`]
      : []),
    ...(agentCount(turn.steps) > 0 ? [agents(agentCount(turn.steps))] : []),
  ];
  const line = parts.join(' · ');
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : '';
}

/** Distinct documents read, by id: a document read again counts once, two with one title twice. */
const documentsRead = (steps: readonly TurnStep[]): number =>
  new Set(
    steps.flatMap((s) =>
      s.kind === 'read' ? [('document' in s && s.document) || s.text] : [],
    ),
  ).size;

/** One line of the expanded steps list; a delegation lists its sub-researcher's steps. */
export interface StepItem {
  readonly text: string;
  readonly thought: boolean;
  /** The sub-researcher's own steps, under its delegation (KBC-018). */
  readonly children: readonly StepItem[];
}

const headText = (step: TurnStep, agent: number): string =>
  $localize`:@@research.agentHead:Pesquisador ${agent}:agent: — ${step.text}:title:`;

const itemOf = (step: TurnStep, text = stepText(step)): StepItem => ({
  text,
  thought: step.kind === 'thought',
  children: [],
});

/**
 * The expanded steps, grouped (KBC-018, ADR 0014): each sub-researcher's delegation is an
 * item whose nested list holds that researcher's steps, in the order they came; the main
 * agent's steps keep their place. A step whose delegation never came shows on its own,
 * numbered. One pass over the steps.
 */
export function groupedSteps(steps: readonly TurnStep[]): StepItem[] {
  const heads = new Map<number, StepItem[]>();
  for (const step of steps)
    if (step.kind === 'delegate' && agentOf(step) !== null)
      heads.set(agentOf(step) ?? 0, []);
  const items: StepItem[] = [];
  for (const step of steps) {
    const agent = agentOf(step);
    const own = agent === null ? undefined : heads.get(agent);
    if (step.kind === 'delegate' && agent !== null && own)
      items.push({ ...itemOf(step, headText(step, agent)), children: own });
    else if (own) own.push(itemOf(step, step.text));
    else items.push(itemOf(step));
  }
  return items;
}

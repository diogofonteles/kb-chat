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

/** One line of the expanded steps list. */
export interface StepItem {
  readonly text: string;
  readonly thought: boolean;
  /** A sub-researcher's step, listed under its delegation (KBC-018). */
  readonly sub: boolean;
}

const headText = (step: TurnStep, agent: number): string =>
  $localize`:@@research.agentHead:Pesquisador ${agent}:agent: — ${step.text}:title:`;

/**
 * The expanded steps, grouped (KBC-018, ADR 0014): each sub-researcher's delegation is a
 * heading line followed by its own steps, indented, in the order they came; the main
 * agent's steps keep their place.
 */
export function groupedSteps(steps: readonly TurnStep[]): StepItem[] {
  const byAgent = new Map<number, TurnStep[]>();
  for (const step of steps) {
    const agent = agentOf(step);
    if (agent !== null && step.kind !== 'delegate')
      byAgent.set(agent, [...(byAgent.get(agent) ?? []), step]);
  }
  const headed = new Set<number>();
  return steps.flatMap((step): StepItem[] => {
    const agent = agentOf(step);
    if (agent === null)
      return [
        { text: stepText(step), thought: step.kind === 'thought', sub: false },
      ];
    if (step.kind !== 'delegate')
      // Shown under its delegation; one without a heading still shows, numbered.
      return byAgent.has(agent) && !headed.has(agent) && !hasHead(steps, agent)
        ? [{ text: stepText(step), thought: false, sub: false }]
        : [];
    headed.add(agent);
    const own = (byAgent.get(agent) ?? []).map((s) => ({
      text: s.text,
      thought: false,
      sub: true,
    }));
    return [
      { text: headText(step, agent), thought: false, sub: false },
      ...own,
    ];
  });
}

const hasHead = (steps: readonly TurnStep[], agent: number): boolean =>
  steps.some((s) => s.kind === 'delegate' && agentOf(s) === agent);

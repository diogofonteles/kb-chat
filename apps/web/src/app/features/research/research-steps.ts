import type { ResearchStep } from '@kb-chat/contracts';
import type { ResearchTurn, TurnStep } from './research-turn.js';

const countOf = (steps: readonly TurnStep[], kind: ResearchStep['kind']) =>
  steps.filter((step) => step.kind === kind).length;

/** How a steps line reads: a tool step as the server wrote it, a thought prefixed. */
export const stepText = (step: TurnStep): string =>
  step.kind === 'thought'
    ? $localize`:@@research.thought:Pensando: ${step.text}:thought:`
    : step.text;

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

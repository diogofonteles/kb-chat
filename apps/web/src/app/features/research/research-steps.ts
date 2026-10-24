import type { ResearchStep } from '@kb-chat/contracts';
import type { ResearchTurn } from './research-turn.js';

const countOf = (steps: readonly ResearchStep[], kind: ResearchStep['kind']) =>
  steps.filter((step) => step.kind === kind).length;

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
  if (turn.phase === 'streaming')
    return (
      turn.steps.at(-1)?.text ??
      $localize`:@@research.working:Pesquisando no acervo…`
    );
  const searches = countOf(turn.steps, 'search');
  const reads = countOf(turn.steps, 'read');
  const parts = [
    ...(searches > 0 ? [searched(searches)] : []),
    ...(reads > 0 ? [read(reads)] : []),
  ];
  const line = parts.join(' · ');
  if (line) return line.charAt(0).toUpperCase() + line.slice(1);
  return turn.stepCount > 0 ? stepCount(turn.stepCount) : '';
}

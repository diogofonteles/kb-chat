import type { PreparationStage, ProcessingQueueItem } from '@kb-chat/contracts';
import {
  STAGE_NAMES,
  failureText,
  stageStateText,
} from '../preparation/preparation-labels.js';
import { stepTitle } from '../preparation/preparation-steps.js';

/** The stage as the labels of step 2 read it: the same words on every screen (DS-18). */
const stageOf = (
  item: ProcessingQueueItem,
  stage: PreparationStage['stage'],
  state: PreparationStage['state'],
): PreparationStage => ({
  stage,
  state,
  percent: item.percent,
  cuts: item.cuts,
  ahead: null,
  blockedBy: item.blockedBy,
  failure: item.failure,
  canRetry: false,
  windows: item.windows,
  reservedUsd: null,
  spentUsd: null,
  estimateUsd: null,
});

/** What an audio waits for a person to do, once no stage says it. */
function restingText(item: ProcessingQueueItem): string {
  if (item.action === 'validate')
    return $localize`:@@queue.state.validate:Processamento concluído. Falta validar as faixas.`;
  if (item.step === 3) return stepTitle(3);
  return $localize`:@@queue.state.done:Processamento concluído.`;
}

/** "Transcrição:  35 % (cortes 14 de 40)", in words: never by colour alone. */
export function queueStateText(item: ProcessingQueueItem): string {
  const { stage, state } = item;
  if (!stage || !state || item.step === 3) return restingText(item);
  const name = STAGE_NAMES[stage]();
  if (item.waitsForTranscriber)
    return $localize`:@@queue.state.waitingTranscriber:${name}:stage:: aguardando o transcritor`;
  if (state === 'failed')
    return `${name}: ${failureText(item.failure ?? 'work')}`;
  const words = stageStateText(stageOf(item, stage, state), null);
  return `${name}: ${words.trim()}`;
}

/** "1º na fila": absent outside a line. */
export function queuePositionText({ position }: ProcessingQueueItem): string {
  return position === null
    ? ''
    : $localize`:@@queue.position:${position}:position:º na fila`;
}

/** "Depois: Vozes". */
export function queueNextText({ nextStage }: ProcessingQueueItem): string {
  return nextStage === null
    ? ''
    : $localize`:@@queue.next:Depois: ${STAGE_NAMES[nextStage]()}:stage:`;
}

/** The bar's value read aloud. */
export function queueProgressText(item: ProcessingQueueItem): string {
  const name = item.stage ? STAGE_NAMES[item.stage]() : '';
  return $localize`:@@prep.progress.value:${name}:name:: ${item.percent ?? 0}:percent: por cento`;
}

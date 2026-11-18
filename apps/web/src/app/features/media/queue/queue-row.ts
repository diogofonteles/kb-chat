import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  PreparationStageId,
  ProcessingQueueItem,
  QueueAction,
  RetryStage,
} from '@kb-chat/contracts';
import { NEUTRAL_COVER, UiCover, UiPill, type Tone } from '@ui/index.js';
import { mediaPagePath } from '@core/media/media-api.js';
import { editPagePath } from '@core/media/media-edit-api.js';
import { preparationPagePath } from '@core/media/preparation-api.js';
import {
  queueNextText,
  queuePositionText,
  queueProgressText,
  queueStateText,
} from './queue-labels.js';

/** The mini stepper of a row (v2 · Fila): Enviar → Converter → Transcrever → Preparar. */
const STEP_NAMES: readonly (() => string)[] = [
  () => $localize`:@@queue.step.upload:Enviar`,
  () => $localize`:@@queue.step.convert:Converter`,
  () => $localize`:@@queue.step.transcribe:Transcrever`,
  () => $localize`:@@queue.step.prepare:Preparar`,
];
const STEP_OF: Record<PreparationStageId, number> = {
  upload: 0,
  convert: 1,
  transcribe: 2,
  speakers: 3,
  tracks: 3,
};

export type QueueStepState = 'done' | 'current' | 'ahead';

/**
 * Where an item is on the four steps; past the last stage every step is done, unless the
 * person still has to validate or conclude the plan: then "Preparar" is the current one.
 */
export function queueSteps(
  stage: PreparationStageId | null,
  action: QueueAction | null = null,
): readonly QueueStepState[] {
  const last = STEP_NAMES.length - 1;
  const at =
    stage !== null
      ? STEP_OF[stage]
      : action === 'validate' || action === 'conclude'
        ? last
        : STEP_NAMES.length;
  return STEP_NAMES.map((_, index) =>
    index < at ? 'done' : index === at ? 'current' : 'ahead',
  );
}

/** The pill's word: "Precisa de você" when the row asks this person something. */
export type QueueStatus = 'done' | 'failed' | 'running' | 'waiting' | 'you';

const STATUS_TONE: Record<QueueStatus, Tone> = {
  done: 'ok',
  failed: 'err',
  running: 'info',
  waiting: 'warn',
  you: 'warn',
};

const STATUS_WORD: Record<QueueStatus, () => string> = {
  done: () => $localize`:@@queue.tone.ok:Concluído`,
  failed: () => $localize`:@@queue.tone.err:Falhou`,
  running: () => $localize`:@@queue.tone.info:Processando`,
  waiting: () => $localize`:@@queue.tone.warn:Aguardando`,
  you: () => $localize`:@@queue.attention:Precisa de você`,
};

/**
 * The row's situation, from its action first and its stage's state after (KBC-129 FR-4): a
 * row whose stages are all done but that waits for the person never says "Concluído".
 */
export function queueStatus(item: ProcessingQueueItem): QueueStatus {
  if (item.action === 'retry' || item.state === 'failed') return 'failed';
  if (
    item.action === 'validate' ||
    item.action === 'conclude' ||
    item.action === 'continue'
  )
    return 'you';
  if (item.waitsForTranscriber) return 'waiting';
  if (item.state === null || item.state === 'done') return 'done';
  return item.state === 'running' ? 'running' : 'waiting';
}

/** What pressing a row's button asks. */
export type QueueMove =
  | { readonly kind: 'retry'; readonly stage: RetryStage }
  | { readonly kind: 'advance' };

/**
 * One audio of the queue (T23, KBC-090): where it is in words, its bar, its place and what
 * comes after. The paid stage's "Tentar de novo" is a link: the value is seen on its page
 * before the press (KBC-072 BR-4). A row with no action has only its title to follow.
 */
@Component({
  selector: 'app-queue-row',
  imports: [RouterLink, UiCover, UiPill],
  templateUrl: './queue-row.html',
  styleUrls: ['../preparation/preparation-buttons.css', './queue-row.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'listitem',
    '[class.failed]': "item().state === 'failed'",
    '[class.current]': "item().phase === 'running'",
    '[attr.data-tone]': 'tone()',
  },
})
export class QueueRow {
  readonly item = input.required<ProcessingQueueItem>();
  /** The collection's name. */
  readonly topicTitle = input.required<string>();
  /** The person opens plans: otherwise the title leads to the audio. */
  readonly canEdit = input(false);
  readonly busy = input(false);
  readonly moved = output<QueueMove>();
  private readonly titleLink = viewChild<ElementRef<HTMLElement>>('title');

  protected readonly link = computed(() => {
    const { mediaId, step } = this.item();
    if (step === null || !this.canEdit()) return mediaPagePath(mediaId);
    return step === 3 ? editPagePath(mediaId) : preparationPagePath(mediaId);
  });
  protected readonly stateText = computed(() => queueStateText(this.item()));
  /** A row that failed has the grey cover (queue.js: "Arquivo corrompido"). */
  protected readonly failed = computed(() => this.status() === 'failed');
  protected readonly neutral = NEUTRAL_COVER;
  private readonly status = computed(() => queueStatus(this.item()));
  protected readonly tone = computed(() => STATUS_TONE[this.status()]);
  protected readonly toneWord = computed(() => STATUS_WORD[this.status()]());
  protected readonly steps = computed(() =>
    queueSteps(this.item().stage, this.item().action).map((state, index) => ({
      state,
      name: STEP_NAMES[index]?.() ?? '',
    })),
  );
  protected readonly positionText = computed(() =>
    queuePositionText(this.item()),
  );
  protected readonly nextText = computed(() => queueNextText(this.item()));
  protected readonly progressText = computed(() =>
    queueProgressText(this.item()),
  );
  protected readonly showBar = computed(() => {
    const { state, percent } = this.item();
    return state === 'running' && percent !== null;
  });
  /** Free stages retry here; the paid one needs its value in sight first. */
  protected readonly retryStage = computed(() => {
    const { retryStage } = this.item();
    return retryStage === 'tracks' ? null : retryStage;
  });

  /** After a press the button may be gone: the focus stays on the row. */
  focusTitle(): void {
    this.titleLink()?.nativeElement.focus();
  }

  protected retry(stage: RetryStage): void {
    this.moved.emit({ kind: 'retry', stage });
  }

  protected advance(): void {
    this.moved.emit({ kind: 'advance' });
  }
}

import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import {
  retryStageSchema,
  type MediaPreparation,
  type PreparationStage,
  type RetryStage,
} from '@kb-chat/contracts';
import {
  STAGE_NAMES,
  progressValueText,
  stageStateText,
} from './preparation-labels.js';

/** A stage as a line of the list. */
interface StageLine {
  readonly stage: PreparationStage;
  readonly name: string;
  readonly state: string;
}

/**
 * The stages of step 2 as a list, not a single bar (T20): each says in text where it is,
 * the current one with a progress bar; a paid one says what is reserved and spent (UP-02).
 */
@Component({
  selector: 'app-preparation-stage-list',
  imports: [DatePipe],
  templateUrl: './preparation-stages.html',
  styleUrl: './preparation-stages.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreparationStageList {
  private readonly locale = inject(LOCALE_ID);
  readonly preparation = input.required<MediaPreparation>();
  readonly busy = input(false);
  readonly retried = output<RetryStage>();
  readonly markedByHand = output();

  protected readonly lines = computed<StageLine[]>(() => {
    const { stages } = this.preparation();
    return stages.map((stage, index) => ({
      stage,
      name: STAGE_NAMES[stage.stage](),
      state: stageStateText(stage, stages[index - 1] ?? null),
    }));
  });
  protected readonly waitsForTranscriber = computed(() => {
    const { stages, transcriber } = this.preparation();
    return (
      transcriber === 'off' &&
      stages.some(
        ({ stage, state }) =>
          (stage === 'transcribe' || stage === 'speakers') &&
          state === 'queued',
      )
    );
  });

  protected valueText(stage: PreparationStage): string {
    return progressValueText(stage);
  }

  protected costText(stage: PreparationStage): string {
    if (stage.reservedUsd === null) return '';
    const reserved = this.usd(stage.reservedUsd);
    const spent = this.usd(stage.spentUsd ?? 0);
    return $localize`:@@prep.cost:Reservado ${reserved}:reserved: · gasto ${spent}:spent:`;
  }

  /** The value of pressing "Tentar de novo" on a paid stage: in sight before the press. */
  protected retryCost(stage: PreparationStage): string {
    if (stage.stage !== 'tracks' || stage.estimateUsd === null) return '';
    const value = this.usd(stage.estimateUsd);
    return $localize`:@@prep.retryCost:Tentar de novo custa cerca de ${value}:value:, descontado do limite mensal da mídia.`;
  }

  protected retry(stage: PreparationStage): void {
    this.retried.emit(retryStageSchema.parse(stage.stage));
  }

  private usd(value: number): string {
    return new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    }).format(value);
  }
}

import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PreparationStep } from '@kb-chat/contracts';
import { preparationPagePath } from '@core/media/preparation-api.js';
import { editPagePath } from '@core/media/media-edit-api.js';
import { UiIcon } from '@ui/icon.js';

const WHOLE: Record<PreparationStep, () => string> = {
  1: () => $localize`:@@prep.step.text1:Passo 1 de 4: Enviar e escolher`,
  2: () => $localize`:@@prep.step.text2:Passo 2 de 4: Processar`,
  3: () => $localize`:@@tracks.stepText3:Passo 3 de 4: Validar faixas`,
  4: () => $localize`:@@tracks.stepText4:Passo 4 de 4: Aprovar`,
};

const SHORT: Record<PreparationStep, () => string> = {
  1: () => $localize`:@@prep.step.short1:1/4 Enviar e escolher`,
  2: () => $localize`:@@prep.step.short2:2/4 Processar`,
  3: () => $localize`:@@tracks.stepShort3:3/4 Validar faixas`,
  4: () => $localize`:@@tracks.stepShort4:4/4 Aprovar`,
};

/** The guided flow's label under the bars on a phone (v2 · Mídia — Preparar, celular). */
const LABEL: Record<PreparationStep, () => string> = {
  1: () => $localize`:@@prep.step.label1:Passo 1 de 4 · Enviar e escolher`,
  2: () => $localize`:@@prep.step.label2:Passo 2 de 4 · Processar`,
  3: () => $localize`:@@tracks.stepLabel3:Passo 3 de 4 · Validar faixas`,
  4: () => $localize`:@@tracks.stepLabel4:Passo 4 de 4 · Aprovar`,
};

/** Step 4 of a finished preparation: nothing there is left to press (KBC-095). */
const FINISHED = {
  whole: () => $localize`:@@tracks.stepFinished:Passo 4 de 4: Concluído`,
  short: () => $localize`:@@tracks.stepFinishedShort:4/4 Concluído`,
  label: () => $localize`:@@tracks.stepFinishedLabel:Passo 4 de 4 · Concluído`,
};

/** Nothing left to prepare: every step is behind. */
const ALL_DONE = () => $localize`:@@prep.step.allDone:Tudo pronto`;

/** Future steps are not links, and this says why (AC-5); empty once nothing waits. */
export function stepWhy(step: PreparationStep, processed: boolean): string {
  if (step === 1)
    return $localize`:@@prep.step.why1:Os próximos passos abrem depois do envio.`;
  if (step === 2 && !processed)
    return $localize`:@@prep.step.why2:O próximo passo fica disponível quando o processamento terminar.`;
  return '';
}

const KICKER: Record<PreparationStep, () => string> = {
  1: () => $localize`:@@prep.step.kicker1:Passo 1 de 4`,
  2: () => $localize`:@@prep.step.kicker2:Passo 2 de 4`,
  3: () => $localize`:@@tracks.stepKicker3:Passo 3 de 4`,
  4: () => $localize`:@@tracks.stepKicker4:Passo 4 de 4`,
};

/** "Passo 2 de 4", after "Preparar áudio" in the flow's head. */
export const stepKicker = (step: PreparationStep): string => KICKER[step]();

/** "Passo 2 de 4: Processar", also the page's title. */
export const stepTitle = (step: PreparationStep): string => WHOLE[step]();

/**
 * Where the person is in "Preparar áudio" (T20, UP-20): an ordered list with done steps
 * marked in text, future ones saying why they are closed, and step 3 "não pedido" when the
 * person chose not to divide. On a phone, "2/4 Processar" opens the whole list.
 */
@Component({
  selector: 'app-preparation-steps',
  imports: [RouterLink, NgTemplateOutlet, UiIcon],
  template: `
    @if (!flow()) {
      <p class="step-text" data-testid="step-text">
        <span class="wide">{{ whole() }}</span>
        <span class="narrow">{{ short() }}</span>
      </p>
      <button
        type="button"
        class="toggle"
        [attr.aria-expanded]="expanded()"
        (click)="expanded.set(!expanded())"
        i18n="@@prep.step.toggle"
      >
        Ver os passos
      </button>
    }
    <!-- A done step: the frame's 14 px check, and the word for who does not see it (UP-20). -->
    <ng-template #doneMark>
      <ui-icon class="check" name="check" [size]="14" />
      <span class="visually-hidden" i18n="@@prep.step.doneWord">concluído</span>
    </ng-template>
    <!-- The four bars are the flow's progress (on a phone, nothing else of the list shows). -->
    <ol
      class="steps step-progress"
      [class.open]="expanded() || flow()"
      aria-label="Preparar áudio"
      i18n-aria-label="@@tracks.flow"
    >
      <li
        [class.done]="step() > 1 || allDone()"
        [attr.aria-current]="step() === 1 && !allDone() ? 'step' : null"
      >
        <span i18n="@@prep.step.name1">1 Enviar e escolher</span>
        @if (step() > 1 || allDone()) {
          <ng-container [ngTemplateOutlet]="doneMark" />
        }
      </li>
      <li
        [class.done]="step() > 2 || allDone()"
        [attr.aria-current]="step() === 2 ? 'step' : null"
      >
        @if (step() > 2 && mediaId()) {
          <a [routerLink]="processLink()" i18n="@@prep.step.name2"
            >2 Processar</a
          >
        } @else {
          <span i18n="@@prep.step.name2">2 Processar</span>
        }
        @if (step() > 2 || allDone()) {
          <ng-container [ngTemplateOutlet]="doneMark" />
        }
      </li>
      <li
        [class.done]="step() > 3 || allDone()"
        [class.skipped]="skipped()"
        [attr.aria-current]="step() === 3 && !skipped() ? 'step' : null"
      >
        @if (skipped()) {
          <span i18n="@@prep.step.skipped">3 Validar faixas — não pedido</span>
        } @else if (step() > 3 && mediaId()) {
          <a [routerLink]="validateLink()" i18n="@@tracks.step3"
            >3 Validar faixas</a
          >
          <ng-container [ngTemplateOutlet]="doneMark" />
        } @else {
          <span i18n="@@tracks.step3">3 Validar faixas</span>
          @if (allDone()) {
            <ng-container [ngTemplateOutlet]="doneMark" />
          }
        }
      </li>
      <li
        [class.done]="finished() || allDone()"
        [attr.aria-current]="step() === 4 ? 'step' : null"
      >
        @if (finished() || allDone()) {
          <span i18n="@@tracks.step4Finished">4 Concluído</span>
          <ng-container [ngTemplateOutlet]="doneMark" />
        } @else if (skipped()) {
          <span i18n="@@prep.step.conclude">4 Concluir</span>
        } @else {
          <span i18n="@@tracks.step4">4 Aprovar</span>
        }
      </li>
    </ol>
    @if (flow()) {
      <p class="step-text label" data-testid="step-text">{{ label() }}</p>
    } @else if (why(); as reason) {
      <p class="why">{{ reason }}</p>
    }
  `,
  styleUrl: './preparation-steps.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.flow]': 'flow()' },
})
export class PreparationSteps {
  readonly step = input.required<PreparationStep>();
  /** Step 3 was not asked for. */
  readonly skipped = input(false);
  /** Processing ended: the next step only waits for the press. */
  readonly processed = input(false);
  /** The tracks were approved: step 4 is done, not to do. */
  readonly finished = input(false);
  /** Empty on the upload: nothing to go back to yet. */
  readonly mediaId = input('');
  /**
   * The guided flow's pages (KBC-130): the names under the bars on a desktop, the step in
   * words under them on a phone; the page says why the next steps are closed.
   */
  readonly flow = input(false, { transform: booleanAttribute });
  /** Nothing left to prepare: every bar is green ("Tudo pronto"). */
  readonly allDone = input(false);

  protected readonly expanded = signal(false);
  protected readonly whole = computed(() =>
    this.finished() ? FINISHED.whole() : WHOLE[this.step()](),
  );
  protected readonly short = computed(() =>
    this.finished() ? FINISHED.short() : SHORT[this.step()](),
  );
  protected readonly label = computed(() => {
    if (this.allDone()) return ALL_DONE();
    return this.finished() ? FINISHED.label() : LABEL[this.step()]();
  });
  protected readonly processLink = computed(() =>
    preparationPagePath(this.mediaId()),
  );
  protected readonly validateLink = computed(() =>
    editPagePath(this.mediaId()),
  );
  /** Future steps are not links, and this says why (AC-5). */
  protected readonly why = computed(() =>
    stepWhy(this.step(), this.processed()),
  );
}

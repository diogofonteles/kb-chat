import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PreparationStep } from '@kb-chat/contracts';
import { preparationPagePath } from '@core/media/preparation-api.js';
import { editPagePath } from '@core/media/media-edit-api.js';

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

/** Step 4 of a finished preparation: nothing there is left to press (KBC-095). */
const FINISHED = {
  whole: () => $localize`:@@tracks.stepFinished:Passo 4 de 4: Concluído`,
  short: () => $localize`:@@tracks.stepFinishedShort:4/4 Concluído`,
};

/** "Passo 2 de 4: Processar", also the page's title. */
export const stepTitle = (step: PreparationStep): string => WHOLE[step]();

/**
 * Where the person is in "Preparar áudio" (T20, UP-20): an ordered list with done steps
 * marked in text, future ones saying why they are closed, and step 3 "não pedido" when the
 * person chose not to divide. On a phone, "2/4 Processar" opens the whole list.
 */
@Component({
  selector: 'app-preparation-steps',
  imports: [RouterLink],
  template: `
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
    <ol
      class="steps"
      [class.open]="expanded()"
      aria-label="Preparar áudio"
      i18n-aria-label="@@tracks.flow"
    >
      <li
        [class.done]="step() > 1"
        [attr.aria-current]="step() === 1 ? 'step' : null"
      >
        <span i18n="@@prep.step.name1">1 Enviar e escolher</span>
        @if (step() > 1) {
          ✓
        }
      </li>
      <li
        [class.done]="step() > 2"
        [attr.aria-current]="step() === 2 ? 'step' : null"
      >
        @if (step() > 2 && mediaId()) {
          <a [routerLink]="processLink()" i18n="@@prep.step.name2"
            >2 Processar</a
          >
        } @else {
          <span i18n="@@prep.step.name2">2 Processar</span>
        }
        @if (step() > 2) {
          ✓
        }
      </li>
      <li
        [class.done]="step() > 3"
        [class.skipped]="skipped()"
        [attr.aria-current]="step() === 3 && !skipped() ? 'step' : null"
      >
        @if (skipped()) {
          <span i18n="@@prep.step.skipped">3 Validar faixas — não pedido</span>
        } @else if (step() > 3 && mediaId()) {
          <a [routerLink]="validateLink()" i18n="@@tracks.step3"
            >3 Validar faixas</a
          >
          ✓
        } @else {
          <span i18n="@@tracks.step3">3 Validar faixas</span>
        }
      </li>
      <li
        [class.done]="finished()"
        [attr.aria-current]="step() === 4 ? 'step' : null"
      >
        @if (finished()) {
          <span i18n="@@tracks.step4Finished">4 Concluído</span>
          ✓
        } @else if (skipped()) {
          <span i18n="@@prep.step.conclude">4 Concluir</span>
        } @else {
          <span i18n="@@tracks.step4">4 Aprovar</span>
        }
      </li>
    </ol>
    @if (why(); as reason) {
      <p class="why">{{ reason }}</p>
    }
  `,
  styleUrl: './preparation-steps.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  protected readonly expanded = signal(false);
  protected readonly whole = computed(() =>
    this.finished() ? FINISHED.whole() : WHOLE[this.step()](),
  );
  protected readonly short = computed(() =>
    this.finished() ? FINISHED.short() : SHORT[this.step()](),
  );
  protected readonly processLink = computed(() =>
    preparationPagePath(this.mediaId()),
  );
  protected readonly validateLink = computed(() =>
    editPagePath(this.mediaId()),
  );
  /** Future steps are not links, and this says why (AC-5). */
  protected readonly why = computed(() => {
    const step = this.step();
    if (step === 1)
      return $localize`:@@prep.step.why1:Os próximos passos abrem depois do envio.`;
    if (step === 2 && !this.processed())
      return $localize`:@@prep.step.why2:O próximo passo fica disponível quando o processamento terminar.`;
    return '';
  });
}

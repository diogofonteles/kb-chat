import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import type { OptionRefusal, TrackChoice } from '@kb-chat/contracts';
import { PlanForm } from './plan-form.js';
import { REFUSAL_TEXTS } from './preparation-labels.js';

/** A choice, its id for `aria-describedby` and why it is off. */
type Refusable = 'speakers' | 'manual' | 'ai' | 'subjects';

/**
 * "O que fazer com este áudio" (T20, step 1): each option in plain words with its estimate.
 * An option off stays focusable, with its reason in `aria-describedby` (UP-20, MA-23);
 * nothing that costs money comes ticked (BR-2), and the value is always in sight (DS-19).
 */
@Component({
  selector: 'app-preparation-options',
  imports: [DatePipe],
  templateUrl: './preparation-options.html',
  styleUrl: './preparation-options.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreparationOptions {
  private readonly locale = inject(LOCALE_ID);
  protected readonly form = inject(PlanForm);
  /** Disabled while the file is being sent. */
  readonly locked = input(false);

  protected readonly choices = this.form.choices;
  protected readonly offer = this.form.offer;
  protected readonly transcriberOff = computed(
    () => this.offer()?.transcriber === 'off',
  );
  protected readonly transcribeMinutes = computed(
    () => this.form.option('transcribe').minutes,
  );
  protected readonly speakersMinutes = computed(
    () => this.form.option('speakers').minutes,
  );
  protected readonly estimateText = computed(() => {
    const usd = this.offer()?.aiEstimateUsd ?? null;
    return usd === null ? '' : this.usd(usd);
  });
  protected readonly remainingText = computed(() => {
    const usd = this.offer()?.monthRemainingUsd ?? null;
    return usd === null ? '' : this.usd(usd);
  });
  protected readonly droppedText = computed(() => {
    const dropped = this.form.dropped();
    if (dropped === 'transcribe')
      return $localize`:@@prep.dropped.transcribe:Sem a transcrição não dá para indicar quem fala nem dividir em faixas.`;
    return dropped === 'speakers'
      ? $localize`:@@prep.dropped.speakers:Sem indicar quem fala não dá para propor as faixas com IA.`
      : '';
  });
  protected readonly summary = computed(() => summaryOf(this.form, this.usd));

  protected done(id: 'transcribe' | 'speakers'): boolean {
    return this.form.option(id).done;
  }

  protected refusal(id: Refusable): string {
    const refusal: OptionRefusal | null = this.form.refusalOf(id);
    return refusal ? REFUSAL_TEXTS[refusal]() : '';
  }

  protected isOff(id: Refusable): boolean {
    return this.locked() || this.form.refusalOf(id) !== null;
  }

  protected toggleTranscribe(event: Event): void {
    const box = event.target as HTMLInputElement;
    if (this.locked()) box.checked = this.choices().transcribe;
    else this.form.setTranscribe(box.checked);
  }

  protected toggleSpeakers(event: Event): void {
    const box = event.target as HTMLInputElement;
    if (this.isOff('speakers')) box.checked = this.choices().speakers;
    else this.form.setSpeakers(box.checked);
  }

  /** `aria-disabled` keeps it focusable; the click just does nothing. */
  protected chooseTracks(event: Event, tracks: TrackChoice): void {
    const refused = this.locked() || (tracks !== 'none' && this.isOff(tracks));
    if (refused) event.preventDefault();
    else this.form.setTracks(tracks);
  }

  private readonly usd = (value: number): string =>
    new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: value < 0.01 ? 4 : 2,
    }).format(value);
}

/** "Depois do envio: transcrever, indicar quem fala…": changes with the choices (UP-01). */
function summaryOf(form: PlanForm, usd: (value: number) => string): string {
  const { transcribe, speakers, tracks } = form.choices();
  const asked = [
    transcribe ? $localize`:@@prep.summary.transcribe:transcrever` : '',
    speakers ? $localize`:@@prep.summary.speakers:indicar quem fala` : '',
    tracks === 'ai' ? $localize`:@@prep.summary.ai:propor faixas com IA` : '',
    tracks === 'manual'
      ? $localize`:@@prep.summary.manual:você marca as faixas`
      : '',
  ].filter(Boolean);
  if (asked.length === 0)
    return $localize`:@@prep.summary.nothing:Depois do envio: só guardar o áudio.`;
  const minutes =
    (transcribe ? (form.option('transcribe').minutes ?? 0) : 0) +
    (speakers ? (form.option('speakers').minutes ?? 0) : 0);
  const estimate = form.offer()?.aiEstimateUsd ?? null;
  const costs = [
    minutes > 0
      ? $localize`:@@prep.summary.minutes:≈ ${minutes}:minutes: min`
      : '',
    tracks === 'ai' && estimate !== null
      ? $localize`:@@prep.summary.usd:≈ ${usd(estimate)}:value:`
      : '',
  ].filter(Boolean);
  const list = asked.join(', ');
  const cost = costs.length > 0 ? ` (${costs.join(', ')})` : '';
  return tracks === 'none'
    ? $localize`:@@prep.summary.plain:Depois do envio: ${list}:list:${cost}:cost:.`
    : $localize`:@@prep.summary.validate:Depois do envio: ${list}:list:${cost}:cost: e você valida as faixas.`;
}

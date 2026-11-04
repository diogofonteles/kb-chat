import type {
  MediaPreparation,
  PreparationStage,
  PreparationStep,
  StageState,
} from '@kb-chat/contracts';
import { STAGE_NAMES, failureText } from './preparation-labels.js';
import { stepTitle } from './preparation-steps.js';

/** At most one sentence of new tracks in this long (BR-9). */
export const TRACKS_ANNOUNCE_MS = 15_000;

const MOVING: ReadonlySet<StageState> = new Set([
  'waiting',
  'queued',
  'running',
]);

/** Something is still to come: another read follows this one. */
export const hasMovingStage = (stages: readonly PreparationStage[]): boolean =>
  stages.some(({ state }) => MOVING.has(state));

const stageSentence = (stage: PreparationStage): string | null => {
  const name = STAGE_NAMES[stage.stage]();
  if (stage.state === 'running')
    return $localize`:@@prep.say.started:${name}:stage: começou.`;
  if (stage.state === 'done')
    return $localize`:@@prep.say.done:${name}:stage: terminou.`;
  if (stage.state === 'failed')
    return `${name}: ${failureText(stage.failure ?? 'work')}`;
  return null;
};

const tracksSentence = (fresh: number, total: number): string =>
  fresh === 1
    ? $localize`:@@prep.say.trackOne:1 faixa nova; ${total}:total: até agora.`
    : $localize`:@@prep.say.tracks:${fresh}:fresh: faixas novas; ${total}:total: até agora.`;

/**
 * What the screen reader hears on step 2 (BR-9): a sentence when the step changes or a stage
 * starts, ends or fails, and at most one about new tracks each 15 s; never the percentages.
 * The first read only sets where things stand, and the last says the tracks still unsaid,
 * since no read comes after it.
 */
export class PreparationAnnouncer {
  private states: ReadonlyMap<string, StageState> | null = null;
  private step: PreparationStep | null = null;
  private tracks = 0;
  private tracksSaidAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly clock: () => number = Date.now) {}

  /** The sentence this new reading deserves; empty when it deserves none. */
  observe(preparation: MediaPreparation): string {
    const { stages, tracks, step } = preparation;
    const before = this.states;
    const stepBefore = this.step;
    this.states = new Map(stages.map((one) => [one.stage, one.state]));
    this.step = step;
    if (!before || step !== stepBefore) {
      this.tracks = tracks.length;
      return before ? stepTitle(step) : '';
    }
    const changes = stages
      .filter((one) => before.get(one.stage) !== one.state)
      .map(stageSentence)
      .filter((sentence) => sentence !== null);
    const last = !hasMovingStage(stages);
    return [...changes, this.newTracks(tracks.length, last)]
      .filter((sentence) => sentence !== '')
      .join(' ');
  }

  private newTracks(total: number, last: boolean): string {
    const fresh = total - this.tracks;
    const now = this.clock();
    const tooSoon = now - this.tracksSaidAt < TRACKS_ANNOUNCE_MS;
    if (fresh <= 0 || (tooSoon && !last)) return '';
    this.tracks = total;
    this.tracksSaidAt = now;
    return tracksSentence(fresh, total);
  }
}

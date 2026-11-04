import type {
  MediaPreparation,
  PreparationStage,
  StageState,
} from '@kb-chat/contracts';
import { STAGE_NAMES, failureText } from './preparation-labels.js';

/** At most one sentence of new tracks in this long (BR-9). */
export const TRACKS_ANNOUNCE_MS = 15_000;

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
 * What the screen reader hears on step 2 (BR-9): a sentence when a stage starts, ends or
 * fails, and at most one about new tracks each 15 s; never the percentages. The first read
 * only sets where things stand.
 */
export class PreparationAnnouncer {
  private states: ReadonlyMap<string, StageState> | null = null;
  private tracks = 0;
  private tracksSaidAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly clock: () => number = Date.now) {}

  /** The sentence this new reading deserves; empty when it deserves none. */
  observe(preparation: MediaPreparation): string {
    const { stages, tracks } = preparation;
    const before = this.states;
    this.states = new Map(stages.map((one) => [one.stage, one.state]));
    if (!before) {
      this.tracks = tracks.length;
      return '';
    }
    const changes = stages
      .filter((one) => before.get(one.stage) !== one.state)
      .map(stageSentence)
      .filter((sentence) => sentence !== null);
    return [...changes, this.newTracks(tracks.length)]
      .filter((sentence) => sentence !== '')
      .join(' ');
  }

  private newTracks(total: number): string {
    const fresh = total - this.tracks;
    const now = this.clock();
    if (fresh <= 0 || now - this.tracksSaidAt < TRACKS_ANNOUNCE_MS) return '';
    this.tracks = total;
    this.tracksSaidAt = now;
    return tracksSentence(fresh, total);
  }
}

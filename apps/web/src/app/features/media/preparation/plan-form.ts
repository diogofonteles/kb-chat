import { httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import {
  preparationOptionsSchema,
  type OptionRefusal,
  type PreparationOption,
  type PreparationOptionId,
  type PreparationPlanRequest,
  type TrackChoice,
} from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { preparationOptionsUrl } from '@core/media/preparation-api.js';
import {
  isGuided,
  planOf,
  recalledChoices,
  rememberChoices,
  withSpeakers,
  withTracks,
  withTranscribe,
  type DroppedBy,
  type PlanChoices,
} from './plan-choices.js';

/** What decides the estimates: the recording, or the file's length read in the browser. */
export interface PlanTarget {
  readonly mediaId?: string;
  readonly durationMs?: number;
}

const NO_OPTION: PreparationOption = {
  done: false,
  refusal: null,
  minutes: null,
};

/**
 * The choices of "O que fazer com este áudio" (T20, step 1): the server says what the person
 * may ask and what it costs; the page holds what they ticked. Shared by the upload panel and
 * by an audio already sent (AC-16).
 */
@Injectable()
export class PlanForm {
  private readonly session = inject(SessionStore);
  private readonly target = signal<PlanTarget>({});
  private readonly ticked = signal<PlanChoices>(
    recalledChoices(this.session.can('media-edit')),
  );
  private readonly droppedBy = signal<DroppedBy>(null);
  /** A file whose length the browser could not read: no value, so no paid option (BR-4). */
  private readonly unreadable = signal(false);

  private readonly resource = httpResource(
    () => {
      const { mediaId, durationMs } = this.target();
      const params: Record<string, string | number> = {};
      if (mediaId) params['mediaId'] = mediaId;
      if (durationMs) params['durationMs'] = durationMs;
      return { url: preparationOptionsUrl, params };
    },
    { parse: (body) => preparationOptionsSchema.parse(body) },
  );

  readonly offer = computed(() =>
    this.resource.hasValue() ? this.resource.value() : null,
  );
  readonly dropped = this.droppedBy.asReadonly();
  /** What goes on the plan: an option off or done is never asked for. */
  readonly choices = computed<PlanChoices>(() => {
    const ticked = this.ticked();
    return {
      transcribe:
        ticked.transcribe && !this.option('transcribe').done,
      speakers:
        ticked.speakers &&
        !this.option('speakers').done &&
        this.refusalOf('speakers') === null,
      tracks: this.allowedTracks(ticked.tracks),
      subjects: false,
    };
  });
  readonly plan = computed<PreparationPlanRequest>(() =>
    planOf(this.choices(), this.offer()?.aiEstimateUsd ?? null),
  );
  readonly guided = computed(() => isGuided(this.choices()));
  /** Nothing is left to ask of this recording (AC-16). */
  readonly nothingLeft = computed(() => {
    const offer = this.offer();
    if (!offer) return false;
    const { transcribe, speakers, manual } = offer.options;
    return transcribe.done && speakers.done && manual.done;
  });

  aim(target: PlanTarget): void {
    this.target.set(target);
    this.unreadable.set(false);
  }

  /** The browser could not read this file's length. */
  lengthUnknown(): void {
    this.target.set({});
    this.unreadable.set(true);
  }

  private allowedTracks(tracks: TrackChoice): TrackChoice {
    if (tracks === 'manual' && this.refusalOf('manual') === null)
      return 'manual';
    if (tracks === 'ai' && this.refusalOf('ai') === null) return 'ai';
    return 'none';
  }

  /** What the server says of an option; nothing until it answers. */
  option(id: PreparationOptionId): PreparationOption {
    return this.offer()?.options[id] ?? NO_OPTION;
  }

  /** Why an option cannot be ticked now (BR-3): the server's reason, then the dependency. */
  refusalOf(id: 'speakers' | 'manual' | 'ai' | 'subjects'): OptionRefusal | null {
    const server = this.option(id).refusal;
    if (server) return server;
    const hasWords = this.ticked().transcribe || this.option('transcribe').done;
    const hasVoices = this.ticked().speakers || this.option('speakers').done;
    if (!hasWords) return 'dependency';
    if (id === 'ai' && !hasVoices) return 'dependency';
    if (id === 'subjects' && this.ticked().tracks === 'none')
      return 'dependency';
    if (id === 'ai' && this.unreadable()) return 'no-estimate';
    return null;
  }

  setTranscribe(on: boolean): void {
    this.apply(withTranscribe(this.ticked(), on));
  }

  setSpeakers(on: boolean): void {
    this.apply(withSpeakers(this.ticked(), on));
  }

  setTracks(tracks: TrackChoice): void {
    this.ticked.update((now) => withTracks(now, tracks));
    this.droppedBy.set(null);
  }

  /** The next upload starts from these, except what costs money (BR-2). */
  remember(): void {
    rememberChoices(this.ticked());
  }

  private apply(change: {
    readonly choices: PlanChoices;
    readonly dropped: DroppedBy;
  }): void {
    this.ticked.set(change.choices);
    this.droppedBy.set(change.dropped);
  }
}

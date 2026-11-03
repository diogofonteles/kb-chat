import { formatDate } from '@angular/common';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  LOCALE_ID,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  MAX_VOICES,
  mediaSpeakersSchema,
  type DiarizationStatus,
  type MediaSpeakers,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { seenAtFormat } from '@core/i18n/date-formats.js';
import { SpeakersApi, speakersUrl } from '@core/media/speakers-api.js';
import { EMPTY, distinctUntilChanged, interval, switchMap } from 'rxjs';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { SLOW_POLL_FACTOR } from '../media-labels.js';
import { VoiceTag } from './voice-tag.js';

type Label = (speakers: MediaSpeakers, locale: string) => string;

/** Why a separation waits, after "Aguardando o transcritor" (AC-9: none is marked). */
const WAITING: Record<MediaSpeakers['transcriber'], Label> = {
  on: () => $localize`:@@voices.waiting:Aguardando o transcritor`,
  off: (speakers, locale) =>
    speakers.transcriberOffSince
      ? $localize`:@@voices.waitingOff:Aguardando o transcritor · desligado desde ${formatDate(speakers.transcriberOffSince, seenAtFormat(), locale)}:date:`
      : $localize`:@@voices.waiting:Aguardando o transcritor`,
  none: () =>
    $localize`:@@voices.noDiarizer:Nenhum transcritor separa vozes; marque em Transcritores`,
};

/** Where the separation is, in words (UP-20). */
const STATUS: Record<DiarizationStatus, Label> = {
  none: () => '',
  waiting: (speakers, locale) =>
    WAITING[speakers.transcriber](speakers, locale),
  diarizing: () => $localize`:@@voices.diarizing:Separando vozes…`,
  done: (speakers) =>
    $localize`:@@voices.done:Vozes separadas: ${speakers.diarization?.voiceCount ?? 0}:count:`,
  failed: () => $localize`:@@voices.failed:A separação de vozes falhou`,
};

/** How often to ask again: while it runs, as the conversion; while it waits, a minute. */
function pollEveryOf(speakers: MediaSpeakers | null, fastMs: number) {
  if (speakers?.status === 'diarizing') return fastMs;
  if (speakers?.status === 'waiting' && speakers.transcriber === 'on')
    return fastMs * SLOW_POLL_FACTOR;
  return null;
}

/** "3", "", or null when the field holds something that is not 1 to 10 (MA-23). */
function parseVoices(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= MAX_VOICES
    ? value
    : 'invalid';
}

/**
 * "Vozes" on the audio page (screens.md T15; KBC-064 FR-1, FR-4): for whoever edits
 * recordings. Asks the Mac to separate the voices, with an optional number of voices,
 * follows the job in words and lists the voices found. The labels in the transcript
 * itself come with KBC-038's panel (`app-voice-tag`, `voiceChangeStarts`).
 */
@Component({
  selector: 'app-voices-panel',
  imports: [VoiceTag],
  templateUrl: './voices-panel.html',
  styleUrl: './voices-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoicesPanel {
  readonly mediaId = input.required<string>();
  private readonly api = inject(SpeakersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);
  private readonly pollMs = inject(MEDIA_POLL_MS);

  protected readonly speakers = httpResource(
    () => speakersUrl(this.mediaId()),
    { parse: (body) => mediaSpeakersSchema.parse(body) },
  );
  protected readonly current = computed<MediaSpeakers | null>(() =>
    this.speakers.hasValue() ? this.speakers.value() : null,
  );
  protected readonly statusText = computed(() => {
    const speakers = this.current();
    return speakers ? STATUS[speakers.status](speakers, this.locale) : '';
  });
  protected readonly diarization = computed(
    () => this.current()?.diarization ?? null,
  );
  protected readonly voices = computed(() =>
    (this.diarization()?.voices ?? []).map((one) => ({
      voice: one.voice,
      spoken: formatClock(one.speakingMs),
    })),
  );
  /** Nothing waits or runs and there is no transcript yet: why the button is missing. */
  protected readonly needsTranscript = computed(() => {
    const speakers = this.current();
    return (
      speakers !== null &&
      !speakers.canRequest &&
      speakers.status !== 'waiting' &&
      speakers.status !== 'diarizing'
    );
  });
  protected readonly actionLabel = computed(() =>
    this.diarization()
      ? $localize`:@@voices.again:Separar vozes de novo`
      : $localize`:@@voices.request:Separar vozes`,
  );
  protected readonly maxVoices = MAX_VOICES;
  protected readonly voicesText = signal('');
  protected readonly invalid = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal('');

  constructor() {
    this.pollWhileWorking();
  }

  protected editVoices(event: Event): void {
    this.voicesText.set((event.target as HTMLInputElement).value);
    this.invalid.set(false);
  }

  protected request(event: Event): void {
    event.preventDefault();
    const voices = parseVoices(this.voicesText());
    if (voices === 'invalid') return this.invalid.set(true);
    this.busy.set(true);
    this.failure.set('');
    this.api
      .diarize(this.mediaId(), voices)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (speakers) => this.settle(speakers),
        error: (err: unknown) => this.requestFailed(err),
      });
  }

  protected reload(): void {
    this.speakers.reload();
  }

  private settle(speakers: MediaSpeakers): void {
    this.busy.set(false);
    this.voicesText.set('');
    this.speakers.set(speakers);
  }

  /** Someone asked meanwhile (409): the block shows that one; anything else, a retry. */
  private requestFailed(err: unknown): void {
    this.busy.set(false);
    if (err instanceof HttpErrorResponse && err.status === 409) {
      this.speakers.reload();
      return;
    }
    this.failure.set(
      $localize`:@@voices.requestFailed:Não consegui pedir a separação. Tente de novo.`,
    );
  }

  private pollWhileWorking(): void {
    const every = computed(() => pollEveryOf(this.current(), this.pollMs));
    toObservable(every)
      .pipe(
        distinctUntilChanged(),
        switchMap((ms) => (ms === null ? EMPTY : interval(ms))),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.speakers.reload());
  }
}

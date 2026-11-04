import { DOCUMENT, formatDate } from '@angular/common';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  outputFromObservable,
  takeUntilDestroyed,
  toObservable,
} from '@angular/core/rxjs-interop';
import {
  MAX_VOICES,
  authorListSchema,
  collectionSpeakerListSchema,
  mediaSpeakersSchema,
  type DiarizationStatus,
  type MediaSpeakers,
  type VoiceLabel,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { seenAtFormat } from '@core/i18n/date-formats.js';
import { authorsUrl } from '@core/media/authors-api.js';
import { mediaStreamUrl } from '@core/media/media-api.js';
import {
  SpeakersApi,
  collectionSpeakersUrl,
  speakersUrl,
} from '@core/media/speakers-api.js';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  distinctUntilChanged,
  filter,
  interval,
  map,
  of,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { SLOW_POLL_FACTOR } from '../media-labels.js';
import { CollectionSpeakers } from './collection-speakers.js';
import { audienceLabel } from './speaker-names.js';
import { SpeakerCombobox } from './speaker-combobox.js';
import type { SpeakerChoice } from './speaker-suggestions.js';
import { sampleOf } from './voice-changes.js';
import { VoiceSample } from './voice-sample.js';
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

/** The voice chosen in a select; null for its blank option. */
function voiceOf(event: Event): number | null {
  const value = Number((event.target as HTMLSelectElement).value);
  return value > 0 ? value : null;
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

/** What the field shows for a voice; '' with no name. */
function fieldTextOf(label: VoiceLabel | undefined): string {
  if (label?.kind === 'person') return label.name ?? '';
  return label?.kind === 'audience' ? audienceLabel() : '';
}

/** What a voice's name changes to. */
interface VoiceChange {
  readonly speakerId: string | null;
  readonly audience: boolean;
}

/** A voice with no name. */
const NO_LABEL: VoiceChange = { speakerId: null, audience: false };

/**
 * "Vozes" on the audio page (screens.md T15; KBC-064 FR-1, FR-4; KBC-065): for whoever edits
 * recordings. Asks the Mac to separate the voices, with an optional number of voices,
 * follows the job in words, lists the voices found and says who each one is. The labels in
 * the transcript itself are KBC-038's panel's: `separated` and `renamed` tell the page to
 * read the transcript's voices again.
 */
@Component({
  selector: 'app-voices-panel',
  imports: [CollectionSpeakers, SpeakerCombobox, VoiceTag],
  providers: [VoiceSample],
  templateUrl: './voices-panel.html',
  styleUrl: './voices-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoicesPanel {
  private readonly api = inject(SpeakersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly savedNote =
    viewChild<ElementRef<HTMLParagraphElement>>('savedNote');
  private readonly changes = new Subject<{
    readonly change: Observable<MediaSpeakers>;
    readonly done: string;
    readonly voice: number | null;
  }>();
  protected readonly sample = inject(VoiceSample);
  readonly mediaId = input.required<string>();
  /** The audio's collection: its speakers and authors (a sub-collection's are its parent's). */
  readonly topic = input.required<string>();
  /** A name or a join changed. */
  readonly renamed = output();
  /** The current separation's version, each time a new one is shown. */
  readonly separated = outputFromObservable(
    toObservable(computed(() => this.diarization()?.version ?? null)).pipe(
      filter((version): version is number => version !== null),
      distinctUntilChanged(),
    ),
  );

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
  /** A boolean, so a new state of the voices does not read the lists again. */
  private readonly hasVoices = computed(() => this.diarization() !== null);
  /** The lists the voices' fields offer, read once there are voices to name. */
  protected readonly speakerList = httpResource(
    () => (this.hasVoices() ? collectionSpeakersUrl(this.topic()) : undefined),
    { parse: (body) => collectionSpeakerListSchema.parse(body) },
  );
  private readonly authorList = httpResource(
    () => (this.hasVoices() ? authorsUrl(this.topic()) : undefined),
    { parse: (body) => authorListSchema.parse(body) },
  );
  protected readonly collectionSpeakers = computed(() =>
    this.speakerList.hasValue() ? this.speakerList.value().items : [],
  );
  protected readonly authors = computed(() =>
    this.authorList.hasValue() ? this.authorList.value().items : [],
  );
  protected readonly voices = computed(() => {
    const diarization = this.diarization();
    const labels = diarization?.labels ?? [];
    return (diarization?.voices ?? []).map((one) => {
      const label = labels.find(({ voice }) => voice === one.voice);
      return {
        voice: one.voice,
        spoken: formatClock(one.speakingMs),
        current: fieldTextOf(label),
      };
    });
  });
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
  /** Whose name failed to save: the message goes beside that field (T15). */
  private readonly failedVoice = signal<number | null>(null);
  protected readonly fieldFailure = computed(() => {
    const voice = this.failedVoice();
    const shown = this.voices().some((one) => one.voice === voice);
    return this.failure() && shown ? voice : null;
  });
  /** "Nome salvo." and the like: said after each change (UP-01). */
  protected readonly saved = signal('');
  protected readonly mergeVoice = signal<number | null>(null);
  protected readonly mergeInto = signal<number | null>(null);
  protected readonly mergeInvalid = signal(false);
  protected readonly mergeTargets = computed(() =>
    this.voices().filter(({ voice }) => voice !== this.mergeVoice()),
  );

  constructor() {
    this.pollWhileWorking();
    this.applyInOrder();
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
    this.failedVoice.set(null);
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

  protected playSample(voice: number): void {
    const range = sampleOf(this.diarization()?.turns ?? [], voice);
    if (range)
      this.sample.toggle({
        voice,
        src: mediaStreamUrl(this.mediaId()),
        ...range,
      });
  }

  /** Saves what the voice's field chose, registering the speaker first when needed. */
  protected nameVoice(voice: number, choice: SpeakerChoice): void {
    const version = this.diarization()?.version;
    if (version === undefined) return;
    this.apply(
      this.labelFor(choice).pipe(
        switchMap((label) =>
          this.api.nameVoice(this.mediaId(), voice, { version, ...label }),
        ),
      ),
      $localize`:@@voices.saved:Nome salvo.`,
      voice,
    );
  }

  protected chooseMergeVoice(event: Event): void {
    const voice = voiceOf(event);
    this.mergeVoice.set(voice);
    if (this.mergeInto() === voice) this.mergeInto.set(null);
    this.mergeInvalid.set(false);
  }

  protected chooseMergeInto(event: Event): void {
    this.mergeInto.set(voiceOf(event));
    this.mergeInvalid.set(false);
  }

  protected merge(event: Event): void {
    event.preventDefault();
    const version = this.diarization()?.version;
    const voice = this.mergeVoice();
    const into = this.mergeInto();
    if (version === undefined || voice === null || into === null)
      return this.mergeInvalid.set(true);
    this.apply(
      this.api.mergeVoices(this.mediaId(), { version, voice, into }),
      $localize`:@@voices.merged:Vozes juntadas.`,
    );
    this.mergeVoice.set(null);
    this.mergeInto.set(null);
  }

  /** Undoes a join (UP-07). */
  protected split(voice: number): void {
    const version = this.diarization()?.version;
    if (version === undefined) return;
    this.apply(
      this.api.splitVoice(this.mediaId(), { version, voice }),
      $localize`:@@voices.splitDone:Vozes separadas de novo.`,
    );
  }

  protected confirmNames(): void {
    const version = this.diarization()?.version;
    if (version === undefined) return;
    this.apply(
      this.api.confirmNames(this.mediaId(), version),
      $localize`:@@voices.confirmed:Nomes confirmados.`,
    );
  }

  /** A speaker's name or author changed: the list and every label are read again. */
  protected speakerChanged(): void {
    this.speakerList.reload();
    this.speakers.reload();
    this.renamed.emit();
  }

  /** What the chosen option saves; a new name or an author becomes a speaker first. */
  private labelFor(choice: SpeakerChoice): Observable<VoiceChange> {
    if (choice.kind === 'speaker')
      return of({ speakerId: choice.id, audience: false });
    if (choice.kind === 'audience')
      return of({ speakerId: null, audience: true });
    if (choice.kind === 'none') return of(NO_LABEL);
    const speaker =
      choice.kind === 'new'
        ? { name: choice.name }
        : { name: choice.author.name, authorSlug: choice.author.slug };
    return this.api.createSpeaker(this.topic(), speaker).pipe(
      map(({ id }) => {
        this.speakerList.reload();
        return { speakerId: id, audience: false };
      }),
    );
  }

  /**
   * Sends a change, after the ones before it: each answer is the whole state of the voices,
   * so they must arrive in order. Nothing is disabled meanwhile: that would drop the focus.
   */
  private apply(
    change: Observable<MediaSpeakers>,
    done: string,
    voice: number | null = null,
  ): void {
    this.failure.set('');
    this.saved.set('');
    this.changes.next({ change, done, voice });
  }

  private applyInOrder(): void {
    this.changes
      .pipe(
        concatMap(({ change, done, voice }) =>
          change.pipe(
            tap((speakers) => this.settleChange(speakers, done)),
            catchError((err: unknown) => {
              this.failedVoice.set(voice);
              this.changeFailed(err);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe();
  }

  private settleChange(speakers: MediaSpeakers, done: string): void {
    this.speakers.set(speakers);
    this.saved.set(done);
    this.renamed.emit();
    this.keepFocus();
  }

  /** The button pressed may be gone ("Confirmar nomes"): the note takes the focus (NG-30). */
  private keepFocus(): void {
    afterNextRender(
      () => {
        if (this.document.activeElement === this.document.body)
          this.savedNote()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  /** 409: the voices changed under the screen; it reads them again and says so. */
  private changeFailed(err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 409) {
      this.speakers.reload();
      this.failure.set(
        $localize`:@@voices.changed:As vozes mudaram. Veja de novo e repita.`,
      );
      return;
    }
    this.failure.set(
      $localize`:@@voices.saveFailed:Não consegui salvar. Tente de novo.`,
    );
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

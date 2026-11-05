import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  authorListSchema,
  collectionSpeakerListSchema,
  type MediaPreparation,
  type PreparationVoice,
  type VoiceSuggestion,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { authorsUrl } from '@core/media/authors-api.js';
import {
  SpeakersApi,
  collectionSpeakersUrl,
} from '@core/media/speakers-api.js';
import { of, switchMap, type Observable } from 'rxjs';
import { SpeakerCombobox } from '../voices/speaker-combobox.js';
import { audienceLabel } from '../voices/speaker-names.js';
import type { SpeakerChoice } from '../voices/speaker-suggestions.js';
import { voiceChangeOf, type VoiceChange } from '../voices/voice-change.js';
import { personText, spanText } from './preparation-labels.js';

const voiceLine = (voice: PreparationVoice): string => {
  const who = personText({ ...voice });
  const long = spanText(voice.speakingMs);
  return $localize`:@@prep.voice.line:${who}:who: — ${long}:length:`;
};

const nameOf = (suggestion: VoiceSuggestion): string =>
  personText({ ...suggestion, voice: suggestion.voice });

/** A suggestion as the option it would be in the field. */
const choiceOf = ({ audience, name }: VoiceSuggestion): SpeakerChoice => {
  if (audience) return { kind: 'audience' };
  return name === null ? { kind: 'none' } : { kind: 'new', name };
};

/** The voice who speaks most, when nobody named it: the first guess is the author (T20). */
function authorSuggestion({
  author,
  voices,
  suggestions,
  refusedVoices,
}: MediaPreparation): VoiceSuggestion | null {
  const top = voices.toSorted((a, b) => b.speakingMs - a.speakingMs)[0];
  if (!author || !top || top.name || top.audience) return null;
  if (refusedVoices.includes(top.voice)) return null;
  if (suggestions.some(({ voice }) => voice === top.voice)) return null;
  return {
    voice: top.voice,
    name: author,
    audience: false,
    reason: $localize`:@@prep.voice.authorReason:é o autor da gravação e a voz que mais fala`,
  };
}

/** A voice as a row: its line, what is suggested and what the field starts with. */
interface VoiceRow {
  readonly voice: number;
  readonly line: string;
  /** There is a name to correct: given, or suggested. */
  readonly hasName: boolean;
  readonly suggestion: VoiceSuggestion | null;
  readonly filled: string;
}

/**
 * "Vozes achadas" (T20), on steps 2 and 3: how long each voice speaks, who it is and who it
 * may be. A suggestion says why and names nobody until a person answers (KBC-067 BR-5):
 * accepting it, correcting it in the field of KBC-065, or refusing it. A name already given
 * stays correctable: a wrong one must never be a dead end (KBC-090).
 */
@Component({
  selector: 'app-preparation-voices',
  imports: [SpeakerCombobox],
  templateUrl: './preparation-voices.html',
  styleUrls: ['./preparation-buttons.css', './preparation-voices.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreparationVoices {
  private readonly api = inject(SpeakersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly corrections =
    viewChildren<ElementRef<HTMLElement>>('correction');
  private readonly field = viewChild(SpeakerCombobox);

  readonly preparation = input.required<MediaPreparation>();
  /** Runs before a name goes in: step 3 saves what is on screen first. */
  readonly beforeNaming = input<() => Observable<unknown>>(() => of(null));
  /** A name went in, or was refused: the screen reads the plan again. */
  readonly named = output();

  private readonly settled = signal<readonly number[]>([]);
  protected readonly error = signal('');
  /** The voice whose field is open. */
  protected readonly editing = signal<number | null>(null);
  /** A press on its way: read before anything else (PD-02). */
  protected readonly saving = signal(false);

  private readonly topic = computed(() => this.preparation().topic);
  private readonly speakerList = httpResource(
    () =>
      this.editing() === null ? undefined : collectionSpeakersUrl(this.topic()),
    { parse: (body) => collectionSpeakerListSchema.parse(body) },
  );
  private readonly authorList = httpResource(
    () => (this.editing() === null ? undefined : authorsUrl(this.topic())),
    { parse: (body) => authorListSchema.parse(body) },
  );
  protected readonly speakers = computed(() =>
    this.speakerList.hasValue() ? this.speakerList.value().items : [],
  );
  protected readonly authors = computed(() =>
    this.authorList.hasValue() ? this.authorList.value().items : [],
  );
  protected readonly listsLoading = computed(
    () => this.speakerList.isLoading() || this.authorList.isLoading(),
  );

  private readonly suggestions = computed(() => {
    const preparation = this.preparation();
    const guess = authorSuggestion(preparation);
    return [...preparation.suggestions, ...(guess ? [guess] : [])].filter(
      ({ voice }) => !this.settled().includes(voice),
    );
  });
  protected readonly rows = computed<VoiceRow[]>(() =>
    this.preparation().voices.map((voice) => {
      const suggestion =
        this.suggestions().find((one) => one.voice === voice.voice) ?? null;
      const given = voice.audience ? audienceLabel() : (voice.name ?? '');
      return {
        voice: voice.voice,
        line: voiceLine(voice),
        hasName: given !== '' || suggestion !== null,
        suggestion,
        filled: given || (suggestion ? nameOf(suggestion) : ''),
      };
    }),
  );

  protected nameOf(suggestion: VoiceSuggestion): string {
    return nameOf(suggestion);
  }

  protected acceptLabel(suggestion: VoiceSuggestion): string {
    const name = nameOf(suggestion);
    return $localize`:@@prep.voice.acceptLabel:Aceitar ${name}:name: para a Voz ${suggestion.voice}:voice:`;
  }

  protected refuseLabel({ voice }: VoiceSuggestion): string {
    return $localize`:@@prep.voice.refuseLabel:Recusar o nome sugerido para a Voz ${voice}:voice:`;
  }

  protected correctLabel({ voice, hasName }: VoiceRow): string {
    return hasName
      ? $localize`:@@prep.voice.correctLabel:Corrigir o nome da Voz ${voice}:voice:`
      : $localize`:@@prep.voice.nameLabel:Dar nome à Voz ${voice}:voice:`;
  }

  protected correct({ voice }: VoiceRow): void {
    if (this.saving()) return;
    this.error.set('');
    this.editing.set(voice);
    afterNextRender(() => this.field()?.focus(), { injector: this.injector });
  }

  protected cancel(voice: number): void {
    this.editing.set(null);
    this.focusRow(voice);
  }

  protected accept(suggestion: VoiceSuggestion): void {
    const change = voiceChangeOf(choiceOf(suggestion), (speaker) =>
      this.api.createSpeaker(this.topic(), speaker),
    );
    this.name(suggestion.voice, change);
  }

  /** The person's name for the voice: it stands for the suggestion too. */
  protected chosen(voice: number, choice: SpeakerChoice): void {
    const change = voiceChangeOf(choice, (speaker) =>
      this.api.createSpeaker(this.topic(), speaker),
    );
    this.name(voice, change);
  }

  private name(voice: number, change: Observable<VoiceChange>): void {
    const { mediaId, separation } = this.preparation();
    if (separation === null) return;
    this.run(
      voice,
      this.beforeNaming()().pipe(
        switchMap(() => change),
        switchMap((label) =>
          this.api.nameVoice(mediaId, voice, {
            version: separation,
            ...label,
          }),
        ),
      ),
    );
  }

  protected refuse({ voice }: VoiceSuggestion): void {
    const { mediaId, separation } = this.preparation();
    if (separation === null) return;
    this.run(
      voice,
      this.api.refuseName(mediaId, voice, { version: separation }),
    );
  }

  private run(voice: number, request: Observable<unknown>): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.settled.update((all) => [...all, voice]);
        this.editing.set(null);
        this.focusRow(voice);
        this.named.emit();
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.error.set(errorMessage(toUiErrorCode(err)));
      },
    });
  }

  /** The button pressed, or the field, may be gone: the focus stays on this voice. */
  private focusRow(voice: number): void {
    afterNextRender(
      () =>
        this.corrections()
          .find((one) => one.nativeElement.dataset['voice'] === String(voice))
          ?.nativeElement.focus(),
      { injector: this.injector },
    );
  }
}

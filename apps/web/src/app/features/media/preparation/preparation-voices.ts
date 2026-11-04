import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  MediaPreparation,
  PreparationVoice,
  VoiceSuggestion,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SpeakersApi } from '@core/media/speakers-api.js';
import { map, of, switchMap, type Observable } from 'rxjs';
import { personText, spanText } from './preparation-labels.js';

const voiceLine = (voice: PreparationVoice): string => {
  const who = personText({ ...voice });
  const long = spanText(voice.speakingMs);
  return $localize`:@@prep.voice.line:${who}:who: — ${long}:length:`;
};

/** The voice who speaks most, when nobody named it: the first guess is the author (T20). */
function authorSuggestion({
  author,
  voices,
  suggestions,
}: MediaPreparation): VoiceSuggestion | null {
  const top = voices.toSorted((a, b) => b.speakingMs - a.speakingMs)[0];
  if (!author || !top || top.name || top.audience) return null;
  if (suggestions.some(({ voice }) => voice === top.voice)) return null;
  return {
    voice: top.voice,
    name: author,
    audience: false,
    reason: $localize`:@@prep.voice.authorReason:é o autor da gravação e a voz que mais fala`,
  };
}

/**
 * "Vozes achadas" of step 2 (T20): how long each voice speaks and who it may be. A suggestion
 * says why and names nobody until a person accepts it (KBC-067 BR-5).
 */
@Component({
  selector: 'app-preparation-voices',
  template: `
    <h3 class="title" i18n="@@prep.voices.found">
      Vozes achadas: {{ preparation().voices.length }}
    </h3>
    <ul class="voices">
      @for (voice of preparation().voices; track voice.voice) {
        <li>{{ lineOf(voice) }}</li>
      }
    </ul>
    @if (suggestions().length > 0) {
      <ul class="suggestions">
        @for (suggestion of suggestions(); track suggestion.voice) {
          <li>
            <span>
              <span i18n="@@prep.voice.seems"
                >Voz {{ suggestion.voice }} parece ser</span
              >
              {{ nameOf(suggestion) }}
              <span class="reason">— {{ suggestion.reason }}</span>
            </span>
            <button
              type="button"
              class="secondary"
              (click)="accept(suggestion)"
              i18n="@@tracks.ai.accept"
            >
              Aceitar
            </button>
          </li>
        }
      </ul>
    }
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
  `,
  styleUrl: './preparation-voices.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreparationVoices {
  private readonly api = inject(SpeakersApi);
  private readonly destroyRef = inject(DestroyRef);
  readonly preparation = input.required<MediaPreparation>();
  /** A name went in: the screen reads the plan again. */
  readonly named = output();

  private readonly accepted = signal<readonly number[]>([]);
  protected readonly error = signal('');
  protected readonly suggestions = computed(() => {
    const preparation = this.preparation();
    const guess = authorSuggestion(preparation);
    return [...preparation.suggestions, ...(guess ? [guess] : [])].filter(
      ({ voice }) => !this.accepted().includes(voice),
    );
  });

  protected lineOf(voice: PreparationVoice): string {
    return voiceLine(voice);
  }

  protected nameOf(suggestion: VoiceSuggestion): string {
    return personText({ ...suggestion, voice: suggestion.voice });
  }

  protected accept(suggestion: VoiceSuggestion): void {
    const { mediaId, separation } = this.preparation();
    if (separation === null) return;
    this.error.set('');
    this.speakerOf(suggestion)
      .pipe(
        switchMap((speakerId) =>
          this.api.nameVoice(mediaId, suggestion.voice, {
            version: separation,
            speakerId,
            audience: suggestion.audience,
          }),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.accepted.update((all) => [...all, suggestion.voice]);
          this.named.emit();
        },
        error: (err: unknown) =>
          this.error.set(errorMessage(toUiErrorCode(err))),
      });
  }

  /** The collection's speaker of that name; asking twice answers with the same one. */
  private speakerOf(suggestion: VoiceSuggestion): Observable<string | null> {
    if (suggestion.audience || suggestion.name === null) return of(null);
    return this.api
      .createSpeaker(this.preparation().topic, { name: suggestion.name })
      .pipe(map((speaker) => speaker.id));
  }
}

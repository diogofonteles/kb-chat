import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  MAX_VOICES,
  mediaEditSchema,
  mediaListSchema,
  mediaSpeakersSchema,
  type MediaItem,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { mediaListUrl, mediaStreamUrl } from '@core/media/media-api.js';
import { editPagePath, mediaEditUrl } from '@core/media/media-edit-api.js';
import { SpeakersApi, speakersUrl } from '@core/media/speakers-api.js';
import { TracksStore } from '@core/media/tracks-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import {
  coverCode,
  coverGradient,
  UiButton,
  UiIcon,
  UiIconButton,
} from '@ui/index.js';
import { BookmarkList } from '../bookmark-list.js';
import { ArchivedTracks } from '../track-edit/archived-tracks.js';
import { TrackPreparationStatus } from '../tracks/track-preparation.js';
import { TrackNavList } from '../tracks/track-nav-list.js';
import { sampleOf } from '../voices/voice-changes.js';
import { VoiceSample } from '../voices/voice-sample.js';
import { VoiceTag } from '../voices/voice-tag.js';
import { parseVoices } from '../voices/voices-panel.js';

/**
 * "Sobre este áudio" (KBC-129, v2 · Mídia — Player): the cards beside the player — "Seus
 * marcadores aqui", "Faixas desta gravação", the voices found (for who edits), the removed
 * tracks and "Sobre a autora". The Sobre tab of the player's right panel on a desktop
 * (PlayerPanel), inline under the full-screen player on a phone. Only data that exists
 * (BR-4): no "Seguir" (KBC-135).
 */
@Component({
  selector: 'app-player-about',
  imports: [
    RouterLink,
    BookmarkList,
    ArchivedTracks,
    TrackNavList,
    TrackPreparationStatus,
    UiButton,
    UiIcon,
    UiIconButton,
    VoiceTag,
  ],
  providers: [VoiceSample],
  template: `
    <div class="card">
      <app-bookmark-list />
    </div>
    @if (canEdit() || hasTracks()) {
      <div class="card" [hidden]="!hasTracks()">
        <app-track-nav-list
          heading="Faixas desta gravação"
          i18n-heading="@@tracks.nav.ofRecording"
        />
        @if (applied(); as text) {
          <p class="applied">
            <span>{{ text }} ·</span>
            <a [routerLink]="editLink()" i18n="@@tracks.entry.see"
              >Ver edição</a
            >
          </p>
          <app-track-preparation [mediaId]="media().id" />
        }
      </div>
    }
    @if (canEdit()) {
      <!-- Cards, not regions: the Vozes view is the region of that name. -->
      <div class="card">
        <h3 id="about-voices-title" i18n="@@voices.title">Vozes</h3>
        @if (voices().length) {
          <p class="quiet line" i18n="@@player.about.voicesFound">
            Vozes separadas: {{ voices().length }}
          </p>
          <ul class="voices">
            @for (one of voices(); track one.voice) {
              <li>
                <app-voice-tag [voice]="one.voice" [round]="true" />
                <span class="spoken" i18n="@@voices.spoken"
                  >{{ one.spoken }} de fala</span
                >
                <button
                  uiIconButton="circle"
                  type="button"
                  class="sample"
                  [size]="28"
                  [attr.aria-label]="sampleLabel(one.voice)"
                  (click)="playSample(one.voice)"
                >
                  <ui-icon
                    [name]="sample.playing() === one.voice ? 'pause' : 'play'"
                    [size]="12"
                  />
                </button>
              </li>
            }
          </ul>
        } @else if (transcribed()) {
          <p class="quiet" i18n="@@player.about.voicesNone">
            Marca onde muda a voz que fala. Vale só para esta gravação.
          </p>
          @if (waitingText(); as text) {
            <p class="quiet" role="status">{{ text }}</p>
          } @else if (canRequest()) {
            <!-- pRight voicesCard 'none': the count and "Separar vozes" in the card. -->
            <form class="separate" novalidate (submit)="separate($event)">
              <label for="about-voices-count" i18n="@@voices.countLabel"
                >Número de vozes (opcional)</label
              >
              <div class="count">
                <input
                  id="about-voices-count"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  placeholder="De 1 a 10"
                  i18n-placeholder="@@player.about.countPlaceholder"
                  [value]="voicesText()"
                  [attr.aria-invalid]="invalid() ? 'true' : null"
                  [attr.aria-describedby]="
                    invalid() ? 'about-voices-error' : null
                  "
                  (input)="editVoices($event)"
                />
              </div>
              <button
                uiButton="outline"
                size="sm"
                type="submit"
                [disabled]="busy()"
                i18n="@@voices.request"
              >
                Separar vozes
              </button>
            </form>
            @if (invalid()) {
              <p
                id="about-voices-error"
                class="error"
                i18n="@@voices.countInvalid"
              >
                Informe um número de 1 a {{ maxVoices }}, ou deixe em branco.
              </p>
            }
            @if (failure()) {
              <p class="error" role="alert">{{ failure() }}</p>
            }
          }
        } @else {
          <p class="quiet" i18n="@@player.about.voicesWait">
            Dá para separar as vozes quando a transcrição estiver pronta.
          </p>
        }
      </div>
      <app-archived-tracks class="archived" [recordingId]="media().id" />
    }
    @if (media().author; as person) {
      <div class="card">
        <h3 id="about-author-title" i18n="@@nowPlaying.aboutAuthor">
          Sobre a autora
        </h3>
        <div class="person">
          <span
            class="avatar"
            aria-hidden="true"
            [style.background]="authorTint()"
            >{{ authorInitials() }}</span
          >
          <div>
            <p class="person-name">{{ person.name }}</p>
            @if (authorCount(); as count) {
              <p class="quiet line">{{ count }}</p>
            }
          </div>
        </div>
      </div>
    }
  `,
  styleUrl: './player-about.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlayerAbout {
  readonly media = input.required<MediaItem>();
  /** Who edits recordings: the voices, the edit's state and the removed tracks. */
  readonly canEdit = input(false);
  protected readonly sample = inject(VoiceSample);
  private readonly chat = inject(ChatStore);

  /** The recording's approved tracks (KBC-066 FR-9), as the player plays them. */
  private readonly tracks = inject(TracksStore);
  protected readonly hasTracks = computed(
    () => this.tracks.tracks().length > 0,
  );
  private readonly tracksCount = computed(() => {
    const edit = this.edit.hasValue() ? this.edit.value() : null;
    return edit?.status === 'approved' ? edit.approvedTracks : 0;
  });

  private readonly edit = httpResource(
    () => (this.canEdit() ? mediaEditUrl(this.media().id) : undefined),
    { parse: (body) => mediaEditSchema.parse(body) },
  );
  protected readonly editLink = computed(() => editPagePath(this.media().id));
  /** "3 faixas aplicadas" once the edit is approved. */
  protected readonly applied = computed(() => {
    const count = this.tracksCount();
    if (count === 0) return '';
    return count === 1
      ? $localize`:@@tracks.entry.appliedOne:1 faixa aplicada`
      : $localize`:@@tracks.entry.applied:${count}:count: faixas aplicadas`;
  });

  private readonly speakers = httpResource(
    () => (this.canEdit() ? speakersUrl(this.media().id) : undefined),
    { parse: (body) => mediaSpeakersSchema.parse(body) },
  );
  private readonly diarization = computed(() =>
    this.speakers.hasValue() ? this.speakers.value().diarization : null,
  );
  protected readonly voices = computed(() =>
    (this.diarization()?.voices ?? []).map((one) => ({
      voice: one.voice,
      spoken: formatClock(one.speakingMs),
    })),
  );
  protected readonly transcribed = computed(
    () =>
      this.media().status === 'ready' &&
      this.media().transcription.version !== null,
  );

  /** The author's avatar (avatar 48): the initials on the name's own colour. */
  protected readonly authorInitials = computed(() =>
    coverCode(this.media().author?.name ?? ''),
  );
  protected readonly authorTint = computed(() => {
    const name = this.media().author?.name;
    return name ? coverGradient(name)[0] : null;
  });

  /** Other media of the collection, to count the author's. */
  private readonly collection = httpResource(
    () => (this.media().author ? mediaListUrl(this.media().topic) : undefined),
    { parse: (body) => mediaListSchema.parse(body).items },
  );
  protected readonly authorCount = computed(() => {
    const author = this.media().author;
    if (!author || !this.collection.hasValue()) return '';
    const count = this.collection
      .value()
      .filter((one) => one.author?.slug === author.slug).length;
    const where =
      this.chat.topicList().find((topic) => topic.slug === this.media().topic)
        ?.title ?? '';
    if (!where)
      return count === 1
        ? $localize`:@@nowPlaying.oneAudio:1 áudio neste acervo`
        : $localize`:@@nowPlaying.audios:${count}:count: áudios neste acervo`;
    return count === 1
      ? $localize`:@@player.about.oneAudioIn:1 áudio em ${where}:collection:`
      : $localize`:@@player.about.audiosIn:${count}:count: áudios em ${where}:collection:`;
  });

  protected readonly canRequest = computed(
    () => this.speakers.hasValue() && this.speakers.value().canRequest,
  );
  /** A separation asked and not done yet: said in words in the card (UP-20). */
  protected readonly waitingText = computed(() => {
    const status = this.speakers.hasValue()
      ? this.speakers.value().status
      : 'none';
    if (status === 'waiting')
      return $localize`:@@voices.waiting:Aguardando o transcritor`;
    if (status === 'diarizing')
      return $localize`:@@voices.diarizing:Separando vozes…`;
    return '';
  });
  protected readonly maxVoices = MAX_VOICES;
  protected readonly voicesText = signal('');
  protected readonly invalid = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal('');
  private readonly api = inject(SpeakersApi);
  private readonly destroyRef = inject(DestroyRef);

  protected editVoices(event: Event): void {
    this.voicesText.set((event.target as HTMLInputElement).value);
    this.invalid.set(false);
  }

  /** "Separar vozes" from the card, as the Vozes view asks it (KBC-064 FR-1). */
  protected separate(event: Event): void {
    event.preventDefault();
    const voices = parseVoices(this.voicesText());
    if (voices === 'invalid') return this.invalid.set(true);
    this.busy.set(true);
    this.failure.set('');
    this.api
      .diarize(this.media().id, voices)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (speakers) => {
          this.busy.set(false);
          this.speakers.set(speakers);
        },
        error: () => {
          this.busy.set(false);
          this.failure.set(
            $localize`:@@player.about.separateFailed:Não consegui pedir a separação. Tente de novo.`,
          );
        },
      });
  }

  protected sampleLabel(voice: number): string {
    return this.sample.playing() === voice
      ? $localize`:@@voices.sampleStop:Parar amostra da Voz ${voice}:voice:`
      : $localize`:@@voices.sample:Ouvir amostra da Voz ${voice}:voice:`;
  }

  protected playSample(voice: number): void {
    const range = sampleOf(this.diarization()?.turns ?? [], voice);
    if (range)
      this.sample.toggle({
        voice,
        src: mediaStreamUrl(this.media().id),
        ...range,
      });
  }
}

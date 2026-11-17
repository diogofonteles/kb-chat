import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  mediaItemSchema,
  mediaTranscriptSchema,
  mediaTranscriptWordsSchema,
  type AnswerSource,
  type MediaItem,
  type Topic,
  type TrackPassage,
} from '@kb-chat/contracts';
import { formatClock, minuteLink } from '@kb-chat/player-core';
import { toUiErrorCode } from '@core/api/api-error.js';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { speak } from '@core/i18n/spoken-time.js';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { MediaEngine } from '@core/media/media-engine.js';
import {
  mediaPagePath,
  mediaStreamUrl,
  mediaTranscriptUrl,
  mediaUrl,
} from '@core/media/media-api.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { passageOf } from '@features/answer/answer-format.js';
import { UiButton, UiIconButton } from '@ui/button.js';
import { UiCover, coverGradient } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';
import { distinctUntilChanged, filter } from 'rxjs';
import {
  playbackStartOf,
  type PassageFocus,
} from '../search-hit/passage-focus.js';
import { TranscriptPanel } from '../transcript/transcript-panel.js';
import { voiceLookOf } from '../voices/voice-changes.js';
import {
  aroundPassage,
  citedRange,
  lineStateAt,
  timelineMarks,
  type ContextLine,
  type LineSpeaker,
} from './passage-context.js';

interface Target {
  readonly media: MediaItem;
  readonly startMs: number;
}

/** A word of the cited passage, lit once it is spoken (item 3). */
interface CitedWord {
  readonly key: string;
  readonly text: string;
  readonly startMs: number;
}

/** Codes that say the track is not there for this person: one message for all (PD-07). */
const GONE_CODES: readonly string[] = [
  'MEDIA_NOT_FOUND',
  'FORBIDDEN',
  'NOT_FOUND',
];

/** The most segments one request for words may ask (TRANSCRIPT_WORDS_MAX_SEGMENTS). */
const MAX_WORD_SEGMENTS = 200;

/** The track is in the conversation's collection, or one of its sub-collections. */
const withinTopic = (topic: string, conversation: string): boolean =>
  !conversation ||
  topic === conversation ||
  topic.startsWith(`${conversation}/`);

const sameTarget = (a: Target, b: Target): boolean =>
  a.media.id === b.media.id && a.startMs === b.startMs;

const LINK_NOT_COPIED = (): string =>
  $localize`:@@trackPassage.linkFailed:Não foi possível copiar o link.`;

/**
 * The audio source of a research answer (KBC-150, v2 · Pesquisa com IA — fonte de áudio; it
 * began as KBC-099's "Trecho da faixa", T22). The cited passage comes first, with "Ouvir o
 * trecho" playing it on the app's own player (the bar on a desktop, the sheet's strip on a
 * phone): the panel has no player of its own. Below, the track's timeline with the answer's
 * citations of it, and only the speech around the passage, followed as it plays. Nothing
 * plays by itself (FR-8); the vault's Markdown is never shown (ADR 0035 §7).
 */
@Component({
  selector: 'app-track-passage-panel',
  imports: [
    RouterLink,
    TranscriptPanel,
    UiButton,
    UiCover,
    UiIcon,
    UiIconButton,
  ],
  templateUrl: './track-passage-panel.html',
  styleUrl: './track-passage-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.role]': "inSheet() ? 'tabpanel' : 'dialog'",
    '[attr.aria-modal]': "inSheet() ? null : 'false'",
    '[attr.aria-label]': 'inSheet() ? null : dialogLabel()',
    '[attr.aria-labelledby]': 'inSheet() ? labelledBy() : null',
    '[class.in-sheet]': 'inSheet()',
    '(keydown.escape)': 'closed.emit()',
  },
})
export class TrackPassagePanel {
  private readonly engine = inject(MediaEngine);
  private readonly saver = inject(ProgressSaver);
  private readonly bookmarks = inject(BookmarksStore);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly source = input.required<AnswerSource>();
  /** The time the citation wrote ("" for a plain [n] or the chip). */
  readonly at = input('');
  /**
   * The conversation's collection: a track moved out of it (and its sub-collections) is gone
   * for this answer, as the research would no longer find it there. Empty skips the check.
   */
  readonly topic = input('');
  /** The collections the person sees: the track's own one is named in its line. */
  readonly topics = input<readonly Topic[]>([]);
  /** The answer's cited sources, in [n] order: "Fonte n de N" and ‹ ›. Empty for a search. */
  readonly sources = input<readonly AnswerSource[]>([]);
  /** A document was open when the track opened over it (T22 flow 1). */
  readonly canGoBack = input(false);
  /** In the phone's reading sheet: its tabs name and close it (KBC-150 item 8). */
  readonly inSheet = input(false);
  /** The sheet's tab that names this panel. */
  readonly labelledBy = input<string | null>(null);
  /** Focus the title on open; not when a tab chose it (the tab keeps the focus). */
  readonly focusTitle = input(true);
  readonly closed = output();
  readonly back = output();
  /** ‹ › chose another source of the answer. */
  readonly sourceChosen = output<AnswerSource>();

  private readonly heading =
    viewChild.required<ElementRef<HTMLHeadingElement>>('heading');
  private readonly scroller =
    viewChild.required<ElementRef<HTMLElement>>('scroller');

  protected readonly mediaId = computed(
    () => this.source().media?.mediaId ?? '',
  );
  protected readonly item = httpResource(() => mediaUrl(this.mediaId()), {
    parse: (body) => mediaItemSchema.parse(body),
  });
  /**
   * Archived, or moved out of the conversation's collection: the API still answers for its
   * page (BR-5), but the answer's track is no longer there (QA BUG-1, PD-07).
   */
  private readonly left = computed(() => {
    if (!this.item.hasValue()) return false;
    const media = this.item.value();
    return media.archived || !withinTopic(media.topic, this.topic());
  });
  private readonly media = computed(() =>
    this.item.hasValue() && !this.left() ? this.item.value() : null,
  );
  protected readonly transcript = httpResource(
    () => {
      const media = this.media();
      const version = media?.transcription.version ?? null;
      return media?.status === 'ready' && version !== null
        ? { url: mediaTranscriptUrl(media.id), params: { v: version } }
        : undefined;
    },
    { parse: (body) => mediaTranscriptSchema.parse(body) },
  );

  /** The answer's citations of this track, in its order (several: marks and "Outro trecho"). */
  protected readonly passages = computed(() => this.source().passages ?? []);
  /** The passage the citation named; a mark or "Outro trecho citado" picks another. */
  private readonly chosen = linkedSignal(() => {
    const opened = passageOf(this.source(), this.at());
    return opened ? this.passages().indexOf(opened) : -1;
  });
  /** The cited passage, exact from media.db; null for an answer saved before KBC-099. */
  private readonly stored = computed(
    (): TrackPassage | null => this.passages()[this.chosen()] ?? null,
  );
  /** The passage the citation opened on: the player is cued there once (FR-8). */
  private readonly opened = computed(() => passageOf(this.source(), this.at()));
  /**
   * The stored passage no longer falls on any segment of the current transcript (the track
   * was edited after the answer): T22 says so and starts the track from the beginning.
   */
  protected readonly passageMoved = computed(() => {
    const passage = this.stored();
    if (!passage || !this.transcript.hasValue()) return false;
    return citedRange(this.transcript.value().segments, passage) === null;
  });
  protected readonly passage = computed(() =>
    this.passageMoved() ? null : this.stored(),
  );
  /** What the full transcript paints and scrolls to; none without a resolved passage. */
  protected readonly focus = computed((): PassageFocus | null => {
    const passage = this.passage();
    return passage
      ? {
          mediaId: this.mediaId(),
          startMs: passage.startMs,
          endMs: passage.endMs,
        }
      : null;
  });
  private readonly startMs = computed(() => this.passage()?.startMs ?? 0);
  protected readonly clock = computed(() => formatClock(this.startMs()));
  /** "0:41–1:10": the passage's span on the track. */
  protected readonly span = computed(() => {
    const passage = this.passage();
    return passage
      ? `${formatClock(passage.startMs)}–${formatClock(passage.endMs)}`
      : '';
  });
  /** "Trecho da faixa O que é o ritmo?, aos 41 segundos" (AC-12). */
  protected readonly dialogLabel = computed(() =>
    this.passage()
      ? $localize`:@@trackPassage.label:Trecho da faixa ${this.source().title}:title:, aos ${speak(this.startMs())}:clock:`
      : $localize`:@@trackPassage.labelStart:Trecho da faixa ${this.source().title}:title:`,
  );

  /* ---------- Head: "Fonte n de N · Áudio", ‹ ›, the track ---------- */

  protected readonly place = computed(() =>
    this.sources().findIndex((one) => one.n === this.source().n),
  );
  protected readonly kindLabel = computed(() => {
    const at = this.place();
    return at < 0
      ? $localize`:@@trackPassage.kind:Faixa de áudio`
      : $localize`:@@trackPassage.sourceOf:Fonte ${at + 1}:n: de ${this.sources().length}:total: · Áudio`;
  });
  protected readonly previous = computed(
    () => this.sources()[this.place() - 1] ?? null,
  );
  protected readonly next = computed(() => {
    const at = this.place();
    return at < 0 ? null : (this.sources()[at + 1] ?? null);
  });
  protected readonly navigable = computed(() => this.sources().length > 1);
  /**
   * "Irmã Helena Prado · Alquimia Prática · 1:00 · faixa 8 de 25 · Palestra de 12/03/2017"
   * (item 2): a track also names the recording it was cut from.
   */
  protected readonly metaLine = computed(() => {
    const source = this.source();
    const media = this.item.hasValue() ? this.item.value() : null;
    const author =
      media?.author?.name ??
      AUTHORSHIP_LABELS[source.authorship ?? 'outros-autores'];
    const collection = media
      ? this.topics().find((one) => one.slug === media.topic)?.title
      : undefined;
    const duration = media?.durationMs ?? source.media?.durationMs ?? null;
    const place = source.media;
    const ordinal =
      place?.ordinal && place.total
        ? $localize`:@@trackPassage.ordinal:faixa ${place.ordinal}:ordinal: de ${place.total}:total:`
        : '';
    return [
      author,
      collection,
      duration ? formatClock(duration) : '',
      ordinal,
      place?.kind === 'track' ? place.recordingTitle : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });
  protected readonly low = computed(
    () => this.source().media?.confidence === 'low',
  );
  /** The card takes the cover's own colour while it plays (item 3). */
  protected readonly coverTint = computed(
    () => coverGradient(this.source().title)[0],
  );
  /** "Abrir a faixa" and ⤢: the track page 2 s before the passage (`?t=`, KBC-038 FR-5). */
  protected readonly pageQuery = computed(() => ({
    t: Math.floor(playbackStartOf({ startMs: this.startMs() }) / 1000),
  }));
  protected readonly ready = computed(() => this.media()?.status === 'ready');
  protected readonly loaded = computed(() => this.media() !== null);
  /** Archived, deleted or out of reach: one sentence, the same for all (PD-07). */
  protected readonly gone = computed(() => {
    if (this.left()) return true;
    const err = this.item.error();
    return err !== undefined && GONE_CODES.includes(toUiErrorCode(err));
  });
  protected readonly loadError = computed(() => {
    if (!this.item.error() && !this.left()) return '';
    return this.gone()
      ? $localize`:@@trackPassage.gone:Esta faixa não está mais disponível.`
      : $localize`:@@trackPassage.failed:Não foi possível abrir a faixa.`;
  });

  /* ---------- Playback, on the app's one engine ---------- */

  /** The engine holds this track (cued on open): the buttons act on it. */
  protected readonly ours = computed(
    () => this.engine.source()?.id === this.mediaId() && this.mediaId() !== '',
  );
  protected readonly playing = computed(
    () => this.ours() && this.engine.playing(),
  );
  private readonly nowMs = computed(() =>
    this.ours() ? this.engine.playback().currentMs : this.startMs(),
  );
  protected readonly nowClock = computed(() => formatClock(this.nowMs()));
  /** Within the cited passage (with its 2 s lead-in) while it plays: "Tocando o trecho". */
  protected readonly inPassage = computed(() => {
    const passage = this.passage();
    const now = this.nowMs();
    return (
      passage !== null && now >= playbackStartOf(passage) && now < passage.endMs
    );
  });
  protected readonly durationMs = computed(
    () =>
      this.media()?.durationMs ??
      this.source().media?.durationMs ??
      this.engine.playback().durationMs ??
      0,
  );
  protected readonly total = computed(() => formatClock(this.durationMs()));
  protected readonly playedPercent = computed(() => {
    const total = this.durationMs();
    return total > 0 ? Math.min(100, (this.nowMs() / total) * 100) : 0;
  });

  /* ---------- The cited passage, word by word ---------- */

  private readonly range = computed(() => {
    const passage = this.passage();
    return passage && this.transcript.hasValue()
      ? citedRange(this.transcript.value().segments, passage)
      : null;
  });
  /** The words of the cited segments (KBC-045): they light up as they are spoken. */
  private readonly words = httpResource(
    () => {
      const media = this.media();
      const range = this.range();
      if (!media || !range) return undefined;
      return {
        url: `${mediaTranscriptUrl(media.id)}/words`,
        params: {
          from: range.first,
          count: Math.min(MAX_WORD_SEGMENTS, range.last - range.first + 1),
        },
      };
    },
    { parse: (body) => mediaTranscriptWordsSchema.parse(body) },
  );
  protected readonly lines = computed((): ContextLine[] => {
    const passage = this.passage();
    return passage && this.transcript.hasValue()
      ? aroundPassage(this.transcript.value(), passage)
      : [];
  });
  protected readonly cited = computed(
    () => this.lines().find((one) => one.kind === 'cited') ?? null,
  );
  /**
   * The passage as words with their times; a segment without word times is one "word" at its
   * start (it lights whole).
   */
  protected readonly citedWords = computed((): CitedWord[] => {
    const range = this.range();
    if (!range || !this.transcript.hasValue()) return [];
    const segments = this.transcript.value().segments;
    const words = this.words.hasValue() ? this.words.value().words : [];
    const out: CitedWord[] = [];
    for (let index = range.first; index <= range.last; index += 1) {
      const segment = segments[index];
      if (!segment || segment.restricted) continue;
      const own = words.filter(
        (word) => word.segment === index && word.text.trim(),
      );
      if (own.length === 0)
        out.push({
          key: `${index}`,
          text: segment.text.trim(),
          startMs: segment.startMs,
        });
      else
        own.forEach((word, at) =>
          out.push({
            key: `${index}-${at}`,
            text: word.text.trim(),
            startMs: word.startMs,
          }),
        );
    }
    return out;
  });
  /** How many of the passage's words have been spoken, while it plays. */
  protected readonly spokenCount = computed(() => {
    if (!this.playing()) return 0;
    const now = this.nowMs();
    return this.citedWords().filter((word) => word.startMs <= now).length;
  });
  protected readonly speaker = computed(() => this.cited()?.speaker ?? null);

  /* ---------- Timeline and other passages ---------- */

  protected readonly marks = computed(() =>
    timelineMarks(this.passages(), this.durationMs()),
  );
  protected readonly chosenIndex = this.chosen.asReadonly();
  /** "Outro trecho citado: [n] 0:45": the answer's other citations of this track (item 6). */
  protected readonly others = computed(() =>
    this.passage()
      ? this.passages()
          .map((one, index) => ({ index, clock: formatClock(one.startMs) }))
          .filter(({ index }) => index !== this.chosen())
      : [],
  );

  /* ---------- "Em volta do trecho" / "Transcrição completa" ---------- */

  /** The whole transcript, with its search, in place of the lines around (item 5). */
  protected readonly full = linkedSignal({
    source: this.mediaId,
    computation: () => false,
  });

  /** No lines around (no passage, or it moved): the whole transcript straight away. */
  protected readonly showFull = computed(
    () => this.full() || this.lines().length === 0,
  );

  /** The track and where to cue it, once it is ready and the transcript settled. */
  private readonly target = computed((): Target | null => {
    const media = this.media();
    // A cited passage waits for the transcript: it says whether the passage still falls
    // on the track, so the player is cued once, on the right place (T22 "Faixa editada").
    const settling = this.opened() !== null && this.transcript.isLoading();
    if (media?.status !== 'ready' || media.id !== this.mediaId() || settling)
      return null;
    const opened = this.opened();
    const moved =
      opened !== null &&
      this.transcript.hasValue() &&
      citedRange(this.transcript.value().segments, opened) === null;
    return { media, startMs: opened && !moved ? opened.startMs : 0 };
  });

  /** The buttons that play wait only for the track to be ready, never for the player. */
  protected readonly playable = computed(() => this.target() !== null);

  constructor() {
    toObservable(this.target)
      .pipe(
        filter((one): one is Target => one !== null),
        distinctUntilChanged(sameTarget),
        takeUntilDestroyed(),
      )
      .subscribe((one) => this.cue(one));
    // A new source brings the reader to the top, on its title (T22 flow 1); again once the
    // track arrives, after the phone's sheet opened and took the focus to its first control.
    afterRenderEffect(() => {
      this.source();
      this.loaded();
      this.scroller().nativeElement.scrollTop = 0;
      if (untracked(this.focusTitle))
        this.heading().nativeElement.focus({ preventScroll: true });
    });
  }

  protected voiceColor(speaker: LineSpeaker): string {
    return `var(--color-voice-${voiceLookOf(speaker.voice).tone})`;
  }

  protected lineState(line: ContextLine): 'past' | 'now' | 'idle' {
    return lineStateAt(line, this.nowMs(), this.playing());
  }

  protected clockOf(ms: number): string {
    return formatClock(ms);
  }

  /** "Trecho citado aos 45 segundos": a mark on the timeline. */
  protected markLabel(ms: number): string {
    return $localize`:@@trackPassage.markAt:Trecho citado aos ${speak(ms)}:clock:`;
  }

  /** "Ouvir de 16 segundos": a time in "Em volta do trecho". */
  protected playFromLabel(ms: number): string {
    return $localize`:@@trackPassage.playFrom:Ouvir a partir de ${speak(ms)}:clock:`;
  }

  /** "Outro trecho citado, em 0:45". */
  protected otherLabel(clock: string): string {
    return $localize`:@@trackPassage.otherAt:Outro trecho citado, em ${clock}:clock:`;
  }

  protected reload(): void {
    this.item.reload();
  }

  protected choose(source: AnswerSource | null): void {
    if (source) this.sourceChosen.emit(source);
  }

  /** "Ouvir o trecho": from 2 s before it, on the app's player; "Pausar" while it plays. */
  protected listen(): void {
    if (this.playing()) {
      this.engine.pause();
      return;
    }
    const passage = this.passage();
    const from = passage ? playbackStartOf(passage) : 0;
    const now = this.nowMs();
    if (!this.recue(from) && passage && !(now >= from && now < passage.endMs))
      this.engine.seek(from);
    this.play();
  }

  /** "Faixa toda": the track from its start. */
  protected playWhole(): void {
    this.playFrom(0);
  }

  /** A time in "Em volta do trecho": plays from there, on this track only. */
  protected playFrom(ms: number): void {
    if (!this.recue(ms)) this.engine.seek(ms);
    this.play();
  }

  /** A mark or "Outro trecho citado": that passage, cued, playing on if it was. */
  protected goTo(index: number): void {
    const passage = this.passages()[index];
    if (!passage) return;
    this.chosen.set(index);
    const at = playbackStartOf(passage);
    if (!this.recue(at)) this.engine.seek(at);
  }

  /** A bookmark at the passage's start (KBC-042, item 3), on this track. */
  protected mark(): void {
    this.recue(playbackStartOf({ startMs: this.startMs() }));
    if (this.ours()) this.bookmarks.markAt(this.startMs());
  }

  /** The track's page at the passage, as a link to share (`?t=`, KBC-038 FR-5). */
  protected share(): void {
    const clipboard = this.document.defaultView?.navigator.clipboard;
    if (!clipboard) {
      this.announcer.say(LINK_NOT_COPIED());
      return;
    }
    const page = this.document.location.origin + mediaPagePath(this.mediaId());
    // The browser's clipboard is a Promise API; both outcomes are said (TS-14).
    void clipboard.writeText(minuteLink(page, this.startMs())).then(
      () =>
        this.announcer.say(
          $localize`:@@trackPassage.linkCopied:Link do trecho copiado.`,
        ),
      () => this.announcer.say(LINK_NOT_COPIED()),
    );
  }

  /** 🔍 or "Transcrição completa": the whole transcript; 🔍 lands in its search. */
  protected openFull(search: boolean): void {
    this.full.set(true);
    if (!search) return;
    afterNextRender(
      () =>
        this.host
          .querySelector<HTMLInputElement>('app-transcript-panel input')
          ?.focus(),
      { injector: this.injector },
    );
  }

  /** The player 2 s before the passage, paused, "Ouvir o trecho" ready (FR-8, T22 flow 2). */
  private cue({ media, startMs }: Target): void {
    const at = playbackStartOf({ startMs });
    if (this.engine.source()?.id !== media.id) {
      this.load(media, at);
      return;
    }
    this.engine.pause();
    this.engine.seek(at);
  }

  /**
   * The bar was closed or another media took the app's player: this track goes back on it,
   * paused at `atMs`, so the panel never acts on another media. True when it was loaded.
   */
  private recue(atMs: number): boolean {
    const target = this.target();
    if (this.ours() || !target) return false;
    this.load(target.media, atMs);
    return true;
  }

  /** Plays only this track: nothing when it could not be put back on the player. */
  private play(): void {
    if (this.ours()) this.engine.play();
  }

  private load(media: MediaItem, at: number): void {
    this.saver.startFrom(media);
    this.engine.load(
      {
        id: media.id,
        title: media.title,
        src: mediaStreamUrl(media.id, media.parent?.fileVersion),
        durationMs: media.durationMs,
        artist: media.author?.name ?? AUTHORSHIP_LABELS['outros-autores'],
        ...(media.parent ? { fileVersion: media.parent.fileVersion } : {}),
        ...(media.hidden ? { hidden: media.hidden } : {}),
      },
      at,
    );
  }
}

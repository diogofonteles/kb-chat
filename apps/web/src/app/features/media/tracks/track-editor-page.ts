import { httpResource } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  Injector,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  collectionSpeakerListSchema,
  editWordsSchema,
  mediaEditSchema,
  mediaItemSchema,
  mediaSilencesSchema,
  mediaTranscriptSchema,
  mediaWaveformSchema,
  type DraftTrack,
  type TrackKind,
  type TrackProblem,
  type VoiceLabel,
} from '@kb-chat/contracts';
import {
  canSplit,
  joinTracks,
  newTrackSpan,
  selectedSpan,
  snapPointsOf,
  splitPointNear,
  withHandle,
  NUDGE_MS,
  type TrackEdge,
} from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  MediaEditApi,
  editWordsUrl,
  mediaEditUrl,
  mediaWaveformUrl,
} from '@core/media/media-edit-api.js';
import {
  mediaPagePath,
  mediaTranscriptUrl,
  mediaUrl,
} from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { collectionSpeakersUrl } from '@core/media/speakers-api.js';
import { filter, map } from 'rxjs';
import { audienceLabel } from '../voices/speaker-names.js';
import { TrackAudition, endRange, startRange } from './track-audition.js';
import { TrackDraft, numbered, problemsOf } from './track-draft.js';
import { formatBoundary } from './track-labels.js';
import { TrackProposals } from './track-proposals.js';
import {
  TrackRowList,
  problemLabel,
  type PersonChange,
  type PersonChoice,
} from './track-row-list.js';
import { TrackTimeline, type ListenKind } from './track-timeline.js';
import { TrackTranscript, type TextSpan } from './track-transcript.js';

/** How long "Faixa 5 apagada · Desfazer" stays (screen spec: 10 s). */
const UNDO_NOTICE_MS = 10_000;

interface DeletedNotice {
  readonly ordinal: number;
}

const decodePeaks = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

const voiceChoice = (label: VoiceLabel): PersonChoice => {
  const number = $localize`:@@voices.voice:Voz ${label.voice}:number:`;
  const name = label.kind === 'audience' ? audienceLabel() : label.name;
  return {
    value: `v${label.voice}`,
    label: name ? `${number}: ${name}` : number,
  };
};

const touched = (track: DraftTrack): DraftTrack => ({ ...track, edited: true });

const copyableText = (tracks: readonly DraftTrack[]): string =>
  numbered(tracks)
    .map(
      ({ track, ordinal }) =>
        `${ordinal}. ${formatBoundary(track.startMs)} – ${formatBoundary(track.endMs)} ${track.title ?? ''}`,
    )
    .join('\n');

/**
 * "Preparar áudio", steps 3 and 4 (T20, KBC-066): the person checks each track against the
 * sound and the words, and only "Aprovar faixas" applies them (BR-1). The draft lives on the
 * server: leaving, reloading or another device come back to the same step (BR-6).
 */
@Component({
  selector: 'app-track-editor-page',
  imports: [
    RouterLink,
    TrackTimeline,
    TrackRowList,
    TrackTranscript,
    TrackProposals,
  ],
  templateUrl: './track-editor-page.html',
  styleUrl: './track-editor-page.css',
  providers: [TrackDraft, TrackAudition],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'pageKey($event)' },
})
export class TrackEditorPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(MediaEditApi);
  private readonly session = inject(SessionStore);
  private readonly engine = inject(MediaEngine);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  protected readonly draft = inject(TrackDraft);
  protected readonly audition = inject(TrackAudition);

  private readonly timeline = viewChild(TrackTimeline);
  private readonly list = viewChild(TrackRowList);
  private readonly audio = viewChild<ElementRef<HTMLAudioElement>>('audition');

  protected readonly id = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );
  private readonly item = httpResource(() => mediaUrl(this.id()), {
    parse: (body) => mediaItemSchema.parse(body),
  });
  private readonly edit = httpResource(() => mediaEditUrl(this.id()), {
    parse: (body) => mediaEditSchema.parse(body),
  });
  private readonly media = computed(() =>
    this.item.hasValue() ? this.item.value() : null,
  );
  private readonly transcriptVersion = computed(
    () => this.media()?.transcription.version ?? null,
  );
  private readonly transcript = httpResource(
    () => {
      const version = this.transcriptVersion();
      return version === null
        ? undefined
        : { url: mediaTranscriptUrl(this.id()), params: { v: version } };
    },
    { parse: (body) => mediaTranscriptSchema.parse(body) },
  );
  private readonly words = httpResource(
    () =>
      this.transcriptVersion() === null ? undefined : editWordsUrl(this.id()),
    { parse: (body) => editWordsSchema.parse(body) },
  );
  private readonly silences = httpResource(
    () => `${mediaUrl(this.id())}/silences`,
    { parse: (body) => mediaSilencesSchema.parse(body) },
  );
  private readonly waveform = httpResource(() => mediaWaveformUrl(this.id()), {
    parse: (body) => mediaWaveformSchema.parse(body),
  });
  private readonly speakers = httpResource(
    () => {
      const topic = this.media()?.topic;
      return topic ? collectionSpeakersUrl(topic) : undefined;
    },
    { parse: (body) => collectionSpeakerListSchema.parse(body) },
  );

  private readonly chosenId = signal<string | null>(null);
  protected readonly edge = signal<TrackEdge>('start');
  private readonly cursor = signal(0);
  protected readonly loaded = signal(false);
  /** A draft came back from the server: undo starts over, and the screen says so (BR-6). */
  protected readonly restored = signal(false);
  protected readonly showProblems = signal(false);
  protected readonly approving = signal(false);
  protected readonly notice = signal('');
  protected readonly deleted = signal<DeletedNotice | null>(null);
  protected readonly tab = signal<'tracks' | 'text'>('tracks');
  private readonly textSpan = signal<TextSpan | null>(null);
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly mediaLink = computed(() => mediaPagePath(this.id()));
  protected readonly title = computed(() => this.media()?.title ?? '');
  protected readonly topic = computed(() => this.media()?.topic ?? '');
  protected readonly durationMs = computed(() => this.media()?.durationMs ?? 0);
  protected readonly streamUrl = computed(
    () => `${mediaUrl(this.id())}/stream`,
  );
  protected readonly canPropose = computed(() =>
    this.session.can('media-edit-ai'),
  );
  private readonly editValue = computed(() =>
    this.edit.hasValue() ? this.edit.value() : null,
  );
  protected readonly step = computed(() =>
    this.editValue()?.status === 'approved' ? 4 : 3,
  );
  protected readonly run = computed(() => this.editValue()?.run ?? null);
  protected readonly voiceSuggestions = computed(
    () => this.editValue()?.voices ?? [],
  );
  /** A proposal is writing the draft: it can be watched, not changed (KBC-067 FR-3). */
  protected readonly readOnly = computed(
    () => this.run()?.status === 'running',
  );
  protected readonly hasProposals = computed(() =>
    this.draft.tracks().some((track) => track.source === 'ai' && !track.edited),
  );
  protected readonly transcriptChanged = computed(
    () => this.editValue()?.transcriptChanged === true,
  );
  protected readonly approvedCount = computed(
    () => this.editValue()?.approvedTracks ?? 0,
  );
  protected readonly speakerList = computed(() =>
    this.speakers.hasValue() ? this.speakers.value().items : [],
  );
  protected readonly separation = computed(() =>
    this.transcript.hasValue()
      ? (this.transcript.value().speakers?.version ?? null)
      : null,
  );
  protected readonly people = computed<PersonChoice[]>(() => {
    const labels = this.transcript.hasValue()
      ? (this.transcript.value().voiceNames ?? [])
      : [];
    return [
      ...labels.map(voiceChoice),
      ...this.speakerList().map((one) => ({
        value: `s${one.id}`,
        label: one.name,
      })),
    ];
  });
  protected readonly segments = computed(() =>
    this.transcript.hasValue() ? this.transcript.value().segments : [],
  );
  protected readonly wordList = computed(() =>
    this.words.hasValue() ? this.words.value().words : [],
  );
  protected readonly snap = computed(() =>
    snapPointsOf(
      this.wordList().map(([startMs, endMs]) => ({ startMs, endMs })),
      this.silences.hasValue() ? this.silences.value().intervals : [],
    ),
  );
  protected readonly peaks = computed(() => {
    if (!this.waveform.hasValue()) return null;
    const { status, peaks } = this.waveform.value();
    return status === 'ready' ? decodePeaks(peaks) : null;
  });
  protected readonly peaksPerSecond = computed(() =>
    this.waveform.hasValue() ? this.waveform.value().peaksPerSecond : 10,
  );
  protected readonly waveformPending = computed(
    () => this.peaks() === null && this.loaded(),
  );
  protected readonly selected = computed(() => {
    const all = this.draft.numbered();
    return (
      all.find(({ track }) => track.id === this.chosenId()) ?? all[0] ?? null
    );
  });
  protected readonly selectedSpanMs = computed<TextSpan | null>(
    () => this.selected()?.track ?? null,
  );
  protected readonly cursorMs = this.cursor.asReadonly();
  protected readonly count = computed(() => this.draft.tracks().length);
  protected readonly warningCount = computed(
    () => new Set(this.draft.problems().map((one) => one.trackId)).size,
  );
  protected readonly problemRows = computed(() =>
    this.draft.problems().map((one) => ({
      key: `${one.trackId}-${one.problem}`,
      problem: one,
      text: $localize`:@@tracks.problem.row:Faixa ${one.ordinal}:ordinal:: ${problemLabel(one.problem)}:problem:`,
    })),
  );
  protected readonly hasEdges = computed(
    () => this.selected() !== null && !this.readOnly(),
  );
  protected readonly selectionFits = computed(() => {
    const span = this.textSpan();
    return span !== null && this.spanFromText(span) !== null;
  });
  protected readonly copyable = computed(() =>
    copyableText(this.draft.tracks()),
  );
  protected readonly loadError = computed(() => {
    const err = this.edit.error() ?? this.item.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  protected readonly forbidden = computed(() => {
    const err = this.edit.error();
    return err !== undefined && toUiErrorCode(err) === 'FORBIDDEN';
  });

  constructor() {
    this.stopOtherPlayback();
    toObservable(computed(() => this.readyEdit()))
      .pipe(
        filter((edit) => edit !== null),
        takeUntilDestroyed(),
      )
      .subscribe((edit) => this.receive(edit));
    this.destroyRef.onDestroy(() => this.audition.stop());
  }

  /** The audio element arrives with the content: `attach` runs once. */
  protected audioReady(): void {
    const element = this.audio()?.nativeElement;
    if (element) this.audition.attach(element);
  }

  private readyEdit() {
    const edit = this.editValue();
    return edit && this.media() ? edit : null;
  }

  /** What plays elsewhere stops: one sound at a time, and these keys are this page's. */
  private stopOtherPlayback(): void {
    this.engine.pause();
    this.engine.unload();
  }

  private receive(edit: NonNullable<ReturnType<TrackEditorPage['readyEdit']>>) {
    if (this.loaded()) {
      this.draft.refresh(edit);
      return;
    }
    this.draft.load(edit, this.media()?.durationMs ?? null);
    this.restored.set(edit.started && edit.tracks.length > 0);
    this.loaded.set(true);
    afterNextRender(() => this.audioReady(), { injector: this.injector });
  }

  protected choose(id: string): void {
    this.chosenId.set(id);
    const track = this.draft.tracks().find((one) => one.id === id);
    if (track) this.cursor.set(track.startMs);
  }

  protected moveHandle(move: {
    trackId: string;
    edge: TrackEdge;
    ms: number;
  }): void {
    const moved = withHandle(this.draft.tracks(), move);
    this.draft.apply(
      moved.map((track) =>
        track.id === move.trackId ? touched(track) : track,
      ),
    );
  }

  protected nudge(direction: 1 | -1): void {
    this.timeline()?.nudge(this.edge(), direction * NUDGE_MS);
  }

  protected zoomIn(): void {
    this.timeline()?.zoomIn();
  }

  protected zoomOut(): void {
    this.timeline()?.zoomOut();
  }

  protected placeCursor(ms: number): void {
    this.cursor.set(ms);
    this.timeline()?.showAt(ms);
  }

  protected newTrack(): void {
    const span = newTrackSpan(this.draft.tracks(), {
      atMs: this.cursor(),
      durationMs: this.durationMs(),
    });
    if (span) this.addTrack(span);
    else
      this.say(
        $localize`:@@tracks.noRoom:Não há espaço para uma faixa aqui. Mova o cursor para um trecho livre.`,
      );
  }

  protected newFromText(): void {
    const span = this.textSpan();
    const fitting = span ? this.spanFromText(span) : null;
    if (!fitting) return;
    this.addTrack(fitting);
    this.textSpan.set(null);
  }

  protected noteText(span: TextSpan | null): void {
    this.textSpan.set(span);
  }

  private spanFromText(span: TextSpan) {
    return selectedSpan(this.draft.tracks(), {
      ...span,
      durationMs: this.durationMs(),
    });
  }

  private addTrack(span: { startMs: number; endMs: number }): void {
    const track: DraftTrack = {
      id: crypto.randomUUID(),
      runId: null,
      source: 'manual',
      edited: false,
      firstSegment: null,
      lastSegment: null,
      ...span,
      kind: 'qa',
      title: null,
      askerVoice: null,
      answererVoice: null,
      askerSpeakerId: null,
      answererSpeakerId: null,
    };
    this.draft.apply([...this.draft.tracks(), track]);
    this.chosenId.set(track.id);
    this.list()?.focusTitle();
  }

  protected rename(change: { id: string; title: string }): void {
    this.change(change.id, { title: change.title.trim() || null });
  }

  protected changeKind(change: { id: string; kind: TrackKind }): void {
    this.change(change.id, { kind: change.kind });
  }

  protected changePerson({ id, field, value }: PersonChange): void {
    const voice = value.startsWith('v') ? Number(value.slice(1)) : null;
    const speaker = value.startsWith('s') ? value.slice(1) : null;
    this.change(
      id,
      field === 'asker'
        ? { askerVoice: voice, askerSpeakerId: speaker }
        : { answererVoice: voice, answererSpeakerId: speaker },
    );
  }

  private change(id: string, fields: Partial<DraftTrack>): void {
    this.draft.apply(
      this.draft
        .tracks()
        .map((track) =>
          track.id === id ? touched({ ...track, ...fields }) : track,
        ),
    );
  }

  /** At the cursor, or the nearest point that keeps 5 s on each side (BR-4). */
  protected split(id: string): void {
    const tracks = this.draft.tracks();
    const track = tracks.find((one) => one.id === id);
    if (!track || !canSplit(track)) return;
    const ms = splitPointNear(track, this.cursor());
    const second: DraftTrack = {
      ...track,
      id: crypto.randomUUID(),
      runId: null,
      source: 'manual',
      edited: false,
      firstSegment: null,
      lastSegment: null,
      startMs: ms,
      title: null,
    };
    this.draft.apply([
      ...tracks.map((one) =>
        one.id === id ? touched({ ...one, endMs: ms }) : one,
      ),
      second,
    ]);
  }

  protected join(id: string): void {
    const joined = joinTracks(this.draft.tracks(), id);
    this.draft.apply(
      joined.map((track) => (track.id === id ? touched(track) : track)),
    );
  }

  /** No confirmation: "Desfazer" stays for 10 s (UP-07, MA-14). */
  protected remove(id: string): void {
    const row = this.draft.numbered().find(({ track }) => track.id === id);
    if (!row) return;
    this.draft.apply(this.draft.tracks().filter((one) => one.id !== id));
    this.deleted.set({ ordinal: row.ordinal });
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.deleted.set(null), UNDO_NOTICE_MS);
    this.list()?.focusRow();
  }

  protected undo(): void {
    this.draft.undo();
    this.deleted.set(null);
  }

  protected redo(): void {
    this.draft.redo();
  }

  protected listen(kind: ListenKind): void {
    const track = this.selected()?.track;
    if (!track) return;
    if (kind === 'track' && this.audition.playing()) {
      this.audition.stop();
      return;
    }
    const ranges: Record<ListenKind, () => { fromMs: number; toMs: number }> = {
      track: () => ({ fromMs: track.startMs, toMs: track.endMs }),
      start: () => startRange(track.startMs),
      end: () => endRange(track.endMs),
    };
    this.audition.play(ranges[kind]());
  }

  protected pageKey(event: KeyboardEvent): void {
    const inField =
      event.target instanceof Element &&
      event.target.closest('input, textarea, select') !== null;
    if (inField) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (event.key === '+') this.zoomIn();
    if (event.key === '-') this.zoomOut();
  }

  /** The only way to apply (BR-1): problems first, then the save, then the approval. */
  protected approve(): void {
    if (this.draft.problems().length > 0) {
      this.showProblem(this.draft.problems());
      return;
    }
    this.approving.set(true);
    this.draft.flush(() => this.sendApproval());
  }

  private sendApproval(): void {
    if (this.draft.save() === 'conflict') {
      this.approving.set(false);
      return;
    }
    this.api
      .approve(this.id(), this.draft.currentVersion)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ version }) => {
          this.draft.setVersion(version);
          this.approving.set(false);
          this.showProblems.set(false);
          this.edit.reload();
        },
        error: (err: unknown) => {
          this.approving.set(false);
          const problems = problemsOf(err);
          if (problems.length > 0) this.showProblem(problems);
          else this.say(errorMessage(toUiErrorCode(err)));
        },
      });
  }

  /** The list on top, and the focus where the first problem is fixed (FR-8, AC-11). */
  private showProblem(problems: readonly TrackProblem[]): void {
    this.showProblems.set(true);
    const first = problems[0];
    if (!first) return;
    this.chosenId.set(first.trackId);
    this.tab.set('tracks');
    if (first.problem === 'title') this.list()?.focusTitle();
    else this.list()?.focusRow();
  }

  protected reopen(): void {
    this.api
      .reopen(this.id(), this.draft.currentVersion)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ version }) => {
          this.draft.setVersion(version);
          this.edit.reload();
        },
        error: (err: unknown) => this.say(errorMessage(toUiErrorCode(err))),
      });
  }

  /** "Sair e continuar depois" (UP-04): the draft stays and the audio's page says where. */
  protected leave(): void {
    this.audition.stop();
    if (this.draft.currentVersion === 0) this.draft.touch();
    this.draft.flush(() => void this.router.navigateByUrl(this.mediaLink()));
  }

  /** After a conflict: what the other person saved replaces this screen (FR-10). */
  protected reloadDraft(): void {
    this.loaded.set(false);
    this.edit.reload();
  }

  protected reloadProposals(): void {
    this.edit.reload();
  }

  protected reloadVoices(): void {
    this.transcript.reload();
  }

  protected copyTracks(): void {
    void this.document.defaultView?.navigator.clipboard
      ?.writeText(this.copyable())
      .then(
        () => this.say($localize`:@@tracks.copied:Faixas copiadas.`),
        () => this.say($localize`:@@tracks.notCopied:Não consegui copiar.`),
      );
  }

  private say(text: string): void {
    this.notice.set(text);
  }
}

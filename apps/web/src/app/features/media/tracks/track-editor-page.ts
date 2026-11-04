import { httpResource } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  Injector,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  approvalProblems,
  collectionSpeakerListSchema,
  editWordsSchema,
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
  joinTracks,
  newTrackSpan,
  selectedSpan,
  snapPointsOf,
  splitTrack,
  withHandle,
  NUDGE_MS,
  type TrackEdge,
} from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import { editWordsUrl, mediaWaveformUrl } from '@core/media/media-edit-api.js';
import {
  mediaPagePath,
  mediaTranscriptUrl,
  mediaUrl,
} from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { preparationPagePath } from '@core/media/preparation-api.js';
import { collectionSpeakersUrl } from '@core/media/speakers-api.js';
import { distinctUntilChanged, map } from 'rxjs';
import { PreparationSteps } from '../preparation/preparation-steps.js';
import { audienceLabel } from '../voices/speaker-names.js';
import { TrackAudition, endRange, startRange } from './track-audition.js';
import { TrackDraft } from './track-draft.js';
import type { ApproveResult } from './track-draft-state.js';
import {
  CONFLICT_TEXT,
  KIND_LABELS,
  formatBoundary,
  notDoneText,
} from './track-labels.js';
import { TrackPreparationStatus } from './track-preparation.js';
import { TrackProposals } from './track-proposals.js';
import {
  TrackRowList,
  personValue,
  problemLabel,
  type PersonChange,
  type PersonChoice,
} from './track-row-list.js';
import { TrackSubjects } from './track-subjects.js';
import { TrackTimeline, type ListenKind } from './track-timeline.js';
import { TrackTranscript, type TextSpan } from './track-transcript.js';

/** How long "Faixa 5 apagada · Desfazer" stays (screen spec: 10 s). */
const UNDO_NOTICE_MS = 10_000;

interface DeletedNotice {
  readonly ordinal: number;
  /** The draft right after deleting: any other change takes the offer away (I-6). */
  readonly revision: number;
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

const tracksText = (count: number): string =>
  count === 1
    ? $localize`:@@tracks.one:1 faixa`
    : $localize`:@@tracks.many:${count}:count: faixas`;

const touched = (track: DraftTrack): DraftTrack => ({ ...track, edited: true });

/** The name of who asks or answers; a voice without one, by its number. */
function personText(
  people: readonly PersonChoice[],
  person: { readonly voice: number | null; readonly speakerId: string | null },
): string {
  const value = personValue(person.voice, person.speakerId);
  if (value === '') return '';
  return people.find((one) => one.value === value)?.label ?? value.slice(1);
}

/** All a person can change on a track: a conflict loses none of it (FR-10, I-8). */
function copyableLine(
  { track, ordinal }: { track: DraftTrack; ordinal: number },
  people: readonly PersonChoice[],
): string {
  const asker = personText(people, {
    voice: track.askerVoice,
    speakerId: track.askerSpeakerId,
  });
  const answerer = personText(people, {
    voice: track.answererVoice,
    speakerId: track.answererSpeakerId,
  });
  return [
    `${ordinal}. ${formatBoundary(track.startMs)} – ${formatBoundary(track.endMs)} ${track.title ?? ''}`,
    KIND_LABELS[track.kind](),
    asker && $localize`:@@tracks.copy.asker:Quem pergunta: ${asker}:name:`,
    answerer &&
      $localize`:@@tracks.copy.answerer:Quem responde: ${answerer}:name:`,
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

/**
 * "Preparar áudio", steps 3 and 4 (T20, KBC-066): the person checks each track against the
 * sound and the words, and only "Aprovar faixas" applies them (BR-1). The draft lives on the
 * server: leaving, reloading or another device come back to the same step (BR-6).
 */
@Component({
  selector: 'app-track-editor-page',
  imports: [
    PreparationSteps,
    RouterLink,
    TrackTimeline,
    TrackRowList,
    TrackTranscript,
    TrackProposals,
    TrackPreparationStatus,
    TrackSubjects,
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
  private readonly session = inject(SessionStore);
  private readonly engine = inject(MediaEngine);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  protected readonly draft = inject(TrackDraft);
  protected readonly audition = inject(TrackAudition);

  private readonly timeline = viewChild(TrackTimeline);
  private readonly list = viewChild(TrackRowList);
  private readonly summaryHeading =
    viewChild<ElementRef<HTMLElement>>('summaryHeading');
  private readonly audio =
    viewChild<ElementRef<HTMLAudioElement>>('auditionElement');

  protected readonly id = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );
  private readonly item = httpResource(() => mediaUrl(this.id()), {
    parse: (body) => mediaItemSchema.parse(body),
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
  protected readonly showProblems = signal(false);
  protected readonly notice = signal('');
  private readonly deletedNotice = signal<DeletedNotice | null>(null);
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
  protected readonly canClassify = computed(() =>
    this.session.can('media-classify'),
  );
  protected readonly ready = computed(
    () => this.draft.loaded() && this.media() !== null,
  );
  protected readonly step = computed(() =>
    this.draft.edit()?.status === 'approved' ? 4 : 3,
  );
  protected readonly run = computed(() => this.draft.edit()?.run ?? null);
  protected readonly lastFailure = computed(
    () => this.draft.edit()?.lastFailure ?? null,
  );
  protected readonly voiceSuggestions = computed(
    () => this.draft.edit()?.voices ?? [],
  );
  /** Nothing can change now: a run writes the draft, or a press runs, or a conflict (R-5). */
  protected readonly readOnly = computed(() => !this.draft.canEdit());
  protected readonly watching = computed(
    () => this.draft.running() && !this.canPropose(),
  );
  protected readonly deleted = computed(() => {
    const notice = this.deletedNotice();
    return notice?.revision === this.draft.revision() ? notice : null;
  });
  protected readonly canApprove = computed(
    () => this.count() > 0 && !this.draft.busy() && !this.draft.running(),
  );
  protected readonly conflicted = computed(() => {
    const phase = this.draft.phase();
    return phase.kind === 'conflict' ? phase : null;
  });
  protected readonly proposalsBlocked = computed(
    () => this.conflicted() !== null || this.draft.busy(),
  );
  protected readonly unsavedText = computed(() => {
    const phase = this.draft.phase();
    if (phase.kind === 'conflict') return CONFLICT_TEXT[phase.reason]();
    return phase.kind === 'failed'
      ? $localize`:@@tracks.saveFailed:Não consegui salvar a última mudança. Ela continua aqui; tente de novo.`
      : '';
  });
  protected readonly offlineKept = computed(() => {
    const phase = this.draft.phase();
    return phase.kind === 'offline' ? phase.kept : null;
  });
  protected readonly hasProposals = computed(() =>
    this.draft.tracks().some((track) => track.source === 'ai' && !track.edited),
  );
  protected readonly transcriptChanged = computed(
    () => this.draft.edit()?.transcriptChanged === true,
  );
  protected readonly approvedCount = computed(
    () => this.draft.edit()?.approvedTracks ?? 0,
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
  protected readonly waveformFailed = computed(
    () => this.waveform.hasValue() && this.waveform.value().status === 'failed',
  );
  protected readonly waveformPending = computed(
    () => this.peaks() === null && this.ready() && !this.waveformFailed(),
  );
  protected readonly selected = computed(() => {
    const all = this.draft.numbered();
    return (
      all.find(({ track }) => track.id === this.chosenId()) ?? all[0] ?? null
    );
  });
  protected readonly selectedId = computed(
    () => this.selected()?.track.id ?? null,
  );
  protected readonly selectedSpanMs = computed<TextSpan | null>(
    () => this.selected()?.track ?? null,
  );
  protected readonly cursorMs = this.cursor.asReadonly();
  protected readonly count = computed(() => this.draft.tracks().length);
  protected readonly countText = computed(() => tracksText(this.count()));
  protected readonly appliedText = computed(() => {
    const count = this.approvedCount();
    return count === 1
      ? $localize`:@@tracks.appliedOne:1 faixa aplicada.`
      : $localize`:@@tracks.applied:${count}:count: faixas aplicadas.`;
  });
  private readonly problems = computed(() =>
    approvalProblems(this.draft.tracks(), this.media()?.durationMs ?? null),
  );
  protected readonly shownProblems = computed(() =>
    this.showProblems() ? this.problems() : [],
  );
  protected readonly warningCount = computed(
    () => new Set(this.problems().map((one) => one.trackId)).size,
  );
  protected readonly problemRows = computed(() =>
    this.problems().map((one) => ({
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
    return (
      !this.readOnly() && span !== null && this.spanFromText(span) !== null
    );
  });
  protected readonly copyable = computed(() =>
    this.draft
      .numbered()
      .map((row) => copyableLine(row, this.people()))
      .join('\n'),
  );
  protected readonly loadError = computed(() => {
    const err = this.draft.readError() ?? this.item.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  protected readonly forbidden = computed(() => {
    const err = this.draft.readError();
    return err !== null && toUiErrorCode(err) === 'FORBIDDEN';
  });

  constructor() {
    this.leaveForProcessing();
    this.stopOtherPlayback();
    this.route.paramMap
      .pipe(
        map((params) => params.get('id') ?? ''),
        distinctUntilChanged(),
        takeUntilDestroyed(),
      )
      .subscribe((id) => this.draft.open(id));
    // The audio element arrives with the content, once.
    afterRenderEffect(() => {
      const element = this.audio()?.nativeElement;
      if (element) this.audition.attach(element);
    });
    this.destroyRef.onDestroy(() => {
      this.audition.stop();
      if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    });
  }

  /** Arriving early, by a link or another device, goes to the step it is on (BR-5). */
  private leaveForProcessing(): void {
    effect(() => {
      if (this.draft.edit()?.preparationStep === 2)
        void this.router.navigateByUrl(preparationPagePath(this.id()), {
          replaceUrl: true,
        });
    });
  }

  /** What plays elsewhere stops: one sound at a time, and these keys are this page's. */
  private stopOtherPlayback(): void {
    this.engine.pause();
    this.engine.unload();
  }

  /** The button that had the focus is gone with the step: it moves on (WCAG 2.4.3). */
  private keepFocus(): void {
    afterNextRender(
      () => {
        if (this.document.activeElement !== this.document.body) return;
        const heading = this.summaryHeading()?.nativeElement;
        if (heading) heading.focus();
        else this.list()?.focusRow();
      },
      { injector: this.injector },
    );
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
    // The first track brings the list itself into the page.
    afterNextRender(() => this.list()?.focusTitle(), {
      injector: this.injector,
    });
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
    const parts = splitTrack(this.draft.tracks(), {
      trackId: id,
      atMs: this.cursor(),
      second: (track, startMs): DraftTrack => ({
        ...track,
        id: crypto.randomUUID(),
        runId: null,
        source: 'manual',
        edited: false,
        firstSegment: null,
        lastSegment: null,
        startMs,
        title: null,
      }),
    });
    if (parts)
      this.draft.apply(
        parts.map((one) => (one.id === id ? touched(one) : one)),
      );
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
    this.deletedNotice.set({
      ordinal: row.ordinal,
      revision: this.draft.revision(),
    });
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(
      () => this.deletedNotice.set(null),
      UNDO_NOTICE_MS,
    );
    this.list()?.focusRow();
  }

  protected undo(): void {
    this.draft.undo();
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

  /** The press on "Aprovar faixas" (BR-1): problems first, then the draft saves and applies. */
  protected approve(): void {
    this.notice.set('');
    if (this.problems().length > 0) {
      this.showProblem(this.problems());
      return;
    }
    this.draft
      .approve()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => this.answered(result));
  }

  private answered(result: ApproveResult): void {
    if (result.kind === 'approved') {
      this.showProblems.set(false);
      this.keepFocus();
    } else if (result.kind === 'invalid') this.showProblem(result.problems);
    else if (result.kind === 'stopped') this.say(notDoneText(result.result));
    else this.say(errorMessage(toUiErrorCode(result.error)));
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
    this.draft
      .reopen()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.keepFocus(),
        error: (err: unknown) => this.say(errorMessage(toUiErrorCode(err))),
      });
  }

  /**
   * "Sair e continuar depois" (UP-04): the draft stays and the audio's page says where. What
   * did not reach the server stays in this browser and comes back here; where it cannot,
   * leaving would lose it, so the person stays and hears why.
   */
  protected leave(): void {
    this.audition.stop();
    this.notice.set('');
    if (this.draft.edit()?.started === false) this.draft.touch();
    this.draft
      .flush()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (result === 'saved' || this.draft.keptHere()) this.goToMedia();
        else
          this.say(
            $localize`:@@tracks.notLeft:Não consegui salvar e este navegador não guarda as mudanças. Copie suas faixas antes de sair.`,
          );
      });
  }

  /** The audio's page may still have to load, and without a network it cannot (F-1). */
  private goToMedia(): void {
    const stayed = () =>
      this.say(
        $localize`:@@tracks.notOpened:Não consegui abrir a página do áudio. Suas mudanças continuam neste navegador; tente de novo com conexão.`,
      );
    this.router.navigateByUrl(this.mediaLink()).then((left) => {
      if (!left) stayed();
    }, stayed);
  }

  /** The way out of a conflict (FR-10): failing, the tracks to copy stay on screen. */
  protected reloadDraft(): void {
    this.notice.set('');
    this.draft
      .reload()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (err: unknown) => this.say(errorMessage(toUiErrorCode(err))),
      });
  }

  protected readonly startProposal = () => this.draft.propose();

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

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  viewChildren,
} from '@angular/core';
import {
  TRACK_KINDS,
  TRACK_TITLE_MAX,
  type DraftTrack,
  type TrackKind,
  type TrackLevelChoices,
  type TrackProblem,
} from '@kb-chat/contracts';
import type { TrackSpan } from '@kb-chat/player-core';
import {
  canSplit,
  closeOverlap,
  formatDuration,
  nextOf,
  overlapMs,
} from '@kb-chat/player-core';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { TrackText } from './track-text.js';
import { KIND_LABELS, formatBoundary, secondsText } from './track-labels.js';
import type { ListenKind, NumberedTrack } from './track-timeline.js';

/** A choice of "quem pergunta" or "quem responde". */
export interface PersonChoice {
  /** `v3` a voice of the recording, `s<id>` a speaker of the collection, '' nobody. */
  readonly value: string;
  readonly label: string;
}

export type TrackField = 'asker' | 'answerer';

export interface PersonChange {
  readonly id: string;
  readonly field: TrackField;
  readonly value: string;
}

/** What is said of a track's problem, by name (FR-8). */
const PROBLEM_LABELS: Record<
  Exclude<TrackProblem['problem'], 'overlap'>,
  () => string
> = {
  title: () => $localize`:@@tracks.problem.title:Sem título`,
  short: () => $localize`:@@tracks.problem.short:Menos de 5 s`,
  range: () => $localize`:@@tracks.problem.range:Passa do fim da gravação`,
};

/** The listening buttons of a row: each stops what it started (KBC-066 FR-5). */
const LISTEN_BUTTONS: readonly {
  readonly kind: ListenKind;
  readonly shortcut: string;
  readonly idle: () => string;
  readonly stop: () => string;
}[] = [
  {
    kind: 'track',
    shortcut: 'Space',
    idle: () => $localize`:@@tracks.listen.track:▶ Ouvir`,
    stop: () => $localize`:@@tracks.listen.stopTrack:■ Parar`,
  },
  {
    kind: 'start',
    shortcut: 'I',
    idle: () => $localize`:@@tracks.listen.start:Ouvir o início`,
    stop: () => $localize`:@@tracks.listen.stopStart:Parar o início`,
  },
  {
    kind: 'end',
    shortcut: 'F',
    idle: () => $localize`:@@tracks.listen.end:Ouvir o fim`,
    stop: () => $localize`:@@tracks.listen.stopEnd:Parar o fim`,
  },
];

/** An overlap says its size: under a tenth of a second, both times read the same (KBC-094). */
export function problemLabel(
  problem: TrackProblem,
  tracks: readonly TrackSpan[],
): string {
  if (problem.problem !== 'overlap') return PROBLEM_LABELS[problem.problem]();
  const size = secondsText(overlapMs(tracks, problem.trackId));
  return $localize`:@@tracks.problem.overlapBy:Sobreposta à anterior em ${size}:size:`;
}

export const personValue = (
  voice: number | null,
  speakerId: string | null,
): string => {
  if (speakerId) return `s${speakerId}`;
  return voice === null ? '' : `v${voice}`;
};

/**
 * The list of tracks (screen spec T20): one Tab stop, ↑/↓ moving (MA-29), and the fields and
 * actions only on the selected row, which is what keeps 200 tracks light and the Tab order
 * short. Title: Enter saves, Esc goes back (FR-6).
 */
@Component({
  selector: 'app-track-row-list',
  imports: [MenuButton, TrackText],
  templateUrl: './track-row-list.html',
  styleUrl: './track-row-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackRowList {
  private readonly injector = inject(Injector);

  readonly tracks = input.required<readonly NumberedTrack[]>();
  readonly selectedId = input.required<string | null>();
  readonly problems = input<readonly TrackProblem[]>([]);
  readonly people = input<readonly PersonChoice[]>([]);
  readonly readOnly = input(false);
  /** What plays on the selected row. */
  readonly playing = input<ListenKind | null>(null);
  /** Another row plays: this one offers to stop it. */
  readonly playingElsewhere = input(false);
  /** What "Nível" offers (KBC-106); null: the collection has no levels. */
  readonly levels = input<TrackLevelChoices>(null);
  /** What the server said of the selected track's level (review m6). */
  readonly levelError = input<string | null>(null);

  readonly selectTrack = output<string>();
  readonly titleChange = output<{ id: string; title: string }>();
  readonly kindChange = output<{ id: string; kind: TrackKind }>();
  readonly personChange = output<PersonChange>();
  readonly levelChange = output<{ id: string; level: string | null }>();
  readonly listen = output<ListenKind>();
  readonly listenKey = output<ListenKind>();
  readonly stopPlaying = output();
  readonly split = output<string>();
  readonly join = output<string>();
  readonly remove = output<string>();
  readonly closeOverlap = output<string>();

  private readonly rowButtons =
    viewChildren<ElementRef<HTMLButtonElement>>('rowButton');
  private readonly titleField =
    viewChildren<ElementRef<HTMLInputElement>>('titleField');
  /** Esc: the blur that follows must not save what was thrown away. */
  private discarding = false;

  protected readonly titleMax = TRACK_TITLE_MAX;
  protected readonly kinds = TRACK_KINDS.map((kind) => ({
    kind,
    label: KIND_LABELS[kind](),
  }));

  protected readonly rows = computed(() => {
    const problems = this.problems();
    const selectedId = this.selectedId();
    const plain = this.tracks().map(({ track }) => track);
    return this.tracks().map(({ track, ordinal }) => ({
      track,
      ordinal,
      selected: track.id === selectedId,
      range: `${formatBoundary(track.startMs)} – ${formatBoundary(track.endMs)}`,
      length: formatDuration(track.endMs - track.startMs),
      title: track.title ?? '',
      asker: personValue(track.askerVoice, track.askerSpeakerId),
      answerer: personValue(track.answererVoice, track.answererSpeakerId),
      proposal: track.source === 'ai' && !track.edited,
      levelCode: this.levelCodeOf(track.level),
      levelOutside: this.outsideOf(track.level),
      actions: track.id === selectedId ? this.actionsOf(track) : [],
      warnings: problems
        .filter((problem) => problem.trackId === track.id)
        .map((problem) => problemLabel(problem, plain)),
      closable:
        problems.some(
          (one) => one.trackId === track.id && one.problem === 'overlap',
        ) && closeOverlap(plain, track.id) !== null,
    }));
  });
  protected readonly listenButtons = computed(() =>
    LISTEN_BUTTONS.map(({ kind, shortcut, idle, stop }) => ({
      kind,
      shortcut,
      idle: idle(),
      stop: stop(),
      playing: this.playing() === kind,
    })),
  );
  protected readonly focusableId = computed(
    () => this.selectedId() ?? this.tracks()[0]?.track.id ?? null,
  );

  /** Takes the focus to a track's title (FR-8). */
  focusTitle(): void {
    afterNextRender(() => this.titleField()[0]?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /**
   * The focus on what stops an approval, in the middle of the list: a focus alone may leave it
   * under the sticky footer, and the list on top is far from the button (KBC-094).
   */
  reveal(what: 'title' | 'row'): void {
    afterNextRender(
      () => {
        const target =
          what === 'title'
            ? this.titleField()[0]
            : this.rowButtons().find((one) => one.nativeElement.tabIndex === 0);
        target?.nativeElement.focus({ preventScroll: true });
        target?.nativeElement.scrollIntoView({ block: 'center' });
      },
      { injector: this.injector },
    );
  }

  /** The focus on the row of the selected track. */
  focusRow(): void {
    afterNextRender(
      () =>
        this.rowButtons()
          .find((one) => one.nativeElement.tabIndex === 0)
          ?.nativeElement.focus(),
      { injector: this.injector },
    );
  }

  protected rowKey(event: KeyboardEvent, id: string): void {
    const listen = LISTEN_KEYS[event.key.toLowerCase()];
    if (listen && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      this.selectTrack.emit(id);
      this.listenKey.emit(listen);
      return;
    }
    const step =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const tracks = this.tracks();
    const index = tracks.findIndex(({ track }) => track.id === id);
    const next = tracks[index + step];
    if (!next) return;
    this.selectTrack.emit(next.track.id);
    this.focusRow();
  }

  protected titleKey(event: KeyboardEvent, row: { title: string }): void {
    const field = event.target as HTMLInputElement;
    if (event.key === 'Enter') {
      event.preventDefault();
      field.blur();
    }
    if (event.key === 'Escape') {
      this.discarding = true;
      field.value = row.title;
      field.blur();
    }
  }

  protected saveTitle(event: Event, id: string, current: string): void {
    if (this.discarding) {
      this.discarding = false;
      return;
    }
    const { value } = event.target as HTMLInputElement;
    if (value.trim() !== current) this.titleChange.emit({ id, title: value });
  }

  /** A track's own level, by its code; none while it follows the recording. */
  private levelCodeOf(level: string | null | undefined): string | null {
    if (!level) return null;
    return (
      this.levels()?.choices.find((one) => one.id === level)?.code ??
      level.toUpperCase()
    );
  }

  /**
   * A level the draft holds that is not among the choices (one deleted, or the recording's
   * own reached by it): shown as itself, never as "O da gravação" (review m6).
   */
  private outsideOf(
    level: string | null | undefined,
  ): { id: string; code: string } | null {
    const levels = this.levels();
    if (!level || !levels || level === levels.recording.id) return null;
    if (levels.choices.some((one) => one.id === level)) return null;
    return { id: level, code: level.toUpperCase() };
  }

  protected chooseLevel(event: Event, id: string): void {
    const { value } = event.target as HTMLSelectElement;
    this.levelChange.emit({ id, level: value || null });
  }

  protected chooseKind(event: Event, id: string): void {
    const { value } = event.target as HTMLSelectElement;
    this.kindChange.emit({ id, kind: value as TrackKind });
  }

  protected choosePerson(event: Event, id: string, field: TrackField): void {
    const { value } = event.target as HTMLSelectElement;
    this.personChange.emit({ id, field, value });
  }

  /** ⋯ (FR-6): dividing only where it fits (BR-4), joining only with a next track. */
  private actionsOf(track: DraftTrack): readonly MenuOption[] {
    const plain = this.tracks().map((one) => one.track);
    return [
      ...(canSplit(track)
        ? [
            {
              id: 'split',
              label: $localize`:@@tracks.action.split:Dividir aqui`,
            },
          ]
        : []),
      ...(nextOf(plain, track.id)
        ? [
            {
              id: 'join',
              label: $localize`:@@tracks.action.join:Juntar com a próxima`,
            },
          ]
        : []),
      {
        id: 'remove',
        label: $localize`:@@tracks.action.remove:Apagar`,
        danger: true,
      },
    ];
  }

  protected act(action: string, id: string): void {
    if (action === 'split') this.split.emit(id);
    if (action === 'join') this.join.emit(id);
    if (action === 'remove') this.remove.emit(id);
  }
}

const LISTEN_KEYS: Readonly<Record<string, ListenKind>> = {
  ' ': 'track',
  i: 'start',
  f: 'end',
};

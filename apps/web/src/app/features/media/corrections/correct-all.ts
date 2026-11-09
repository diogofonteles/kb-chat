import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  CORRECTION_MAX_BATCH,
  correctionConflictSchema,
  type Occurrence,
  type TranscriptCorrectionBatchResult,
} from '@kb-chat/contracts';
import { formatClock, type TimedSpan } from '@kb-chat/player-core';
import { errorDetailsOf, toUiErrorCode } from '@core/api/api-error.js';
import { CorrectionsApi } from '@core/media/corrections-api.js';
import { TrackAudition } from '../tracks/track-audition.js';
import { TrackTextSource } from '../tracks/track-text-source.js';
import { CorrectionDesk, tidied } from './correction-desk.js';
import { AROUND_WORD_MS } from './word-correction.js';

type Scope = 'window' | 'recording';

/** Where the confirmation is: refused for a reason the person can act on, or not. */
type Outcome = 'idle' | 'saving' | 'stale' | 'failed' | 'invalid';

/** An occurrence's new text: the typed one inside its own edge punctuation (BR-11). */
export function replacementOf(found: string, typed: string): string {
  const edges = /^([\p{P}\p{S}]*)(.*?)([\p{P}\p{S}]*)$/su;
  const [, lead = '', , trail = ''] = edges.exec(found) ?? [];
  const [, , core = typed] = edges.exec(typed) ?? [];
  return `${lead}${core}${trail}`;
}

/**
 * "Corrigir todas" (T20, KBC-093 FR-11): every occurrence of the chosen words in this track
 * or the whole recording, each one checked, with its context and "antes → depois", written
 * at once only after the person confirms (BR-12, BR-13). A modal dialog: a side panel on a
 * desktop, the whole screen on a phone with the confirmation always in reach.
 */
@Component({
  selector: 'app-correct-all',
  templateUrl: './correct-all.html',
  styleUrls: ['../preparation/preparation-buttons.css', './correct-all.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CorrectAll {
  private readonly api = inject(CorrectionsApi);
  private readonly desk = inject(CorrectionDesk);
  private readonly source = inject(TrackTextSource);
  private readonly audition = inject(TrackAudition);
  private readonly destroyRef = inject(DestroyRef);

  /** What the chosen words say: the occurrences are of this. */
  readonly find = input.required<string>();
  /** The track the text block shows; null for none. */
  readonly window = input<TimedSpan | null>(null);
  readonly closed = output();

  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly maxBatch = CORRECTION_MAX_BATCH;
  protected readonly typed = linkedSignal(() => this.find());
  /** The choice starts from what the person sees: this track, when there is one. */
  protected readonly scope = linkedSignal<Scope>(() =>
    this.window() ? 'window' : 'recording',
  );
  protected readonly outcome = signal<Outcome>('idle');
  /** Occurrences whose words changed since the preview, with what they say now (AC-33). */
  protected readonly changed = signal<ReadonlyMap<number, string>>(new Map());
  /**
   * The key of the confirmation being sent, with what it sends: a retry of the same text and
   * choice sends it again (BR-13); another text or choice is another group, with a new key.
   */
  private key: { readonly value: string; readonly of: string } | null = null;

  private readonly preview = rxResource({
    params: () => {
      const transcript = this.source.transcript();
      if (!transcript) return undefined;
      return {
        mediaId: transcript.mediaId,
        revision: transcript.revision,
        text: this.find(),
        scope: this.scope(),
        window: this.window(),
      };
    },
    stream: ({ params }) =>
      this.api.occurrences(params.mediaId, {
        text: params.text,
        scope: params.scope,
        window: params.window && {
          fromMs: Math.round(params.window.startMs),
          toMs: Math.round(params.window.endMs),
        },
      }),
  });
  protected readonly loading = computed(() => this.preview.isLoading());
  protected readonly loadFailed = computed(() => !!this.preview.error());
  protected readonly occurrences = computed<readonly Occurrence[]>(() =>
    this.preview.hasValue() ? this.preview.value().occurrences : [],
  );
  protected readonly counts = computed(() =>
    this.preview.hasValue()
      ? {
          total: this.preview.value().total,
          inWindow: this.preview.value().inWindow,
        }
      : null,
  );
  /** Everything listed starts checked (BR-12). */
  protected readonly checked = linkedSignal<
    readonly Occurrence[],
    ReadonlySet<number>
  >({
    source: this.occurrences,
    computation: (list) => new Set(list.map((one) => one.position)),
  });
  protected readonly chosenCount = computed(() => this.checked().size);
  protected readonly inScope = computed(() => {
    const counts = this.counts();
    if (!counts) return 0;
    return this.scope() === 'window' ? counts.inWindow : counts.total;
  });
  protected readonly clean = computed(() => tidied(this.typed()));
  protected readonly canConfirm = computed(
    () =>
      this.chosenCount() > 0 &&
      this.clean() !== null &&
      this.clean() !== '' &&
      this.outcome() !== 'saving',
  );

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  protected clock(ms: number): string {
    return formatClock(ms);
  }

  protected after(occurrence: Occurrence): string {
    return replacementOf(occurrence.text, this.clean() ?? '');
  }

  protected changedText(occurrence: Occurrence): string | null {
    return this.changed().get(occurrence.position) ?? null;
  }

  protected typedText(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.typed.set(event.target.value);
  }

  protected choose(scope: Scope): void {
    this.scope.set(scope);
    this.changed.set(new Map());
  }

  protected toggled(position: number, event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.toggle(position, event.target.checked);
  }

  private toggle(position: number, on: boolean): void {
    this.checked.update((set) => {
      const next = new Set(set);
      if (on) next.add(position);
      else next.delete(position);
      return next;
    });
  }

  protected checkAll(on: boolean): void {
    this.checked.set(
      new Set(on ? this.occurrences().map((one) => one.position) : []),
    );
  }

  protected hear(occurrence: Occurrence): void {
    this.audition.play({
      fromMs: Math.max(0, occurrence.startMs - AROUND_WORD_MS),
      toMs: occurrence.endMs + AROUND_WORD_MS,
    });
  }

  protected confirm(): void {
    const transcript = this.source.transcript();
    const text = this.clean();
    if (!transcript || text === null || !this.canConfirm()) return;
    const items = this.occurrences()
      .filter((one) => this.checked().has(one.position))
      .map(({ position, count, expected }) => ({ position, count, expected }));
    const of = JSON.stringify({ version: transcript.version, text, items });
    if (this.key?.of !== of) this.key = { value: crypto.randomUUID(), of };
    this.outcome.set('saving');
    this.api
      .batch(transcript.mediaId, {
        version: transcript.version,
        key: this.key.value,
        text,
        items,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => this.saved(result),
        error: (err: unknown) => this.refused(err),
      });
  }

  private saved(result: TranscriptCorrectionBatchResult): void {
    const text =
      result.count === 1
        ? $localize`:@@correctAll.savedOne:1 ocorrência corrigida.`
        : $localize`:@@correctAll.saved:${result.count}:count: ocorrências corrigidas.`;
    this.source.reload();
    this.desk.loadHistory();
    this.desk.say(text);
    this.desk.tell({
      text,
      undo: () => this.desk.undoGroup(result.groupId),
    });
    this.close();
  }

  private refused(err: unknown): void {
    const code = toUiErrorCode(err);
    const details = correctionConflictSchema.safeParse(errorDetailsOf(err));
    if (code === 'TRANSCRIPT_CHANGED') {
      this.outcome.set('stale');
      this.source.reload();
    } else if (details.data?.reason === 'word-changed') {
      this.markChanged(details.data.changed ?? []);
    } else {
      this.outcome.set(code === 'CORRECTION_INVALID' ? 'invalid' : 'failed');
      return;
    }
    // Something changed: the next confirmation is another group.
    this.key = null;
  }

  /** What changed since the preview is unchecked and says what it says now (AC-33). */
  private markChanged(
    changed: readonly { position: number; current: string }[],
  ) {
    this.outcome.set('idle');
    this.changed.set(
      new Map(changed.map((one) => [one.position, one.current])),
    );
    this.checked.update(
      (set) =>
        new Set([...set].filter((position) => !this.changed().has(position))),
    );
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** The dialog closed (Esc, Cancelar, a save): the desk forgets it. */
  protected gone(): void {
    this.desk.closeAll();
    this.closed.emit();
  }
}

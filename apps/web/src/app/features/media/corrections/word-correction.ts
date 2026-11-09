import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { CORRECTION_MAX_CHARS } from '@kb-chat/contracts';
import { CorrectionsApi } from '@core/media/corrections-api.js';
import { TrackAudition } from '../tracks/track-audition.js';
import { TrackTextSource } from '../tracks/track-text-source.js';
import { CorrectionDesk } from './correction-desk.js';

/** "Ouvir a palavra": from 1 s before its start to 1 s after its end (FR-1). */
export const AROUND_WORD_MS = 1_000;

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * "Corrigir palavra" (T20, KBC-093 FR-1 to FR-3): the chosen words with their context, the
 * field already selected, the neighbours, saving and its conflicts. A dialog that keeps Tab
 * inside and closes with Esc (AC-23); not modal, so another word can still be clicked
 * (AC-44). On a phone it is a sheet at the bottom (AC-24).
 */
@Component({
  selector: 'app-word-correction',
  templateUrl: './word-correction.html',
  styleUrls: [
    '../preparation/preparation-buttons.css',
    './word-correction.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'keyOnPanel($event)' },
})
export class WordCorrection {
  protected readonly desk = inject(CorrectionDesk);
  private readonly audition = inject(TrackAudition);
  private readonly source = inject(TrackTextSource);
  private readonly api = inject(CorrectionsApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Esc, Cancelar or a save: where the focus goes back is the text's business. */
  readonly closed = output();

  private readonly field =
    viewChild.required<ElementRef<HTMLInputElement>>('field');

  protected readonly maxChars = CORRECTION_MAX_CHARS;
  /** "Corrigir palavra, Tiuako": what the screen reader says as it opens (AC-45). */
  protected readonly label = computed(
    () =>
      $localize`:@@correct.name:Corrigir palavra, ${this.desk.original()}:words:`,
  );
  protected readonly phase = this.desk.phase;
  protected readonly saving = computed(() => this.phase().kind === 'saving');
  /** A retry would be refused the same way: no Salvar nor Tentar de novo. */
  protected readonly refused = computed(() => this.phase().kind === 'refused');
  /** Said next to the field as soon as it is so (AC-8, MA-23). */
  protected readonly invalid = computed(
    () => !this.desk.valid() || this.phase().kind === 'invalid',
  );
  /** How often what the words say is in the recording (FR-11). */
  private readonly occurrences = rxResource({
    params: () => {
      const transcript = this.source.transcript();
      const text = this.desk.original();
      return transcript && text !== ''
        ? { mediaId: transcript.mediaId, text, revision: transcript.revision }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.occurrences(params.mediaId, {
        text: params.text,
        window: null,
        scope: 'recording',
      }),
  });
  protected readonly elsewhere = computed(() =>
    this.occurrences.hasValue() ? this.occurrences.value().total : 0,
  );
  protected readonly conflictText = computed(() => {
    const phase = this.phase();
    return phase.kind === 'conflict'
      ? phase.current.filter((text) => text !== '').join(' ')
      : '';
  });
  protected readonly conflictAuthor = computed(() => {
    const phase = this.phase();
    return phase.kind === 'conflict' ? phase.author : null;
  });

  constructor() {
    // The field comes selected, ready to type over (FR-1); again when another word is chosen.
    afterRenderEffect(() => {
      this.desk.selection();
      const field = this.field().nativeElement;
      field.focus();
      field.select();
    });
  }

  protected typed(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.desk.type(event.target.value);
  }

  protected save(): void {
    // On a conflict the field still holds the person's text: Enter keeps it (AC-12).
    if (this.phase().kind === 'conflict') {
      this.desk.saveMine();
      return;
    }
    if (this.desk.unchanged() || this.saving() || this.refused()) return;
    this.desk.save();
  }

  protected remove(): void {
    if (this.saving() || this.refused()) return;
    this.desk.save('');
  }

  protected cancel(): void {
    this.desk.close();
    this.closed.emit();
  }

  protected hear(): void {
    const words = this.desk.words();
    const [first] = words;
    const last = words.at(-1);
    if (!first || !last || !this.desk.timed()) return;
    this.audition.play({
      fromMs: Math.max(0, first.startMs - AROUND_WORD_MS),
      toMs: last.endMs + AROUND_WORD_MS,
    });
  }

  protected correctAll(): void {
    this.desk.openAll(this.desk.original());
  }

  /** Enter saves from the field; Esc cancels; Tab goes round inside (AC-23). */
  protected keyOnPanel(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === 'Enter' && event.target === this.field().nativeElement) {
      event.preventDefault();
      this.save();
      return;
    }
    if (event.key === 'Tab') this.keepTabInside(event);
  }

  private keepTabInside(event: KeyboardEvent): void {
    const focusable = [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = this.host.nativeElement.ownerDocument.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}

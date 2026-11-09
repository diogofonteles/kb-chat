import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { CorrectionEntry, TranscriptCorrection } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { TrackAudition } from '../tracks/track-audition.js';
import { CorrectionDesk } from './correction-desk.js';
import { AROUND_WORD_MS } from './word-correction.js';

const WHEN = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** pt-BR for each state of a row (BR-8). */
const STATE_LABELS: Record<TranscriptCorrection['state'], () => string> = {
  active: () => $localize`:@@history.active:Em vigor`,
  undone: () => $localize`:@@history.undone:Desfeita`,
  carried: () => $localize`:@@history.carried:Reaplicada na transcrição nova`,
  'not-carried': () => $localize`:@@history.notCarried:Não reaplicada`,
};

const KIND_LABELS: Record<TranscriptCorrection['kind'], () => string> = {
  correct: () => $localize`:@@history.kindCorrect:Correção`,
  undo: () => $localize`:@@history.kindUndo:Desfazer`,
  carried: () => $localize`:@@history.kindCarried:Reaplicada`,
};

const said = (texts: readonly string[]): string =>
  texts.filter((text) => text !== '').join(' ');

/**
 * "Correções" (T20, KBC-093 FR-9, FR-13): who changed what, when, and its state, newest
 * first; a group of "Corrigir todas" is one line that opens on its occurrences, with
 * "Desfazer o grupo" (BR-14). Desfazer shows only where the person may (BR-5). A modal side
 * panel on a desktop, the whole screen on a phone.
 */
@Component({
  selector: 'app-correction-history',
  imports: [NgTemplateOutlet],
  templateUrl: './correction-history.html',
  styleUrls: [
    '../preparation/preparation-buttons.css',
    './correction-history.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CorrectionHistory {
  protected readonly desk = inject(CorrectionDesk);
  private readonly audition = inject(TrackAudition);

  readonly closed = output();
  /** "Corrigir aqui" on a correction the new version did not take (FR-8). */
  readonly fixHere = output<TranscriptCorrection>();

  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly page = this.desk.history;
  protected readonly entries = computed(() => this.page()?.entries ?? []);

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  protected before(row: TranscriptCorrection): string {
    return said(row.before) || '—';
  }

  protected after(row: TranscriptCorrection): string {
    return row.after || $localize`:@@history.removed:(apagada)`;
  }

  protected when(row: TranscriptCorrection): string {
    return WHEN.format(new Date(row.createdAt));
  }

  protected clock(row: TranscriptCorrection): string {
    return formatClock(row.startMs);
  }

  protected stateOf(row: TranscriptCorrection): string {
    return STATE_LABELS[row.state]();
  }

  protected kindOf(row: TranscriptCorrection): string {
    return KIND_LABELS[row.kind]();
  }

  protected first(entry: CorrectionEntry): TranscriptCorrection | null {
    return entry.items[0] ?? null;
  }

  protected hear(row: TranscriptCorrection): void {
    this.audition.play({
      fromMs: Math.max(0, row.startMs - AROUND_WORD_MS),
      toMs: row.endMs + AROUND_WORD_MS,
    });
  }

  protected undo(row: TranscriptCorrection): void {
    this.desk.undo(row.id);
  }

  protected undoGroup(entry: CorrectionEntry): void {
    if (entry.groupId) this.desk.undoGroup(entry.groupId);
  }

  protected correctHere(row: TranscriptCorrection): void {
    this.fixHere.emit(row);
    this.close();
  }

  protected more(): void {
    const next = this.page()?.next;
    if (next !== null && next !== undefined) this.desk.loadHistory(next);
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }
}

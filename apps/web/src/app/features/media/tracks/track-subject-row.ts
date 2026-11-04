import {
  ChangeDetectionStrategy,
  Component,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  MAX_TRACK_SUBJECTS,
  TRACK_SUMMARY_MAX,
  subjectKey,
  type CollectionSubjects,
  type SubjectSuggestion,
  type TrackSubject,
  type TrackSubjects,
} from '@kb-chat/contracts';
import { SubjectPicker, type SubjectChoice } from './subject-picker.js';

/** "Aceitar" or "Recusar" on one track: chips and the suggested summary. */
export interface SubjectDecisionEvent {
  readonly accept: readonly string[];
  readonly refuse: readonly string[];
  readonly summary: 'accept' | 'refuse' | null;
}

/** One track of step 4: its title, and the column "Assuntos" (KBC-069 FR-4). */
@Component({
  selector: 'app-track-subject-row',
  imports: [SubjectPicker],
  templateUrl: './track-subject-row.html',
  styleUrl: './track-subject-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackSubjectRow {
  private readonly document = inject(DOCUMENT);
  private readonly picker = viewChild(SubjectPicker);

  readonly track = input.required<TrackSubjects>();
  readonly collection = input.required<CollectionSubjects>();
  /** A write to this track is on its way: it would answer with an old version. */
  readonly busy = input(false);

  readonly add = output<SubjectChoice>();
  readonly removeSubject = output<TrackSubject>();
  readonly decide = output<SubjectDecisionEvent>();
  readonly summary = output<string>();

  protected readonly summaryMax = TRACK_SUMMARY_MAX;
  /** "Até 5 assuntos por faixa" (AC-3). */
  protected readonly full = signal(false);
  private refocus = false;

  protected readonly taken = computed(() =>
    this.track().subjects.map((one) => subjectKey(one.name)),
  );
  protected readonly pickerLabel = computed(
    () =>
      $localize`:@@subjects.addTo:Adicionar assunto à faixa ${this.track().ordinal}:ordinal:`,
  );
  protected readonly empty = computed(() => {
    const { subjects, suggestions } = this.track();
    return subjects.length === 0 && suggestions.length === 0;
  });
  protected readonly canAcceptAll = computed(
    () =>
      this.track().suggestions.length +
        (this.track().suggestedSummary ? 1 : 0) >
      1,
  );

  constructor() {
    // A chip pressed is gone with the answer: the focus stays on this track (WCAG 2.4.3).
    afterRenderEffect(() => {
      this.track();
      if (!this.refocus) return;
      this.refocus = false;
      if (this.document.activeElement === this.document.body)
        this.picker()?.focus();
    });
  }

  private fits(more: number): boolean {
    const fits = this.track().subjects.length + more <= MAX_TRACK_SUBJECTS;
    this.full.set(!fits);
    return fits;
  }

  protected acceptLabel(suggestion: SubjectSuggestion): string {
    return $localize`:@@subjects.acceptChip:Aceitar sugestão ${suggestion.name}:name:`;
  }

  protected refuseLabel(suggestion: SubjectSuggestion): string {
    return $localize`:@@subjects.refuseChip:Recusar sugestão ${suggestion.name}:name:`;
  }

  protected removeLabel(subject: TrackSubject): string {
    return $localize`:@@subjects.removeChip:Remover assunto ${subject.name}:name:`;
  }

  protected added(choice: SubjectChoice): void {
    if (this.fits(1)) this.add.emit(choice);
  }

  protected removed(subject: TrackSubject): void {
    this.full.set(false);
    this.refocus = true;
    this.removeSubject.emit(subject);
  }

  protected accept(suggestion: SubjectSuggestion): void {
    if (!this.fits(1)) return;
    this.refocus = true;
    this.decide.emit({ accept: [suggestion.id], refuse: [], summary: null });
  }

  protected refuse(suggestion: SubjectSuggestion): void {
    this.full.set(false);
    this.refocus = true;
    this.decide.emit({ accept: [], refuse: [suggestion.id], summary: null });
  }

  protected acceptAll(): void {
    const { suggestions, suggestedSummary } = this.track();
    if (!this.fits(suggestions.length)) return;
    this.refocus = true;
    this.decide.emit({
      accept: suggestions.map((one) => one.id),
      refuse: [],
      summary: suggestedSummary ? 'accept' : null,
    });
  }

  protected decideSummary(summary: 'accept' | 'refuse'): void {
    this.refocus = true;
    this.decide.emit({ accept: [], refuse: [], summary });
  }

  protected summaryChanged(event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value.trim();
    if (text !== (this.track().summary ?? '')) this.summary.emit(text);
  }
}

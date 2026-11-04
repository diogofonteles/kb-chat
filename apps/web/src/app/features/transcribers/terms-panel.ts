import { DatePipe, DOCUMENT } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  normalizeTerms,
  termListSchema,
  termSchema,
  termsOverLimitSchema,
  type TermList,
  type TermsUsage,
} from '@kb-chat/contracts';
import {
  errorDetailsOf,
  errorMessage,
  toUiErrorCode,
} from '@core/api/api-error.js';
import { TermsApi, termsUrl } from '@core/media/terms-api.js';
import { EMPTY, catchError, debounceTime, filter, switchMap } from 'rxjs';

/** One line of the draft; the id keeps its input when the lines around it change. */
interface TermRow {
  readonly id: number;
  readonly text: string;
}

interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

const MEASURE_DEBOUNCE_MS = 300;

const rowsOf = (terms: readonly string[]): TermRow[] =>
  terms.map((text, id) => ({ id, text }));

const isValid = (text: string): boolean =>
  text.trim() === '' || termSchema.safeParse(text).success;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((term, index) => term === b[index]);

const overLimitText = ({ tokens, limit }: TermsUsage): string =>
  $localize`:@@terms.overLimit:A lista passou do limite do transcritor (${tokens}:tokens: de ${limit}:limit:). Remova alguns termos.`;

/** "versão 5": who got there first, when the API says so. */
function versionIn(err: unknown): number | null {
  const details = errorDetailsOf(err);
  return typeof details === 'object' &&
    details !== null &&
    'version' in details &&
    typeof details.version === 'number'
    ? details.version
    : null;
}

/**
 * "Termos da transcrição" (KBC-040; masters): the names the transcriber must spell right. It
 * is a draft until "Salvar lista", which makes a version for the next transcriptions; what
 * was already transcribed changes only when a person asks, media by media.
 */
@Component({
  selector: 'app-terms-panel',
  imports: [DatePipe],
  templateUrl: './terms-panel.html',
  styleUrls: [
    '../settings/settings-form.css',
    './transcribers-panel.css',
    './terms-panel.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TermsPanel {
  private readonly api = inject(TermsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  protected readonly list = httpResource(() => termsUrl(), {
    parse: (body) => termListSchema.parse(body),
  });
  protected readonly saved = computed<TermList | null>(() =>
    this.list.hasValue() ? this.list.value() : null,
  );
  protected readonly rows = linkedSignal<TermRow[]>(() =>
    rowsOf(this.saved()?.terms ?? []),
  );
  protected readonly toAdd = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  /** Another master saved first: only reloading goes on from here. */
  protected readonly stale = signal(false);

  private readonly terms = computed(() =>
    normalizeTerms(this.rows().map((row) => row.text)),
  );
  private readonly allValid = computed(() =>
    this.rows().every((row) => isValid(row.text)),
  );
  private readonly measured = signal<TermsUsage | null>(null);
  protected readonly changed = computed(() => {
    const saved = this.saved();
    return saved !== null && !sameList(this.terms(), saved.terms);
  });
  /** The saved list's use, until a change is measured. */
  protected readonly usage = computed<TermsUsage | null>(() =>
    this.changed() ? (this.measured() ?? this.saved()) : this.saved(),
  );
  protected readonly overLimit = computed(() => {
    const usage = this.usage();
    return usage !== null && usage.tokens > usage.limit
      ? overLimitText(usage)
      : '';
  });

  constructor() {
    this.measureChanges();
  }

  protected isValid(row: TermRow): boolean {
    return isValid(row.text);
  }

  protected termLabel(position: number): string {
    return $localize`:@@terms.termLabel:Termo ${position}:position:`;
  }

  protected removeLabel(row: TermRow): string {
    return $localize`:@@terms.removeLabel:Remover ${row.text}:term:`;
  }

  protected editRow(id: number, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.rows.update((rows) =>
      rows.map((row) => (row.id === id ? { ...row, text } : row)),
    );
    this.notice.set(null);
  }

  /** The focus goes to the line that took its place, never to the page (WCAG 2.4.3). */
  protected removeRow(index: number): void {
    this.rows.update((rows) => rows.filter((_, at) => at !== index));
    this.notice.set(null);
    const next = Math.min(index, this.rows().length - 1);
    this.focusAfterRender(
      next >= 0 ? `#term-${this.rows()[next]?.id}` : '#terms-add',
    );
  }

  protected editToAdd(event: Event): void {
    this.toAdd.set((event.target as HTMLTextAreaElement).value);
  }

  /** One per line, so a pasted list comes in whole; a term already there is not repeated. */
  protected addTerms(): void {
    const present = this.terms();
    const lines = normalizeTerms(this.toAdd().split('\n'));
    const added = normalizeTerms([...present, ...lines]).slice(present.length);
    const nextId = Math.max(-1, ...this.rows().map((row) => row.id)) + 1;
    this.rows.update((rows) => [
      ...rows,
      ...added.map((text, index) => ({ id: nextId + index, text })),
    ]);
    this.toAdd.set('');
    const repeated = lines.length - added.length;
    this.notice.set(
      repeated > 0
        ? {
            kind: 'ok',
            text: $localize`:@@terms.repeated:Termos repetidos ficam de fora: ${repeated}:count:.`,
          }
        : null,
    );
  }

  protected discard(): void {
    this.rows.set(rowsOf(this.saved()?.terms ?? []));
    this.notice.set(null);
  }

  protected reload(): void {
    this.stale.set(false);
    this.notice.set(null);
    this.list.reload();
  }

  protected save(event: Event): void {
    event.preventDefault();
    const saved = this.saved();
    const refusal = this.refusal();
    if (!saved || refusal !== null) {
      if (refusal) this.notice.set({ kind: 'error', text: refusal });
      return;
    }
    this.busy.set(true);
    this.notice.set(null);
    this.api
      .save({ baseVersion: saved.version, terms: this.terms() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => this.showSaved(list),
        error: (err: unknown) => this.saveFailed(err),
      });
  }

  /** Why this draft cannot go; null when it can. The API checks all of it again. */
  private refusal(): string | null {
    if (this.terms().length === 0)
      return $localize`:@@terms.empty:A lista precisa de pelo menos um termo.`;
    if (!this.allValid())
      return $localize`:@@terms.fixMarked:Corrija os termos marcados.`;
    if (this.overLimit()) return this.overLimit();
    return this.changed() ? null : $localize`:@@terms.noChange:Nada mudou.`;
  }

  private showSaved(list: TermList): void {
    this.busy.set(false);
    this.measured.set(null);
    this.list.set(list);
    this.notice.set({
      kind: 'ok',
      text: $localize`:@@terms.saved:Lista salva: versão ${list.version}:version:.`,
    });
  }

  private saveFailed(err: unknown): void {
    this.busy.set(false);
    const code = toUiErrorCode(err);
    const usage = termsOverLimitSchema.safeParse(errorDetailsOf(err));
    const version = versionIn(err);
    if (code === 'MEDIA_CONFLICT' && version !== null) {
      this.stale.set(true);
      this.notice.set({
        kind: 'error',
        text: $localize`:@@terms.stale:Outra pessoa mudou a lista (versão ${version}:version:). Recarregue para ver; sua edição continua aqui até lá.`,
      });
      return;
    }
    const text =
      code === 'TERMS_OVER_LIMIT' && usage.success
        ? overLimitText(usage.data)
        : errorMessage(code);
    this.notice.set({ kind: 'error', text });
  }

  /** Asks the API a moment after the last change; a failure leaves the last number. */
  private measureChanges(): void {
    toObservable(this.terms)
      .pipe(
        filter(() => this.changed() && this.allValid()),
        filter((terms) => terms.length > 0),
        debounceTime(MEASURE_DEBOUNCE_MS),
        switchMap((terms) =>
          this.api.measure(terms).pipe(catchError(() => EMPTY)),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((usage) => this.measured.set(usage));
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(
      () => this.document.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }
}

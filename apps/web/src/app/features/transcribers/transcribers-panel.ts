import { DatePipe, DOCUMENT } from '@angular/common';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  transcriberListSchema,
  type PairedTranscriber,
  type Transcriber,
} from '@kb-chat/contracts';
import {
  TranscribersApi,
  transcribersUrl,
} from '@core/media/transcribers-api.js';

type CopyState = 'idle' | 'copied' | 'failed';
type Copied = 'command' | 'token';
type NameProblem = 'required' | 'taken' | null;

/** What the live region says after an action (UP-01), in words. */
interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

/** How long "Copiado" stays before the button reads "Copiar" again. */
const COPY_FEEDBACK_MS = 2_500;

const COPIED: Record<Copied, () => string> = {
  command: () => $localize`:@@transcribers.commandCopied:Comando copiado.`,
  token: () => $localize`:@@transcribers.tokenCopied:Token copiado.`,
};

/**
 * "Transcritores" (KBC-036 FR-5, BR-1; masters only): pair the Mac that transcribes, see
 * when each was last seen and what it transcribes, revoke one. The token shows once. The
 * focus never falls to the page when what held it goes away (WCAG 2.4.3).
 */
@Component({
  selector: 'app-transcribers-panel',
  imports: [DatePipe],
  templateUrl: './transcribers-panel.html',
  styleUrls: ['../settings/settings-form.css', './transcribers-panel.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TranscribersPanel {
  private readonly api = inject(TranscribersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly pairedBox = viewChild<ElementRef<HTMLElement>>('pairedBox');
  private readonly nameInput =
    viewChild.required<ElementRef<HTMLInputElement>>('nameInput');
  private readonly listTitle =
    viewChild.required<ElementRef<HTMLElement>>('listTitle');
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly list = httpResource(() => transcribersUrl(), {
    parse: (body) => transcriberListSchema.parse(body),
  });
  protected readonly items = computed<Transcriber[]>(() =>
    this.list.hasValue() ? this.list.value().items : [],
  );
  protected readonly name = signal('');
  protected readonly nameProblem = signal<NameProblem>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  /** The pairing just made: its token is shown until the master closes the box. */
  protected readonly paired = signal<PairedTranscriber | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly copyState = signal<{ what: Copied; state: CopyState }>({
    what: 'command',
    state: 'idle',
  });
  /** The command to paste on the Mac: the API is this same origin (`/api`). */
  protected readonly command = computed(
    () =>
      `uv run --project tools/transcriber transcriber pair --api-url ${this.view?.location.origin ?? ''}`,
  );

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.copyTimer));
  }

  protected editName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.nameProblem.set(null);
  }

  protected pair(event: Event): void {
    event.preventDefault();
    const name = this.name().trim();
    if (!name) return this.nameProblem.set('required');
    this.busy.set(true);
    this.notice.set(null);
    this.api
      .pair(name)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (paired) => this.showPaired(paired),
        error: (err: unknown) => this.pairFailed(err),
      });
  }

  /** "Pronto": the token goes away for good; the focus goes back to the name field. */
  protected closePaired(): void {
    this.paired.set(null);
    this.focusAfterRender(() => this.nameInput().nativeElement);
  }

  /** "Revogar" turns into the question: the focus goes to its safe answer, "Cancelar". */
  protected askRevoke(id: string): void {
    this.confirming.set(id);
    this.focusAfterRender(() => this.find(`[data-cancel-revoke="${id}"]`));
  }

  /** Back to the row's own "Revogar". */
  protected cancelRevoke(id: string): void {
    this.confirming.set(null);
    this.focusAfterRender(() => this.find(`[data-revoke="${id}"]`));
  }

  /** "Revogar Mac do dono": which one, for a screen reader in a list of buttons. */
  protected revokeLabelOf(transcriber: Transcriber): string {
    return $localize`:@@transcribers.revokeLabel:Revogar ${transcriber.name}:name:`;
  }

  protected revoke(transcriber: Transcriber): void {
    this.busy.set(true);
    this.notice.set(null);
    this.api
      .revoke(transcriber.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.revoked(transcriber),
        error: () =>
          this.settle({
            kind: 'error',
            text: $localize`:@@transcribers.revokeFailed:Não consegui revogar. Tente de novo.`,
          }),
      });
  }

  protected async copy(what: Copied): Promise<void> {
    const paired = this.paired();
    const text = what === 'token' ? paired?.token : this.command();
    const clipboard = this.view?.navigator.clipboard;
    if (!text || !clipboard) return this.flashCopy(what, 'failed');
    try {
      await clipboard.writeText(text);
      this.flashCopy(what, 'copied');
    } catch {
      this.flashCopy(what, 'failed');
    }
  }

  protected copyLabelOf(what: Copied): CopyState {
    const current = this.copyState();
    return current.what === what ? current.state : 'idle';
  }

  private showPaired(paired: PairedTranscriber): void {
    this.paired.set(paired);
    this.name.set('');
    this.settle(null);
    // The box takes the focus, so a screen reader reads the token and the steps (UP-01).
    this.focusAfterRender(() => this.pairedBox()?.nativeElement);
  }

  /** A name already in use is the field's problem (MA-23); anything else, the status's. */
  private pairFailed(err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 409) {
      this.busy.set(false);
      this.nameProblem.set('taken');
      return this.focusAfterRender(() => this.nameInput().nativeElement);
    }
    this.settle({
      kind: 'error',
      text: $localize`:@@transcribers.pairFailed:Não consegui parear. Tente de novo.`,
    });
  }

  /** The row went: the focus goes to the list's title and the status says what happened. */
  private revoked(transcriber: Transcriber): void {
    this.confirming.set(null);
    this.settle({
      kind: 'ok',
      text: $localize`:@@transcribers.revoked:"${transcriber.name}:name:" revogado.`,
    });
    this.focusAfterRender(() => this.listTitle().nativeElement);
  }

  private settle(notice: Notice | null): void {
    this.busy.set(false);
    this.notice.set(notice);
    this.list.reload();
  }

  private flashCopy(what: Copied, state: CopyState): void {
    this.copyState.set({ what, state });
    this.notice.set(
      state === 'copied'
        ? { kind: 'ok', text: COPIED[what]() }
        : {
            kind: 'error',
            text: $localize`:@@transcribers.copyFailedNotice:Não deu para copiar. Selecione o texto e copie.`,
          },
    );
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(
      () => this.copyState.set({ what, state: 'idle' }),
      COPY_FEEDBACK_MS,
    );
  }

  private find(selector: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(selector);
  }

  private focusAfterRender(target: () => HTMLElement | null | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }
}

import { DatePipe, DOCUMENT } from '@angular/common';
import { httpResource } from '@angular/common/http';
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

/** How long "Copiado" stays before the button reads "Copiar" again. */
const COPY_FEEDBACK_MS = 2_500;

/**
 * "Transcritores" (KBC-036 FR-5, BR-1; masters only): pair the Mac that transcribes, see
 * when each was last seen and what it transcribes, revoke one. The token shows once.
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
  private readonly pairedBox = viewChild<ElementRef<HTMLElement>>('pairedBox');

  protected readonly list = httpResource(() => transcribersUrl(), {
    parse: (body) => transcriberListSchema.parse(body),
  });
  protected readonly items = computed<Transcriber[]>(() =>
    this.list.hasValue() ? this.list.value().items : [],
  );
  protected readonly name = signal('');
  protected readonly nameError = signal(false);
  protected readonly busy = signal(false);
  protected readonly failed = signal<'pair' | 'revoke' | null>(null);
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

  protected editName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.nameError.set(false);
  }

  protected pair(event: Event): void {
    event.preventDefault();
    const name = this.name().trim();
    if (!name) return this.nameError.set(true);
    this.busy.set(true);
    this.failed.set(null);
    this.api
      .pair(name)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (paired) => this.showPaired(paired),
        error: () => this.settle('pair'),
      });
  }

  /** "Pronto": the token goes away for good. */
  protected closePaired(): void {
    this.paired.set(null);
  }

  /** "Revogar Mac do dono": which one, for a screen reader in a list of buttons. */
  protected revokeLabelOf(transcriber: Transcriber): string {
    return $localize`:@@transcribers.revokeLabel:Revogar ${transcriber.name}:name:`;
  }

  protected askRevoke(id: string): void {
    this.confirming.set(id);
  }

  protected cancelRevoke(): void {
    this.confirming.set(null);
  }

  protected revoke(transcriber: Transcriber): void {
    this.busy.set(true);
    this.failed.set(null);
    this.api
      .revoke(transcriber.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.confirming.set(null);
          this.settle(null);
        },
        error: () => this.settle('revoke'),
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
    afterNextRender(() => this.pairedBox()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  private settle(failure: 'pair' | 'revoke' | null): void {
    this.busy.set(false);
    this.failed.set(failure);
    this.list.reload();
  }

  private flashCopy(what: Copied, state: CopyState): void {
    this.copyState.set({ what, state });
    setTimeout(
      () => this.copyState.set({ what, state: 'idle' }),
      COPY_FEEDBACK_MS,
    );
  }
}

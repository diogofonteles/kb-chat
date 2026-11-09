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
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TRANSCRIBER_KINDS,
  transcriberListSchema,
  type PairedTranscriber,
  type Transcriber,
  type UpdateTranscriberRequest,
} from '@kb-chat/contracts';
import { seenAtFormat } from '@core/i18n/date-formats.js';
import { TranscriberStatus } from './transcriber-status.js';
import { TranscriberStatusStore } from './transcriber-status-store.js';
import {
  TranscribersApi,
  transcribersUrl,
} from '@core/media/transcribers-api.js';

type Kind = UpdateTranscriberRequest['kinds'][number];
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

/** What a transcriber may do, with `kind` in or out. */
const withKind = (
  kinds: readonly Transcriber['kinds'][number][],
  kind: Kind,
  on: boolean,
): Kind[] => {
  const others = kinds.filter(
    (one): one is Kind => one !== kind && isTranscriberKind(one),
  );
  return on ? [...others, kind] : others;
};

const isTranscriberKind = (kind: string): kind is Kind =>
  (TRANSCRIBER_KINDS as readonly string[]).includes(kind);

/**
 * "Transcritores" (KBC-036 FR-5, BR-1; masters only): pair the Mac that transcribes, see
 * when each was last seen and what it transcribes, revoke one. The token shows once. The
 * focus never falls to the page when what held it goes away (WCAG 2.4.3).
 */
@Component({
  selector: 'app-transcribers-panel',
  imports: [DatePipe, TranscriberStatus],
  providers: [TranscriberStatusStore],
  templateUrl: './transcribers-panel.html',
  styleUrls: ['../settings/settings-form.css', './transcribers-panel.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TranscribersPanel {
  private readonly api = inject(TranscribersApi);
  /** The rows' status chips: read again with the list, so a new pairing has its own. */
  private readonly status = inject(TranscriberStatusStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly pairedBox = viewChild<ElementRef<HTMLElement>>('pairedBox');
  private readonly nameInput =
    viewChild.required<ElementRef<HTMLInputElement>>('nameInput');
  private readonly pairButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('pairButton');
  private readonly listTitle =
    viewChild.required<ElementRef<HTMLElement>>('listTitle');
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Bumped after each change: a new request cancels a read still on its way. `reload()`
   * does nothing then, and that read, sent before the change, answers without it (a new
   * pairing missing from "Pareados").
   */
  private readonly listVersion = signal(0);
  protected readonly list = httpResource(
    () => {
      this.listVersion();
      return { url: transcribersUrl() };
    },
    { parse: (body) => transcriberListSchema.parse(body) },
  );
  /**
   * The rows last read, kept while the next read is on its way: a new request empties the
   * resource, and the rows (and the focus in them) must not blink away.
   */
  private readonly shown = linkedSignal<
    Transcriber[] | null,
    Transcriber[] | null
  >({
    source: () => (this.list.hasValue() ? this.list.value().items : null),
    computation: (items, previous) => items ?? previous?.value ?? null,
  });
  protected readonly listLoaded = computed(() => this.shown() !== null);
  protected readonly items = computed<Transcriber[]>(() => this.shown() ?? []);
  /** The same "visto em" format as the media list's (UP-05). */
  protected readonly seenAtFormat = seenAtFormat();
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

  protected separatesVoices(transcriber: Transcriber): boolean {
    return transcriber.kinds.includes('diarize');
  }

  /** "Separa vozes: Mac do dono": which one, in a list of alike boxes (WCAG 2.5.3). */
  protected diarizeLabelOf(transcriber: Transcriber): string {
    return $localize`:@@transcribers.diarizeLabel:Separa vozes: ${transcriber.name}:name:`;
  }

  /** Marks or unmarks "Separa vozes" (KBC-064 FR-6); the status says what changed. */
  protected toggleDiarize(transcriber: Transcriber, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.setKinds(
      transcriber,
      withKind(transcriber.kinds, 'diarize', on),
      on
        ? $localize`:@@transcribers.diarizeOn:"${transcriber.name}:name:" agora separa vozes.`
        : $localize`:@@transcribers.diarizeOff:"${transcriber.name}:name:" não separa mais vozes.`,
    );
  }

  protected calculatesPrints(transcriber: Transcriber): boolean {
    return transcriber.kinds.includes('voice-profile');
  }

  /** "Perfis de voz: Mac do dono": which one, in a list of alike boxes (WCAG 2.5.3). */
  protected voicePrintLabelOf(transcriber: Transcriber): string {
    return $localize`:@@transcribers.voicePrintLabel:Perfis de voz: ${transcriber.name}:name:`;
  }

  /** Off on every transcriber: without it no voice print reaches this Mac (ADR 0032). */
  protected toggleVoicePrints(transcriber: Transcriber, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.setKinds(
      transcriber,
      withKind(transcriber.kinds, 'voice-profile', on),
      on
        ? $localize`:@@transcribers.voicePrintOn:"${transcriber.name}:name:" agora trata perfis de voz.`
        : $localize`:@@transcribers.voicePrintOff:"${transcriber.name}:name:" não trata mais perfis de voz.`,
    );
  }

  protected publishes(transcriber: Transcriber): boolean {
    return transcriber.kinds.includes('kb-publish');
  }

  /** "Publica no acervo: Mac do dono": which one, in a list of alike boxes (WCAG 2.5.3). */
  protected publishLabelOf(transcriber: Transcriber): string {
    return $localize`:@@transcribers.publishLabel:Publica no acervo: ${transcriber.name}:name:`;
  }

  /** Off on every transcriber: kb spends on the owner's key (KBC-099 BR-1, ADR 0035 §11). */
  protected togglePublish(transcriber: Transcriber, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.setKinds(
      transcriber,
      withKind(transcriber.kinds, 'kb-publish', on),
      on
        ? $localize`:@@transcribers.publishOn:"${transcriber.name}:name:" agora publica as faixas no acervo.`
        : $localize`:@@transcribers.publishOff:"${transcriber.name}:name:" não publica mais as faixas no acervo.`,
    );
  }

  private setKinds(
    transcriber: Transcriber,
    kinds: readonly Kind[],
    done: string,
  ): void {
    this.busy.set(true);
    this.notice.set(null);
    this.api
      .setKinds(transcriber.id, [...kinds])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.settle({ kind: 'ok', text: done }),
        error: () =>
          this.settle({
            kind: 'error',
            text: $localize`:@@transcribers.diarizeFailed:Não consegui mudar. Tente de novo.`,
          }),
      });
  }

  protected revoke(transcriber: Transcriber): void {
    this.busy.set(true);
    this.notice.set(null);
    this.api
      .revoke(transcriber.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.revoked(transcriber),
        error: () => this.revokeFailed(transcriber.id),
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
    // The button was disabled while it waited, which drops the focus: give it back.
    this.focusAfterRender(() => this.pairButton().nativeElement);
  }

  /** The question stays open; the focus goes back to its "Revogar" to try again. */
  private revokeFailed(id: string): void {
    this.settle({
      kind: 'error',
      text: $localize`:@@transcribers.revokeFailed:Não consegui revogar. Tente de novo.`,
    });
    this.focusAfterRender(() => this.find(`[data-confirm-revoke="${id}"]`));
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
    this.listVersion.update((version) => version + 1);
    this.status.reload();
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

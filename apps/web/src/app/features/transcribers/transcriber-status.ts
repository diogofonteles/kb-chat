import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  MediaJobKind,
  TranscriberStatusItem,
  TranscriberStatusReport,
} from '@kb-chat/contracts';
import { TranscribersApi } from '@core/media/transcribers-api.js';
import { publicationTime } from '../media/track-publication/publication-time.js';
import { TranscriberStatusStore } from './transcriber-status-store.js';

type State = TranscriberStatusItem['state'];
type Report = NonNullable<TranscriberStatusItem['report']>;

/** Never only color (AC-14): each state has its sign beside its words. */
const ICON: Record<State | 'none', string> = {
  idle: '●',
  working: '↻',
  waiting: '⏸',
  error: '⚠',
  offline: '○',
  none: '○',
};

const STATE_WORD: Record<State, () => string> = {
  idle: () => $localize`:@@transcriberStatus.idle:Ligado`,
  working: () => $localize`:@@transcriberStatus.working:Trabalhando`,
  waiting: () => $localize`:@@transcriberStatus.waiting:Aguardando`,
  error: () => $localize`:@@transcriberStatus.error:Com erro`,
  offline: () => $localize`:@@transcriberStatus.offline:Desligado`,
};

const KIND_WORD: Partial<Record<MediaJobKind, () => string>> = {
  transcribe: () =>
    $localize`:@@transcriberStatus.kindTranscribe:transcrevendo`,
  diarize: () => $localize`:@@transcriberStatus.kindDiarize:separando vozes de`,
  'voice-profile': () =>
    $localize`:@@transcriberStatus.kindVoice:calculando um perfil de voz`,
  'kb-publish': () => $localize`:@@transcriberStatus.kindPublish:no acervo:`,
};

const OUTCOME_WORD: Record<
  Report['recentJobs'][number]['outcome'],
  () => string
> = {
  done: () => $localize`:@@transcriberStatus.done:feito`,
  failed: () => $localize`:@@transcriberStatus.failed:falhou`,
  stopped: () => $localize`:@@transcriberStatus.stopped:interrompido`,
};

/** "transcrevendo Aula 3 (40%)". */
const jobText = (job: NonNullable<Report['currentJob']>): string => {
  const kind = KIND_WORD[job.kind]?.() ?? job.kind;
  const progress = job.progress === null ? '' : ` (${job.progress}%)`;
  return `${kind} ${job.label}${progress}`;
};

/** "desde 14:02": on since it started, off since it was last seen (AC-16). */
const sinceOf = (item: TranscriberStatusItem): string | null => {
  const at =
    item.state === 'idle'
      ? item.report?.startedAt
      : item.state === 'offline'
        ? item.lastSeenAt
        : null;
  return at
    ? $localize`:@@transcriberStatus.since:desde ${publicationTime(at)}:time:`
    : null;
};

/** What waits and who should take it, per kind (QA F-1): words and the mark to set. */
const BLOCKED_WORDS: Partial<Record<MediaJobKind, (ready: number) => string>> =
  {
    transcribe: (ready) =>
      $localize`:@@transcriberStatus.blockedTranscribe:${ready}:ready: transcrições esperam: nenhum transcritor está marcado para transcrever.`,
    diarize: (ready) =>
      $localize`:@@transcriberStatus.blockedDiarize:${ready}:ready: trabalhos de Vozes esperam: nenhum transcritor separa vozes. Marque "Separa vozes" em Transcritores.`,
    'voice-profile': (ready) =>
      $localize`:@@transcriberStatus.blockedVoice:${ready}:ready: perfis de voz esperam: nenhum transcritor calcula perfis de voz. Marque "Perfis de voz" em Transcritores.`,
    'kb-publish': (ready) =>
      $localize`:@@transcriberStatus.blockedPublish:${ready}:ready: documentos esperam publicação: nenhum transcritor publica no acervo. Marque "Publica no acervo" em Transcritores.`,
  };

const stuckText = (ready: number): string =>
  $localize`:@@transcriberStatus.stuck:O transcritor ligou e não pegou o trabalho da fila (${ready}:ready:). Ele liga de novo quando a fila mudar.`;

/** The chip's words for a transcriber (BR-9). */
export function chipText(item: TranscriberStatusItem | null): string {
  if (!item)
    return $localize`:@@transcriberStatus.none:Nenhum transcritor pareado`;
  const report = item.report;
  const prefix = $localize`:@@transcriberStatus.prefix:Transcritor`;
  const state = STATE_WORD[item.state]();
  if (item.state === 'working' && report?.currentJob)
    return `${prefix}: ${state}, ${jobText(report.currentJob)}`;
  if ((item.state === 'waiting' || item.state === 'error') && report?.detail)
    return `${prefix}: ${state}, ${report.detail}`;
  const since = sinceOf(item);
  return since ? `${prefix}: ${state} ${since}` : `${prefix}: ${state}`;
}

/**
 * The transcriber's status chip (KBC-114 FR-10): its state in words and a sign, and on a
 * click the details in a dialog (state, current job, recent jobs, last error, last seen,
 * vault, kb), with how to turn it on when it is off. Without `transcriberId` it speaks for
 * the transcriber that publishes (the collection's notice). Esc closes it and the focus goes
 * back to the chip (native dialog).
 */
@Component({
  selector: 'app-transcriber-status',
  templateUrl: './transcriber-status.html',
  styleUrl: './transcriber-status.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TranscriberStatus {
  private readonly store = inject(TranscriberStatusStore);
  private readonly api = inject(TranscribersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly chip =
    viewChild.required<ElementRef<HTMLButtonElement>>('chip');

  /** One transcriber (a row of Transcritores); none: the one that publishes. */
  readonly transcriberId = input<string | null>(null);

  protected readonly item = computed(() => {
    const id = this.transcriberId();
    return id ? this.store.item(id) : this.store.lead();
  });
  protected readonly loaded = computed(() => this.store.overview() !== null);
  /** The status could not be read (review PD-15): never a false "none paired". */
  protected readonly unavailable = computed(
    () => this.store.failed() && !this.loaded(),
  );
  /** Work waiting that the transcriber will not do by itself (QA F-1). */
  protected readonly attention = computed(() => {
    const seen = this.store.overview()?.attention;
    if (!seen) return [];
    return [
      ...seen.blocked.map(
        (one) =>
          BLOCKED_WORDS[one.kind]?.(one.ready) ?? `${one.kind}: ${one.ready}`,
      ),
      ...(seen.stuck ? [stuckText(seen.stuck.ready)] : []),
    ];
  });
  protected readonly start = computed(
    () => this.store.overview()?.start ?? null,
  );
  protected readonly kbWaiting = computed(
    () => this.store.overview()?.kbQueue.waiting ?? 0,
  );
  protected readonly state = computed<State | 'none'>(
    () => this.item()?.state ?? 'none',
  );
  /**
   * Off, with work it will not take by itself: the summary chip (where work is triggered)
   * says so before anything else; a row of Transcritores keeps its own state.
   */
  private readonly stalled = computed(
    () =>
      this.transcriberId() === null &&
      (this.state() === 'offline' || this.state() === 'none') &&
      this.attention().length > 0,
  );
  protected readonly icon = computed(() =>
    this.unavailable() || this.stalled() ? '⚠' : ICON[this.state()],
  );
  protected readonly text = computed(() => {
    if (this.unavailable())
      return $localize`:@@transcriberStatus.unavailable:Transcritor: status indisponível`;
    if (this.stalled())
      return $localize`:@@transcriberStatus.stalled:Transcritor: trabalho parado`;
    // A row's transcriber the status has not caught up with yet (just paired): off.
    if (this.transcriberId() !== null && this.item() === null)
      return `${$localize`:@@transcriberStatus.prefix:Transcritor`}: ${STATE_WORD.offline()}`;
    return chipText(this.item());
  });
  protected readonly report = computed<Report | null>(
    () => this.item()?.report ?? null,
  );
  protected readonly stateWord = computed(() => {
    const item = this.item();
    return item ? STATE_WORD[item.state]() : '';
  });
  protected readonly currentJob = computed(() => {
    const job = this.report()?.currentJob;
    return job && this.item()?.state === 'working' ? jobText(job) : null;
  });
  protected readonly offline = computed(
    () => this.state() === 'offline' || this.state() === 'none',
  );
  protected readonly titleId = `transcriber-status-${Math.random().toString(36).slice(2, 9)}`;
  protected readonly starting = signal(false);
  protected readonly notice = signal('');

  protected readonly time = publicationTime;
  protected outcomeOf(outcome: Report['recentJobs'][number]['outcome']) {
    return OUTCOME_WORD[outcome]();
  }
  protected kindOf(kind: MediaJobKind): string {
    return KIND_WORD[kind]?.() ?? kind;
  }
  protected recentLabel(job: TranscriberStatusReport['recentJobs'][number]) {
    return `${this.kindOf(job.kind)} ${job.label}`;
  }

  protected open(): void {
    this.notice.set('');
    this.store.reload();
    this.dialog().nativeElement.showModal();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /**
   * The focus goes back to the chip however the dialog closed (Esc, "Fechar"): Safari does
   * not focus a button on a click, so the dialog alone would give it back elsewhere.
   */
  protected backToChip(): void {
    this.chip().nativeElement.focus();
  }

  protected async copy(): Promise<void> {
    const text = this.start()?.startCommand;
    const clipboard = this.view?.navigator.clipboard;
    if (!text || !clipboard) return this.copyFailed();
    try {
      await clipboard.writeText(text);
      this.notice.set($localize`:@@transcriberStatus.copied:Comando copiado.`);
    } catch {
      this.copyFailed();
    }
  }

  private copyFailed(): void {
    this.notice.set(
      $localize`:@@transcriberStatus.copyFailed:Não deu para copiar. Selecione o texto e copie.`,
    );
  }

  /** "Ligar transcritor" (BR-10): one request at a time (PD-02). */
  protected startHere(): void {
    if (this.starting()) return;
    this.starting.set(true);
    this.notice.set('');
    this.api
      .startLocal()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (started) => {
          this.starting.set(false);
          this.notice.set(
            started.ok
              ? $localize`:@@transcriberStatus.started:Pedido enviado ao macOS. O status muda em até 30 segundos.`
              : $localize`:@@transcriberStatus.startRefused:O macOS não ligou o transcritor: ${started.detail}:detail:`,
          );
          this.store.reload();
        },
        error: () => {
          this.starting.set(false);
          this.notice.set(
            $localize`:@@transcriberStatus.startFailed:Não consegui pedir para ligar. Use o comando abaixo no Mac.`,
          );
        },
      });
  }
}

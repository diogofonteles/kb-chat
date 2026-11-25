import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { UploadedDocumentRef } from '@kb-chat/contracts';
import {
  UiButton,
  UiIcon,
  UiIconButton,
  UiPill,
  UiProgress,
} from '@ui/index.js';
import type { Tone } from '@ui/pill.js';
import type { ContentSend, SendPhase } from './content-sender.js';

const LABELS: Record<
  SendPhase['kind'],
  { readonly text: string; readonly tone: Tone }
> = {
  waiting: {
    text: $localize`:@@addContent.phase.waiting:Na vez`,
    tone: 'muted',
  },
  hashing: {
    text: $localize`:@@addContent.phase.hashing:Preparando`,
    tone: 'info',
  },
  sending: {
    text: $localize`:@@addContent.phase.sending:Enviando`,
    tone: 'info',
  },
  paused: {
    text: $localize`:@@addContent.phase.paused:Esperando`,
    tone: 'warn',
  },
  sent: { text: $localize`:@@addContent.phase.sent:Recebido`, tone: 'ok' },
  duplicate: {
    text: $localize`:@@addContent.phase.duplicate:Já está no acervo`,
    tone: 'muted',
  },
  error: {
    text: $localize`:@@addContent.phase.error:Não foi enviado`,
    tone: 'err',
  },
};
const ICONS = { file: 'file', audio: 'music', url: 'link' } as const;
const PAUSED = {
  offline: $localize`:@@addContent.paused.offline:Sem rede. Continua sozinho quando ela voltar.`,
  limit: $localize`:@@addContent.paused.limit:Muitos envios por minuto. Continua sozinho em instantes.`,
} as const;
const ON_ITS_WAY = $localize`:@@addContent.phase.onItsWay:Já está a caminho`;

/** One item of "Enviados agora" (KBC-184): how far it got, and what can be done about it. */
@Component({
  selector: 'app-content-send-row',
  imports: [UiButton, UiIcon, UiIconButton, UiPill, UiProgress],
  template: `
    <ui-icon [name]="icon()" [size]="20" />
    <div class="text">
      <p class="name">{{ send().name }}</p>
      @if (topicTitle(); as title) {
        <p class="meta">{{ title }}</p>
      }
      @if (paused(); as why) {
        <p class="meta">{{ why }}</p>
      }
      @if (percent() !== null) {
        <ui-progress [value]="(percent() ?? 0) / 100" />
      }
      @if (error(); as message) {
        <p class="problem">{{ message }}</p>
      }
    </div>
    <ui-pill [tone]="tone()">{{ label() }}</ui-pill>
    @if (document(); as doc) {
      <button
        uiButton="outline"
        size="sm"
        type="button"
        (click)="opened.emit(doc)"
      >
        <span i18n="@@addContent.open">Abrir</span>
      </button>
    }
    @if (error()) {
      <button
        uiButton="outline"
        size="sm"
        type="button"
        (click)="retried.emit()"
      >
        <span i18n="@@addContent.retry">Tentar de novo</span>
      </button>
    }
    @if (removable()) {
      <button
        uiIconButton
        type="button"
        [size]="44"
        [attr.aria-label]="removeLabel()"
        (click)="removed.emit()"
      >
        <ui-icon name="close" [size]="18" />
      </button>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
      min-height: 2.75rem;
    }

    .text {
      display: grid;
      flex: 1 1 12rem;
      gap: var(--space-1);
      min-width: 0;
    }

    .text p {
      margin: 0;
    }

    .name {
      font-size: var(--text-sm);
      overflow-wrap: anywhere;
    }

    .meta {
      color: var(--color-text-muted);
      font-size: var(--text-meta);
    }

    .problem {
      color: var(--color-danger);
      font-size: var(--text-meta);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentSendRow {
  readonly send = input.required<ContentSend>();
  /** Its collection's name, when the list mixes collections. */
  readonly topicTitle = input('');
  readonly retried = output();
  readonly removed = output();
  readonly opened = output<UploadedDocumentRef>();

  private readonly phase = computed(() => this.send().phase);
  protected readonly removeLabel = computed(
    () =>
      $localize`:@@addContent.remove:Tirar ${this.send().name}:name: da lista`,
  );
  protected readonly icon = computed(() => ICONS[this.send().source.kind]);
  protected readonly tone = computed(() => LABELS[this.phase().kind].tone);
  protected readonly label = computed(() => {
    const phase = this.phase();
    return phase.kind === 'duplicate' && phase.onItsWay
      ? ON_ITS_WAY
      : LABELS[phase.kind].text;
  });
  protected readonly percent = computed(() => {
    const phase = this.phase();
    return phase.kind === 'hashing' || phase.kind === 'sending'
      ? phase.percent
      : null;
  });
  protected readonly paused = computed(() => {
    const phase = this.phase();
    return phase.kind === 'paused' ? PAUSED[phase.why] : '';
  });
  protected readonly error = computed(() => {
    const phase = this.phase();
    return phase.kind === 'error' ? phase.message : '';
  });
  protected readonly document = computed(() => {
    const phase = this.phase();
    return phase.kind === 'duplicate' ? phase.document : null;
  });
  /** What is under way stays; anything else can leave the list. */
  protected readonly removable = computed(() => this.percent() === null);
}

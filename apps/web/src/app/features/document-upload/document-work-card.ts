import { formatNumber } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DocumentUpload, DocumentWork } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { UiPill, UiProgress } from '@ui/index.js';
import type { Tone } from '@ui/pill.js';
import {
  aboutText,
  durationText,
  macStateOf,
  secondsSince,
  summaryOf,
  type UploadPhase,
} from './document-progress.js';
import { labelOf } from './upload-labels.js';

interface MacLine {
  readonly tone: Tone;
  readonly pill: string;
  readonly text: string;
  /** Where a master links a Mac to the app. */
  readonly pair: boolean;
}

/** "2 em andamento", for each way of standing but the ready ones. */
const PART_TEXTS: Record<
  Exclude<UploadPhase, 'ready'>,
  (n: number) => string
> = {
  active: (n) => $localize`:@@docProgress.part.active:${n}:count: em andamento`,
  waiting: (n) => $localize`:@@docProgress.part.waiting:${n}:count: na fila`,
  yours: (n) =>
    n === 1
      ? $localize`:@@docProgress.part.yoursOne:1 espera você`
      : $localize`:@@docProgress.part.yours:${n}:count: esperam você`,
  failed: (n) =>
    n === 1
      ? $localize`:@@docProgress.part.failedOne:1 falhou`
      : $localize`:@@docProgress.part.failed:${n}:count: falharam`,
};
const PARTS = ['active', 'waiting', 'yours', 'failed'] as const;

/** What else the Mac is at: it takes one thing at a time. */
const DOING_TEXTS: Record<
  NonNullable<DocumentWork['mac']['doing']>,
  () => string
> = {
  recording: () =>
    $localize`:@@docProgress.mac.recording:Está transcrevendo uma gravação agora.`,
  publishing: () =>
    $localize`:@@docProgress.mac.publishing:Está publicando uma transcrição no acervo agora.`,
};

/**
 * How everything that was sent stands (KBC-184): how many are ready, what the Mac does now,
 * how long is left, what was spent, and whether the Mac is there at all.
 */
@Component({
  selector: 'app-document-work-card',
  imports: [RouterLink, UiPill, UiProgress],
  template: `
    <div class="top" role="status">
      <p class="count">{{ countText() }}</p>
      @if (parts(); as text) {
        <p class="parts">{{ text }}</p>
      }
    </div>
    <ui-progress [value]="share()" />
    @if (mac(); as line) {
      <div class="mac">
        <ui-pill [tone]="line.tone">{{ line.pill }}</ui-pill>
        @if (line.text) {
          <p class="line">
            {{ line.text }}
            @if (line.pair) {
              <a
                routerLink="/configuracoes/transcritores"
                i18n="@@docProgress.mac.pair"
                >Abrir Transcritores</a
              >
            }
          </p>
        }
      </div>
    }
    @if (lowBalance(); as text) {
      <p class="low">
        {{ text }}
        <a
          href="https://openrouter.ai/settings/credits"
          target="_blank"
          rel="noopener"
          i18n="@@docProgress.lowBalanceAdd"
          >Adicionar saldo</a
        >
      </p>
    }
    @if (now() || left() || spent()) {
      <dl>
        @if (now(); as text) {
          <div class="fact wide">
            <dt i18n="@@docProgress.now">Agora</dt>
            <dd>{{ text }}</dd>
          </div>
        }
        @if (left(); as text) {
          <div class="fact">
            <dt i18n="@@docProgress.left">Falta</dt>
            <dd>{{ text }}</dd>
          </div>
        }
        @if (spent(); as text) {
          <div class="fact">
            <dt i18n="@@docProgress.spent">Gasto</dt>
            <dd>{{ text }}</dd>
          </div>
        }
      </dl>
    }
  `,
  styleUrl: './document-work-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentWorkCard {
  private readonly locale = inject(LOCALE_ID);
  private readonly isMaster = inject(SessionStore).isMaster;

  readonly uploads = input.required<readonly DocumentUpload[]>();
  readonly work = input.required<DocumentWork | null>();
  /** When what is shown was read. */
  readonly at = input.required<number>();

  private readonly summary = computed(() => summaryOf(this.uploads()));
  protected readonly countText = computed(() => {
    const { total, counts } = this.summary();
    return total === 1
      ? $localize`:@@docProgress.countOne:${counts.ready}:ready: de 1 pronto`
      : $localize`:@@docProgress.count:${counts.ready}:ready: de ${total}:total: prontos`;
  });
  protected readonly share = computed(() => {
    const { total, counts } = this.summary();
    return total === 0 ? 0 : counts.ready / total;
  });
  protected readonly parts = computed(() => {
    const { counts } = this.summary();
    return PARTS.filter((one) => counts[one] > 0)
      .map((one) => PART_TEXTS[one](counts[one]))
      .join(' · ');
  });
  protected readonly now = computed(() => {
    const { working } = this.summary();
    const since = working?.progress.startedAt;
    if (!working || !since) return '';
    const step = labelOf(working).text();
    const ago = durationText(secondsSince(since, this.at()));
    return $localize`:@@docProgress.nowText:${working.name}:name: — ${step}:step:, há ${ago}:since:`;
  });
  protected readonly left = computed(() => {
    const { secondsLeft, hasTranscription } = this.summary();
    if (secondsLeft === null) return '';
    const time = aboutText(secondsLeft);
    return hasTranscription
      ? $localize`:@@docProgress.leftAndTranscription:${time}:time: no Mac, mais a transcrição das gravações`
      : $localize`:@@docProgress.leftText:${time}:time: no Mac`;
  });
  protected readonly spent = computed(() => {
    const { spentUsd, capUsd } = this.summary();
    if (capUsd === null) return '';
    return $localize`:@@docProgress.spentText:US$ ${this.money(spentUsd)}:spent: de US$ ${this.money(capUsd)}:cap:`;
  });
  /** Nothing is said of the Mac once nothing waits for it. */
  protected readonly mac = computed<MacLine | null>(() => {
    const work = this.work();
    const { counts } = this.summary();
    if (!work || counts.waiting + counts.active === 0) return null;
    const state = macStateOf(work);
    if (state === 'on') return this.macOn(work);
    return state === 'none' ? this.macNone() : this.macOff(work);
  });

  /** kb's account is ending (KBC-009 BR-3): the API says it to masters alone. */
  protected readonly lowBalance = computed(() => {
    const usd = this.work()?.mac.lowBalanceUsd ?? null;
    if (usd === null) return '';
    const left = formatNumber(Math.max(0, usd), this.locale, '1.2-2');
    return $localize`:@@docProgress.lowBalance:A conta da OpenRouter do kb está no fim: US$ ${left}:usd:. Sem saldo, o Mac não consegue incluir documentos.`;
  });

  private macOn({ busy, mac }: DocumentWork): MacLine {
    const { working, counts } = this.summary();
    const text = mac.doing
      ? DOING_TEXTS[mac.doing]()
      : busy && !working
        ? $localize`:@@docProgress.mac.other:Está com um item de outra pessoa ou de outro acervo agora.`
        : !busy && counts.waiting > 0
          ? $localize`:@@docProgress.mac.idle:Começa o próximo em instantes.`
          : '';
    const pill = $localize`:@@docProgress.mac.on:Mac conectado`;
    return { tone: 'ok', pill, text, pair: false };
  }

  private macOff({ mac }: DocumentWork): MacLine {
    const pill = $localize`:@@docProgress.mac.off:Mac desligado`;
    const wakes = $localize`:@@docProgress.mac.wakes:Ele liga sozinho quando há trabalho. Se não ligar, veja se o Mac está acordado e com internet.`;
    if (mac.lastSeenAt === null)
      return { tone: 'warn', pill, text: wakes, pair: false };
    const ago = durationText(secondsSince(mac.lastSeenAt, this.at()));
    const seen = $localize`:@@docProgress.mac.seen:Visto há ${ago}:time:.`;
    return { tone: 'warn', pill, text: `${seen} ${wakes}`, pair: false };
  }

  private macNone(): MacLine {
    const pill = $localize`:@@docProgress.mac.none:Nenhum Mac conectado`;
    const pair = this.isMaster();
    const text = pair
      ? $localize`:@@docProgress.mac.noneMaster:Os itens esperam. Ligue a este app um Mac que publica no acervo.`
      : $localize`:@@docProgress.mac.noneMember:Os itens esperam. Peça a um master para ligar o Mac a este app.`;
    return { tone: 'warn', pill, text, pair };
  }

  private money(usd: number): string {
    // Up to the cent, whatever a float adds to 0.07.
    const cents = Math.ceil(usd * 100 - 1e-9);
    return formatNumber(cents / 100, this.locale, '1.2-2');
  }
}

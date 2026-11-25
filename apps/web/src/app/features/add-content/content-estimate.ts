import { formatNumber } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import { CONTENT_COST_KINDS, type ContentCostKind } from '@kb-chat/contracts';
import {
  ContentCostsStore,
  type ContentCounts,
} from './content-costs-store.js';

/** Firecrawl reads a page for one credit. */
const CREDITS_PER_PAGE = 1;
/** The smallest amount worth saying: below it, "menos de US$ 0,01". */
const CENT = 0.01;

const LABELS: Record<ContentCostKind, (n: number) => string> = {
  document: (n) =>
    n === 1
      ? $localize`:@@estimate.oneDocument:1 documento`
      : $localize`:@@estimate.documents:${n}:count: documentos`,
  image: (n) =>
    n === 1
      ? $localize`:@@estimate.oneImage:1 imagem`
      : $localize`:@@estimate.images:${n}:count: imagens`,
  page: (n) =>
    n === 1
      ? $localize`:@@estimate.onePage:1 página da web`
      : $localize`:@@estimate.pages:${n}:count: páginas da web`,
  recording: (n) =>
    n === 1
      ? $localize`:@@estimate.oneRecording:1 áudio ou vídeo`
      : $localize`:@@estimate.recordings:${n}:count: áudios e vídeos`,
};

const listsText = (n: number): string =>
  n === 1
    ? $localize`:@@estimate.oneList:1 canal ou playlist`
    : $localize`:@@estimate.lists:${n}:count: canais ou playlists`;

/**
 * "Quanto deve custar" (KBC-186): what is about to be sent, by kind, before anything is sent:
 * the house's key, Firecrawl's credits and the Mac's time, from what the last ones took here.
 */
@Component({
  selector: 'app-content-estimate',
  template: `
    <section class="box" aria-labelledby="estimate-title">
      <h2 id="estimate-title" i18n="@@estimate.title">Quanto deve custar</h2>
      <dl>
        @for (row of rows(); track row.label) {
          <div class="row">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </div>
        }
        @if (counts().list > 0) {
          <div class="row">
            <dt>{{ listLabel() }}</dt>
            <dd i18n="@@estimate.listValue">
              ler não custa; você escolhe depois
            </dd>
          </div>
        }
        <div class="row total">
          <dt i18n="@@estimate.total">Total estimado</dt>
          <dd>{{ totalText() }}</dd>
        </div>
      </dl>
      <p class="basis">{{ basis() }}</p>
      @if (counts().recording > 0) {
        <p class="basis" i18n="@@estimate.transcription">
          A transcrição é feita no Mac, sem custo: cerca de 4 minutos por hora
          de gravação.
        </p>
      }
    </section>
  `,
  styles: `
    .box {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-4);
      border-radius: var(--radius-card);
      background: var(--overlay-2);
    }

    h2 {
      margin: 0;
      font-size: var(--text-sm);
      font-weight: 700;
    }

    dl {
      display: grid;
      gap: var(--space-1);
      margin: 0;
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-4);
      justify-content: space-between;
      font-size: var(--text-sm);
    }

    dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }

    .total {
      padding-top: var(--space-2);
      border-top: 1px solid var(--overlay-line);
      font-weight: 700;
    }

    .basis {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-meta);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentEstimate {
  private readonly locale = inject(LOCALE_ID);
  readonly counts = input.required<ContentCounts>();

  private readonly store = inject(ContentCostsStore);
  private readonly costs = this.store.costs;
  private readonly kinds = computed(() =>
    CONTENT_COST_KINDS.filter((kind) => this.counts()[kind] > 0),
  );
  protected readonly rows = computed(() =>
    this.kinds().map((kind) => {
      const n = this.counts()[kind];
      const value = this.money(n * this.costs()[kind].usd);
      return {
        label: LABELS[kind](n),
        value: kind === 'page' ? `${value} + ${credits(n)}` : value,
      };
    }),
  );
  protected readonly listLabel = computed(() => listsText(this.counts().list));
  protected readonly totalText = computed(() => {
    const seconds = this.store.seconds(this.counts());
    const money = this.money(this.store.usd(this.counts()));
    return seconds === 0
      ? money
      : $localize`:@@estimate.totalValue:${money}:money: · cerca de ${minutesText(seconds)}:time: no Mac`;
  });
  protected readonly basis = computed(() => {
    const samples = this.kinds().reduce(
      (sum, kind) => sum + this.costs()[kind].samples,
      0,
    );
    if (samples === 0)
      return $localize`:@@estimate.firstBasis:Com base nas primeiras medições; fica mais exato conforme você inclui.`;
    return $localize`:@@estimate.basis:Com base nas últimas ${samples}:count: inclusões daqui.`;
  });

  private money(usd: number): string {
    if (usd === 0) return $localize`:@@estimate.free:sem custo`;
    if (usd < CENT)
      return $localize`:@@estimate.lessThanCent:menos de US$ 0,01`;
    const value = formatNumber(
      Math.ceil(usd * 100 - 1e-9) / 100,
      this.locale,
      '1.2-2',
    );
    return $localize`:@@estimate.upTo:até US$ ${value}:value:`;
  }
}

const credits = (pages: number): string => {
  const n = pages * CREDITS_PER_PAGE;
  return n === 1
    ? $localize`:@@estimate.oneCredit:1 crédito do Firecrawl`
    : $localize`:@@estimate.credits:${n}:count: créditos do Firecrawl`;
};

function minutesText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return $localize`:@@estimate.minutes:${minutes}:n: min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? $localize`:@@estimate.hours:${hours}:h: h`
    : $localize`:@@estimate.hoursMinutes:${hours}:h: h ${rest}:n: min`;
}

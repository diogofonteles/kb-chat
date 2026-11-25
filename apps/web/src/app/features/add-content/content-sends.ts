import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import type { OpenedDocument } from '@features/document-upload/document-uploads-section.js';
import { UiBanner, UiButton, UiProgress } from '@ui/index.js';
import { ContentSendRow } from './content-send-row.js';
import { ContentSender } from './content-sender.js';

/** Up to this many, every item is on the screen; past it, what needs to be seen. */
const ALL_SHOWN = 12;

/**
 * "Enviados agora" (KBC-184): where everything the person included is, with an account that
 * always closes (sent + already there + failed + on their way = total). A folder of hundreds
 * shows what is going and what failed; the rest is one press away.
 */
@Component({
  selector: 'app-content-sends',
  imports: [ContentSendRow, UiBanner, UiButton, UiProgress],
  template: `
    @if (sender.sends().length > 0) {
      <section class="group" aria-labelledby="add-sends-title">
        <h2 id="add-sends-title" i18n="@@addContent.sending">Enviados agora</h2>
        <p class="sum" role="status">
          <span i18n="@@addContent.sum"
            >{{ summary().sent }} de {{ summary().total }} enviados ·
            {{ summary().already }} já estavam ·
            {{ summary().failed }} falharam</span
          >
          @if (summary().active > 0) {
            <span i18n="@@addContent.sumActive"
              >· {{ summary().active }} a caminho</span
            >
          }
        </p>
        @if (summary().active > 0) {
          <ui-progress [value]="share()" />
          <p class="hint" i18n="@@addContent.keepOpen">
            Deixe esta página aberta até terminar. Se ela fechar, escolha a
            mesma pasta de novo: só vai o que faltou.
          </p>
        } @else if (summary().failed === 0) {
          <ui-banner
            tone="ok"
            title="Tudo o que você incluiu chegou"
            i18n-title="@@addContent.allSentTitle"
            role="status"
          >
            <span i18n="@@addContent.allSent"
              >O Mac converte e põe no acervo; acompanhe abaixo.</span
            >
          </ui-banner>
        } @else {
          <ui-banner
            tone="warn"
            title="Nem tudo chegou"
            i18n-title="@@addContent.someFailedTitle"
            role="alert"
          >
            <button
              uiBannerAction
              uiButton="white"
              size="sm"
              type="button"
              (click)="sender.retryFailed()"
            >
              <span i18n="@@addContent.retryFailed"
                >Tentar de novo ({{ summary().failed }})</span
              >
            </button>
            <span i18n="@@addContent.someFailed"
              >O motivo de cada um está na lista.</span
            >
          </ui-banner>
        }
        <ul class="rows">
          @for (one of shown(); track one.key) {
            <li>
              <app-content-send-row
                [send]="one"
                (retried)="sender.retry(one.key)"
                (removed)="sender.remove(one.key)"
                (opened)="
                  opened.emit({
                    topic: one.target.topic,
                    id: $event.id,
                    title: $event.title,
                  })
                "
              />
            </li>
          }
        </ul>
        <div class="foot">
          @if (hidden() > 0 || all()) {
            <button
              uiButton="ghost"
              size="sm"
              type="button"
              [attr.aria-expanded]="all()"
              (click)="all.set(!all())"
            >
              @if (all()) {
                <span i18n="@@addContent.showFewer">Mostrar menos</span>
              } @else {
                <span i18n="@@addContent.showAll"
                  >Ver os outros {{ hidden() }}</span
                >
              }
            </button>
          }
          @if (summary().active === 0) {
            <button
              uiButton="ghost"
              size="sm"
              type="button"
              (click)="sender.clearDone()"
            >
              <span i18n="@@addContent.clearDone">Limpar concluídos</span>
            </button>
          }
        </div>
      </section>
    }
  `,
  styles: `
    .group {
      display: grid;
      gap: var(--space-3);
    }

    h2 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 700;
    }

    .sum,
    .hint {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }

    .rows {
      display: grid;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .foot {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .foot button {
      min-height: 2.75rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentSends {
  protected readonly sender = inject(ContentSender);
  readonly opened = output<OpenedDocument>();

  protected readonly all = signal(false);
  protected readonly summary = this.sender.summary;
  protected readonly share = computed(() => {
    const { total, active } = this.summary();
    return total === 0 ? 0 : (total - active) / total;
  });
  protected readonly shown = computed(() => {
    const sends = this.sender.sends();
    if (this.all() || sends.length <= ALL_SHOWN) return sends;
    // What is going now and what failed; then, as they fit, the next in line.
    const urgent = sends.filter(({ phase }) =>
      ['hashing', 'sending', 'error'].includes(phase.kind),
    );
    const waiting = sends.filter(({ phase }) => phase.kind === 'waiting');
    const room = Math.max(0, ALL_SHOWN - urgent.length);
    return [...urgent, ...waiting.slice(0, room)];
  });
  protected readonly hidden = computed(
    () => this.sender.sends().length - this.shown().length,
  );
}

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { OpenedDocument } from '@features/document-upload/document-uploads-section.js';
import { UiBanner, UiButton, UiProgress } from '@ui/index.js';
import { ContentSendRow } from './content-send-row.js';
import { ContentSender } from './content-sender.js';

const alreadyText = (n: number): string =>
  n === 1
    ? $localize`:@@addContent.sumAlreadyOne:1 já estava`
    : $localize`:@@addContent.sumAlready:${n}:count: já estavam`;
const failedText = (n: number): string =>
  n === 1
    ? $localize`:@@addContent.sumFailedOne:1 falhou`
    : $localize`:@@addContent.sumFailed:${n}:count: falharam`;

/** Up to this many, every item is on the screen; past it, what needs to be seen. */
const ALL_SHOWN = 12;

/**
 * "Enviados agora" (KBC-184): where everything the person included is, with an account that
 * always closes (sent + already there + failed + on their way = total). A folder of hundreds
 * shows what is going and what failed; the rest is one press away.
 */
@Component({
  selector: 'app-content-sends',
  imports: [ContentSendRow, RouterLink, UiBanner, UiButton, UiProgress],
  template: `
    @if (sender.sends().length > 0) {
      <section class="group" aria-labelledby="add-sends-title">
        <h2
          id="add-sends-title"
          #title
          tabindex="-1"
          i18n="@@addContent.sending"
        >
          Enviados agora
        </h2>
        <p class="sum" role="status">
          {{ sum() }}
        </p>
        @if (summary().active > 0) {
          <ui-progress [value]="share()" />
          <p class="hint" i18n="@@addContent.keepOpen">
            Pode continuar usando o app; só não feche esta aba até terminar. Se
            ela fechar, escolha a mesma pasta de novo: só vai o que faltou.
          </p>
        } @else if (summary().failed + summary().givenUp === 0) {
          <ui-banner
            tone="ok"
            title="Tudo o que você incluiu chegou"
            i18n-title="@@addContent.allSentTitle"
            role="status"
          >
            <span i18n="@@addContent.allSent"
              >O Mac converte e põe no acervo; acompanhe abaixo.</span
            >
            @if (hasAudio()) {
              <a routerLink="/fila" i18n="@@addContent.audioQueue"
                >Os áudios seguem na Fila de processamento.</a
              >
            }
          </ui-banner>
        } @else {
          <ui-banner
            tone="warn"
            title="Nem tudo chegou"
            i18n-title="@@addContent.someFailedTitle"
            role="alert"
          >
            @if (summary().failed > 0) {
              <button
                uiBannerAction
                uiButton="white"
                size="sm"
                type="button"
                class="retry"
                (click)="sender.retryFailed()"
              >
                <span i18n="@@addContent.retryFailed"
                  >Tentar de novo ({{ summary().failed }})</span
                >
              </button>
              <span i18n="@@addContent.someFailed"
                >O motivo de cada um está na lista.</span
              >
            }
            @if (summary().givenUp > 0) {
              <span i18n="@@addContent.givenUp">{summary().givenUp, plural,
                =1 {1 falhou e foi tirado da lista: não chegou.}
                other {
                  {{ summary().givenUp }} falharam e foram tirados da lista: não
                  chegaram.
                }
              }</span>
            }
          </ui-banner>
        }
        <ul class="rows">
          @for (one of shown(); track one.key) {
            <li>
              <app-content-send-row
                [send]="one"
                [topicTitle]="mixed() ? titleOf(one.target.topic) : ''"
                (retried)="sender.retry(one.key)"
                (removed)="remove(one.key)"
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
                <span i18n="@@addContent.showAll">Ver mais {{ hidden() }}</span>
              }
            </button>
          }
          @if (summary().active === 0) {
            <button
              uiButton="ghost"
              size="sm"
              type="button"
              (click)="clearDone()"
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

    .foot button,
    .retry {
      min-height: 2.75rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentSends {
  protected readonly sender = inject(ContentSender);
  /** Collection names by slug, said when the list mixes collections. */
  readonly titles = input<ReadonlyMap<string, string>>(new Map());
  readonly opened = output<OpenedDocument>();
  /** The list ended: the focus has nowhere to be here. */
  readonly cleared = output();
  private readonly title = viewChild<ElementRef<HTMLElement>>('title');

  protected readonly all = signal(false);
  protected readonly summary = this.sender.summary;
  /** "3 de 4 enviados · 1 falhou": what is zero is not said, but what was sent. */
  protected readonly sum = computed(() => {
    const { sent, total, already, failed, active } = this.summary();
    return [
      $localize`:@@addContent.sumSent:${sent}:sent: de ${total}:total: enviados`,
      ...(already > 0 ? [alreadyText(already)] : []),
      ...(failed > 0 ? [failedText(failed)] : []),
      ...(active > 0
        ? [$localize`:@@addContent.sumActive:${active}:count: a caminho`]
        : []),
    ].join(' · ');
  });
  protected readonly hasAudio = computed(() =>
    this.sender.sends().some((one) => one.source.kind === 'audio'),
  );
  protected readonly mixed = computed(
    () => new Set(this.sender.sends().map((one) => one.target.topic)).size > 1,
  );
  protected readonly share = computed(() => {
    const { total, active } = this.summary();
    return total === 0 ? 0 : (total - active) / total;
  });
  protected readonly shown = computed(() => {
    const sends = this.sender.sends();
    if (this.all() || sends.length <= ALL_SHOWN) return sends;
    // What is going now and what failed; then, as they fit, the next in line.
    const urgent = sends.filter(({ phase }) =>
      ['hashing', 'sending', 'paused', 'error'].includes(phase.kind),
    );
    const waiting = sends.filter(({ phase }) => phase.kind === 'waiting');
    const room = Math.max(0, ALL_SHOWN - urgent.length);
    return [...urgent, ...waiting.slice(0, room)];
  });
  protected readonly hidden = computed(
    () => this.sender.sends().length - this.shown().length,
  );

  protected titleOf(topic: string): string {
    return this.titles().get(topic) ?? topic;
  }

  protected remove(key: number): void {
    this.sender.remove(key);
    this.keepFocus();
  }

  protected clearDone(): void {
    this.sender.clearDone();
    this.keepFocus();
  }

  /** The button pressed went away: the focus goes to the list's name, or out of it. */
  private keepFocus(): void {
    if (this.sender.sends().length > 0) this.title()?.nativeElement.focus();
    else this.cleared.emit();
  }
}

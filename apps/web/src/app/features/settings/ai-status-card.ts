import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { formatSpend } from '@core/spend/spend-store.js';
import { aiTestCodeSchema, type AiProvider } from '@kb-chat/contracts';
import { APP_AI_LABELS } from '@features/house-ai/app-ai-labels.js';
import { PROVIDER_COPY, TEST_COPY } from './provider-copy.js';
import { SettingsStore } from './settings-store.js';

import { UiButton, UiCover, UiProgress } from '@ui/index.js';

const isProvider = (id: string): id is AiProvider => id in PROVIDER_COPY;

/**
 * "Quem atende você" (KBC-022, screens.md T6): which AI serves the person now and who pays,
 * the app's ("cedida pelo administrador") or their own.
 */
@Component({
  selector: 'app-ai-status-card',
  imports: [DatePipe, UiButton, UiCover, UiProgress],
  template: `
    @if (status(); as current) {
      <div class="card" role="group" aria-labelledby="ai-status-title">
        <ui-cover
          class="art"
          icon="sparkleFill"
          title="IA"
          from="var(--cover-provider-app)"
          to="var(--cover-provider-app-dark)"
          [size]="48"
        />
        <div class="text">
          <p id="ai-status-title" class="title" i18n="@@aiStatus.title">
            Quem atende você agora
          </p>
          @if (current.source === 'app') {
            @if (lent()) {
              <p class="who">
                <strong i18n="@@aiStatus.appShort">IA da aplicação</strong>
              </p>
            } @else {
              <p class="who">
                <strong i18n="@@aiStatus.app"
                  >IA da aplicação (cedida pelo administrador)</strong
                >
              </p>
            }
            <p class="detail">
              @if (lent()) {
                <span i18n="@@aiStatus.lentIncluded"
                  >Incluído na assinatura do administrador</span
                >
              } @else {
                {{ appLabel() }} ·
                <span i18n="@@aiStatus.free">Gratuito para você</span>
              }
              @if (current.remainingToday !== null) {
                <span class="left-inline">
                  ·
                  <span i18n="@@aiStatus.remaining"
                    >Pesquisas restantes hoje: {{ current.remainingToday }} de
                    {{ current.dailyResearches }}</span
                  ></span
                >
              }
            </p>
            @if (lent()) {
              <div class="lent" role="note">
                @if (lentChatgpt()) {
                  <p i18n="@@aiStatus.lentGpt">
                    Você está usando temporariamente a IA da aplicação
                    (assinatura do ChatGPT do administrador).
                  </p>
                } @else {
                  <p i18n="@@aiStatus.lent">
                    Você está usando temporariamente a IA da aplicação
                    (assinatura do Claude do administrador).
                  </p>
                }
                @if (canConfigureOwn()) {
                  <button
                    uiButton="outline"
                    size="sm"
                    type="button"
                    (click)="configureOwn.emit()"
                    i18n="@@aiStatus.configureOwn"
                  >
                    Configurar a minha IA
                  </button>
                }
              </div>
            }
            @if (current.enforced) {
              <p class="detail" i18n="@@aiStatus.enforced">
                O administrador definiu que a IA da aplicação atende você, mesmo
                com uma IA sua configurada.
              </p>
            }
          } @else if (current.source === 'own') {
            <p class="who">
              <strong i18n="@@aiStatus.own">Sua IA</strong> ·
              {{ providerLabel() }}
              @if (planLabel()) {
                · {{ planLabel() }}
              }
            </p>
            @if (current.free && current.provider === 'gemini') {
              <p class="detail" i18n="@@aiStatus.ownFreeGoogle">
                Gratuito se o faturamento estiver desativado no Google Cloud.
              </p>
            } @else if (current.free) {
              <p class="detail" i18n="@@aiStatus.ownFree">
                Gratuito para você.
              </p>
            } @else if (spentLabel(); as spent) {
              <p class="detail" i18n="@@aiStatus.ownSpent">
                Você paga · Gasto hoje: {{ spent }}
              </p>
            } @else {
              <p class="detail" i18n="@@aiStatus.ownPays">
                Você paga o provedor (ou a sua assinatura).
              </p>
            }
          }
          @if (current.lastTest; as test) {
            <p class="detail">
              @if (test.ok) {
                <span i18n="@@aiStatus.testOk"
                  >Último teste: funcionando ({{
                    test.at | date: 'dd/MM HH:mm'
                  }})</span
                >
              } @else {
                <span i18n="@@aiStatus.testFailed"
                  >Último teste: falhou ({{
                    test.at | date: 'dd/MM HH:mm'
                  }}).</span
                >
                {{ testReason() }}
              }
            </p>
          }
          @if (current.source === 'none') {
            <p class="who" i18n="@@aiStatus.none">
              Nenhuma IA atende você agora: só a busca nos documentos.
            </p>
          }
        </div>
        @if (remaining(); as left) {
          <!-- The day's researches at the right (desktop frame), under the words on a phone. -->
          <div class="left">
            <p class="left-text" aria-hidden="true">
              <span i18n="@@aiStatus.remaining"
                >Pesquisas restantes hoje: {{ status()?.remainingToday }} de
                {{ status()?.dailyResearches }}</span
              >
            </p>
            <ui-progress [value]="left" />
          </div>
        }
      </div>
    }
  `,
  styles: `
    .card {
      display: flex;
      align-items: flex-start;
      gap: 0.875rem;
      padding: var(--space-4);
      border-radius: var(--radius-card);
      background: var(--overlay-2);
    }
    .text {
      display: grid;
      flex: 1;
      gap: 0.1875rem;
      min-width: 0;
    }
    .title {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      font-weight: 700;
    }
    .who,
    .detail {
      margin: 0;
    }
    .who {
      font-size: var(--text-md);
      font-weight: 700;
    }
    .detail {
      color: var(--color-text-muted);
      font-size: var(--text-meta);
    }
    .left {
      display: grid;
      flex: none;
      gap: 0.375rem;
      justify-items: end;
      width: 10rem;
      align-self: center;
    }
    .left ui-progress {
      width: 100%;
    }
    .left-text {
      margin: 0;
      font-size: var(--text-xs);
      font-weight: 700;
      white-space: nowrap;
    }
    /* On desktop the count is read here but drawn at the right, beside the bar. */
    .left-inline {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .lent {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
      margin-top: var(--space-2);
      padding: var(--space-3);
      border: 1px solid var(--color-accent);
      border-radius: var(--radius-card);
      background: var(--overlay-1);
    }
    .lent p {
      margin: 0;
      font-weight: 600;
    }
    @media (max-width: 1023px) {
      .card {
        flex-wrap: wrap;
      }
      .left {
        display: none;
      }
      .left-inline {
        position: static;
        width: auto;
        height: auto;
        overflow: visible;
        clip-path: none;
        white-space: normal;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiStatusCard {
  private readonly store = inject(SettingsStore);
  /** The person may choose their own AI (the button shows only then, KBC-024 BR-6). */
  readonly canConfigureOwn = input(true);
  /** "Configurar a minha IA" on a lent subscription (KBC-024): the panel shows the options. */
  readonly configureOwn = output();
  private readonly locale = inject(LOCALE_ID);

  protected readonly status = computed(() =>
    this.store.aiStatus.hasValue() ? this.store.aiStatus.value() : null,
  );
  /** The owner's subscription lent to this person (KBC-024). */
  protected readonly lent = computed(() => {
    const appAi = this.status()?.appAi;
    return appAi === 'claude-subscription' || appAi === 'chatgpt-subscription';
  });
  /** Which of the administrator's subscriptions, in the notice. */
  protected readonly lentChatgpt = computed(
    () => this.status()?.appAi === 'chatgpt-subscription',
  );
  protected readonly appLabel = computed(() => {
    const appAi = this.status()?.appAi;
    return appAi ? APP_AI_LABELS[appAi]() : '';
  });
  /** "US$ 0,02 de US$ 1,00" for one's own paid AI (KBC-023 AC-7). */
  protected readonly spentLabel = computed(() => {
    const status = this.status();
    if (status?.spentTodayUsd == null || status.dailyCapUsd === null) return '';
    const usd = (value: number) => formatSpend(value, this.locale);
    return $localize`:@@aiStatus.spentOf:${usd(status.spentTodayUsd)}:spent: de ${usd(status.dailyCapUsd)}:cap:`;
  });
  /** One's own plan: OpenRouter's mode or the Google tier (KBC-023 AC-1). */
  protected readonly planLabel = computed(() => {
    const provider = this.status()?.provider;
    const ai = this.store.settings()?.ai;
    if (!ai) return '';
    if (provider === 'openrouter')
      return ai.openrouter.mode === 'free'
        ? $localize`:@@aiStatus.orFree:Só modelos gratuitos`
        : $localize`:@@aiStatus.orModels:Modelo à escolha`;
    if (provider === 'gemini')
      return ai.gemini.tier === 'free'
        ? $localize`:@@aiStatus.gmFree:Plano gratuito`
        : $localize`:@@aiStatus.gmPaid:Plano pago`;
    return '';
  });
  /** Why the last test failed, in the words of "Testar conexão" (T6). */
  protected readonly testReason = computed(() => {
    const code = this.status()?.lastTest?.code;
    const known = code ? aiTestCodeSchema.safeParse(code) : null;
    return known?.success ? TEST_COPY[known.data]() : '';
  });
  /** The day's researches left, drawn as a bar beside the words (KBC-131 AC-4). */
  protected readonly remaining = computed(() => {
    const status = this.status();
    const total = status?.dailyResearches ?? 0;
    if (status?.source !== 'app' || status.remainingToday === null) return 0;
    return total > 0 ? Math.max(status.remainingToday / total, 0.0001) : 0;
  });
  protected readonly providerLabel = computed(() => {
    const provider = this.status()?.provider ?? '';
    return isProvider(provider) ? PROVIDER_COPY[provider].name() : provider;
  });
}

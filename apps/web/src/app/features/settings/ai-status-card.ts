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

const isProvider = (id: string): id is AiProvider => id in PROVIDER_COPY;

/**
 * "Quem atende você" (KBC-022, screens.md T6): which AI serves the person now and who pays,
 * the app's ("cedida pelo administrador") or their own.
 */
@Component({
  selector: 'app-ai-status-card',
  imports: [DatePipe],
  template: `
    @if (status(); as current) {
      <div class="card" role="group" aria-labelledby="ai-status-title">
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
              · {{ appLabel() }}
            </p>
          }
          <p class="detail">
            @if (lent()) {
              <span i18n="@@aiStatus.lentIncluded"
                >Incluído na assinatura do administrador</span
              >
            } @else {
              <span i18n="@@aiStatus.free">Gratuito para você</span>
            }
            @if (current.remainingToday !== null) {
              ·
              <span i18n="@@aiStatus.remaining"
                >Pesquisas restantes hoje: {{ current.remainingToday }} de
                {{ current.dailyResearches }}</span
              >
            }
          </p>
          @if (lent()) {
            <div class="lent" role="note">
              <p i18n="@@aiStatus.lent">
                Você está usando temporariamente a IA da aplicação (assinatura
                do Claude do administrador).
              </p>
              @if (canConfigureOwn()) {
                <button
                  type="button"
                  class="own"
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
            <p class="detail" i18n="@@aiStatus.ownFree">Gratuito para você.</p>
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
    }
  `,
  styles: `
    .card {
      display: grid;
      gap: var(--space-1);
      padding: var(--space-3) var(--space-4);
      border: 1px solid var(--color-border);
      border-left: 4px solid var(--color-accent);
      border-radius: var(--radius-md);
      background: var(--color-surface-muted);
    }
    .title {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-text-muted);
    }
    .who,
    .detail {
      margin: 0;
    }
    .detail {
      font-size: var(--text-sm);
    }
    .lent {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
      margin-top: var(--space-1);
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--color-accent);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
    }
    .lent p {
      margin: 0;
      font-weight: 600;
    }
    .own {
      min-height: var(--target);
      padding: 0 var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      color: var(--color-text);
      font: inherit;
      cursor: pointer;
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
  protected readonly lent = computed(
    () => this.status()?.appAi === 'claude-subscription',
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
  protected readonly providerLabel = computed(() => {
    const provider = this.status()?.provider ?? '';
    return isProvider(provider) ? PROVIDER_COPY[provider].name() : provider;
  });
}

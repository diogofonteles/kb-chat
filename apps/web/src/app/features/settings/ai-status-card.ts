import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import type { AiProvider } from '@kb-chat/contracts';
import { APP_AI_LABELS } from '@features/house-ai/app-ai-labels.js';
import { PROVIDER_COPY } from './provider-copy.js';
import { SettingsStore } from './settings-store.js';

const isProvider = (id: string): id is AiProvider => id in PROVIDER_COPY;

/**
 * "Quem atende você" (KBC-022, screens.md T6): which AI serves the person now and who pays,
 * the app's ("cedida pelo administrador") or their own.
 */
@Component({
  selector: 'app-ai-status-card',
  template: `
    @if (status(); as current) {
      <div class="card" role="group" aria-labelledby="ai-status-title">
        <p id="ai-status-title" class="title" i18n="@@aiStatus.title">
          Quem atende você agora
        </p>
        @if (current.source === 'app') {
          <p class="who">
            <strong i18n="@@aiStatus.app"
              >IA da aplicação (cedida pelo administrador)</strong
            >
            · {{ appLabel() }}
          </p>
          <p class="detail">
            <span i18n="@@aiStatus.free">Gratuito para você</span>
            @if (current.remainingToday !== null) {
              ·
              <span i18n="@@aiStatus.remaining"
                >Pesquisas restantes hoje: {{ current.remainingToday }} de
                {{ current.dailyResearches }}</span
              >
            }
          </p>
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
          </p>
          <p class="detail" i18n="@@aiStatus.ownPays">
            Você paga o provedor (ou a sua assinatura).
          </p>
        } @else {
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
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiStatusCard {
  private readonly store = inject(SettingsStore);

  protected readonly status = computed(() =>
    this.store.aiStatus.hasValue() ? this.store.aiStatus.value() : null,
  );
  protected readonly appLabel = computed(() => {
    const appAi = this.status()?.appAi;
    return appAi ? APP_AI_LABELS[appAi]() : '';
  });
  protected readonly providerLabel = computed(() => {
    const provider = this.status()?.provider ?? '';
    return isProvider(provider) ? PROVIDER_COPY[provider].name() : provider;
  });
}

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  model,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AiProvider,
  AiTestResult,
  ProviderInfo,
} from '@kb-chat/contracts';
import type { AiDraft } from './ai-draft.js';
import {
  BILLING_COPY,
  PROVIDER_COPY,
  PROVIDER_ORDER,
  TEST_COPY,
} from './provider-copy.js';
import { SettingsStore } from './settings-store.js';

interface ProviderOption {
  readonly info: ProviderInfo;
  readonly name: string;
  readonly description: string;
  readonly billing: string;
  /** Install and login steps when the CLI is missing (BR-3, AC-3). */
  readonly install: string | null;
}

type TestState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly result: AiTestResult }
  | { readonly kind: 'failed' };

const toOption = (info: ProviderInfo): ProviderOption => {
  const copy = PROVIDER_COPY[info.id];
  return {
    info,
    name: copy.name(),
    description: copy.description(),
    billing: BILLING_COPY[info.billing](),
    install: info.reason === 'cli-missing' ? (copy.install?.() ?? null) : null,
  };
};

const seconds = (ms: number): string =>
  new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(
    ms / 1000,
  );

/**
 * The AI provider choice (KBC-007): provider cards with availability, the write-only key,
 * model, daily cap and "Testar conexão". Used by Settings and by the first-run wizard.
 */
@Component({
  selector: 'app-ai-provider-form',
  templateUrl: './ai-provider-form.html',
  styleUrl: './settings-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiProviderForm {
  private readonly store = inject(SettingsStore);
  private readonly destroyRef = inject(DestroyRef);
  readonly draft = model.required<AiDraft>();
  /** The wizard shows only the choice and the key. */
  readonly compact = input(false);

  protected readonly testState = signal<TestState>({ kind: 'idle' });
  protected readonly options = computed(() => {
    const items = this.store.providerList()?.items ?? [];
    return PROVIDER_ORDER.flatMap((id) => {
      const info = items.find((item) => item.id === id);
      return info ? [toOption(info)] : [];
    });
  });
  protected readonly loading = computed(() => this.store.providers.isLoading());
  protected readonly selected = computed(() =>
    this.options().find((option) => option.info.id === this.draft().provider),
  );
  protected readonly savedKey = computed(() => {
    const id = this.draft().provider;
    const keys = this.store.settings()?.ai.keys ?? {};
    return id === 'openrouter' || id === 'anthropic' || id === 'openai'
      ? (keys[id] ?? null)
      : null;
  });
  protected readonly keyPlaceholder = computed(() =>
    this.savedKey()
      ? $localize`:@@ai.keyReplace:Trocar a chave`
      : $localize`:@@ai.keyPaste:Cole a sua chave`,
  );
  protected readonly modelPlaceholder = computed(() => {
    const fallback = this.selected()?.info.defaultModel;
    return fallback
      ? $localize`:@@ai.modelDefault:Padrão: ${fallback}:model:`
      : $localize`:@@ai.modelCli:Padrão da ferramenta`;
  });
  protected readonly testMessage = computed(() => {
    const state = this.testState();
    if (state.kind === 'running')
      return $localize`:@@aiTest.running:Testando… (até 20 segundos)`;
    if (state.kind === 'failed') return TEST_COPY.PROVIDER_UNAVAILABLE();
    if (state.kind === 'idle') return '';
    const { result } = state;
    return result.ok
      ? $localize`:@@aiTest.ok:Conexão funcionando (${result.model}:model:, ${seconds(result.latencyMs)}:seconds: s).`
      : TEST_COPY[result.code ?? 'PROVIDER_UNAVAILABLE']();
  });
  protected readonly testOk = computed(() => {
    const state = this.testState();
    return state.kind === 'done' && state.result.ok;
  });

  protected choose(provider: AiProvider): void {
    this.draft.update((draft) => ({ ...draft, provider, model: '', key: '' }));
    this.testState.set({ kind: 'idle' });
  }

  protected setKey(value: string): void {
    this.draft.update((draft) => ({ ...draft, key: value }));
  }

  protected setModel(value: string): void {
    this.draft.update((draft) => ({ ...draft, model: value }));
  }

  protected setCap(value: string): void {
    const usd = Number(value);
    if (Number.isFinite(usd) && usd >= 0 && usd <= 100)
      this.draft.update((draft) => ({ ...draft, dailyCapUsd: usd }));
  }

  /** "Remover" deletes the saved key right away (BR-1). */
  protected removeKey(): void {
    const id = this.draft().provider;
    if (id !== 'openrouter' && id !== 'anthropic' && id !== 'openai') return;
    this.store
      .save({ ai: { keys: { [id]: null } } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected test(): void {
    const { provider, key, model: chosen } = this.draft();
    if (provider === 'none') return;
    this.testState.set({ kind: 'running' });
    this.store
      .test({
        provider,
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(chosen.trim() ? { model: chosen.trim() } : {}),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => this.testState.set({ kind: 'done', result }),
        error: () => this.testState.set({ kind: 'failed' }),
      });
  }
}

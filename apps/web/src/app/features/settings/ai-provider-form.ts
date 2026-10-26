import { NgTemplateOutlet } from '@angular/common';
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
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AiProvider,
  AiTestResult,
  ProviderInfo,
} from '@kb-chat/contracts';
import {
  keyProviderOf,
  modelErrors,
  savedModels,
  type AiDraft,
  type DraftModels,
} from './ai-draft.js';
import {
  BILLING_COPY,
  NOT_ENABLED,
  NOT_INSTALLED,
  NOT_LENT,
  PROVIDER_COPY,
  PROVIDER_ORDER,
  TEST_COPY,
} from './provider-copy.js';
import { GO_TO_URL } from '@core/routing/go-to-url.js';
import { HouseAiApi } from '@core/api/house-ai-api.js';
import { ProviderGuideCard } from './provider-guide.js';
import { SettingsStore } from './settings-store.js';

interface ProviderOption {
  readonly info: ProviderInfo;
  readonly name: string;
  readonly description: string;
  readonly billing: string;
  /** Why the card cannot be chosen and what to do (BR-3, AC-3); null when it can. */
  readonly blocked: { readonly label: string; readonly steps: string } | null;
}

type TestState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly result: AiTestResult }
  | { readonly kind: 'failed' };

function blockedBy(info: ProviderInfo): ProviderOption['blocked'] {
  const copy = PROVIDER_COPY[info.id];
  if (info.reason === 'cli-missing' && copy.install)
    return { label: NOT_INSTALLED(), steps: copy.install() };
  if (info.reason === 'not-enabled' && copy.enable)
    return { label: NOT_ENABLED(), steps: copy.enable() };
  if (info.reason === 'app-unavailable' && copy.enable)
    return { label: NOT_LENT(), steps: copy.enable() };
  return null;
}

const toOption = (info: ProviderInfo): ProviderOption => {
  const copy = PROVIDER_COPY[info.id];
  return {
    info,
    name: copy.name(),
    description: copy.description(),
    billing: (copy.billing ?? BILLING_COPY[info.billing])(),
    blocked: blockedBy(info),
  };
};

const MODEL_FIELDS = [
  {
    key: 'fastModel',
    profile: 'fast',
    id: 'ai-model-fast',
    label: () => $localize`:@@ai.modelFast:Modelo rápido`,
  },
  {
    key: 'deepModel',
    profile: 'deep',
    id: 'ai-model-deep',
    label: () => $localize`:@@ai.modelDeep:Modelo profundo`,
  },
] as const;

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
  imports: [ProviderGuideCard, NgTemplateOutlet],
  templateUrl: './ai-provider-form.html',
  styleUrl: './settings-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiProviderForm {
  private readonly store = inject(SettingsStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly goTo = inject(GO_TO_URL);
  private readonly houseApi = inject(HouseAiApi);
  readonly draft = model.required<AiDraft>();
  /** The wizard shows only the choice and the key. */
  readonly compact = input(false);

  protected readonly testState = signal<TestState>({ kind: 'idle' });
  protected readonly options = computed(() => {
    const items = this.store.providerList()?.items ?? [];
    // The subscriptions are the owner's own (T6): not even offered to anyone else.
    return PROVIDER_ORDER.flatMap((id) => {
      const info = items.find((item) => item.id === id);
      return info && info.reason !== 'owner-only' ? [toOption(info)] : [];
    });
  });
  protected readonly loading = computed(() => this.store.providers.isLoading());
  protected readonly selected = computed(() =>
    this.options().find((option) => option.info.id === this.draft().provider),
  );
  /** Providers with a model to pick and a connection to test (not "app" nor "none"). */
  protected readonly hasModels = computed(() => {
    const billing = this.selected()?.info.billing;
    return billing === 'per-token' || billing === 'subscription';
  });
  protected readonly showModels = computed(
    () => this.hasModels() && !this.ownFree(),
  );
  protected readonly savedKey = computed(() => {
    const id = keyProviderOf(this.draft().provider);
    const keys = this.store.settings()?.ai.keys ?? {};
    return id ? (keys[id] ?? null) : null;
  });
  /** One's own OpenRouter on free models: the chosen models do not apply (KBC-023). */
  protected readonly ownFree = computed(
    () =>
      this.draft().provider === 'openrouter' &&
      this.draft().openrouterMode === 'free',
  );
  /**
   * The daily cap bounds only paid calls: hidden on Gemini's free tier and on free models
   * without a paid fallback (KBC-023 review R2-06).
   */
  protected readonly capApplies = computed(() => {
    const draft = this.draft();
    if (draft.provider === 'gemini') return draft.geminiTier === 'paid';
    return !this.ownFree() || draft.paidModel.trim() !== '';
  });
  /** Paid models with tools, for the paid fallback field (loaded only when needed). */
  private readonly models = rxResource({
    params: () => this.ownFree() || undefined,
    stream: () => this.houseApi.freeModels(),
  });
  protected readonly paidOptions = computed(() =>
    this.models.hasValue() ? this.models.value().paid : [],
  );
  protected readonly connecting = signal(false);
  /** "Conectar OpenRouter" could not start (said apart from the connection test). */
  protected readonly connectFailed = signal(false);
  /** A typed paid model the list does not offer is never used: said on its field. */
  protected readonly paidError = computed(() => {
    const typed = this.draft().paidModel.trim();
    const offered = this.paidOptions();
    if (!typed || offered.length === 0) return null;
    return offered.some((model) => model.id === typed)
      ? null
      : $localize`:@@ai.paidUnknown:Este modelo não está na lista de modelos pagos com ferramentas do OpenRouter.`;
  });
  protected readonly keyPlaceholder = computed(() =>
    this.savedKey()
      ? $localize`:@@ai.keyReplace:Trocar a chave`
      : $localize`:@@ai.keyPaste:Cole a sua chave`,
  );
  /** The fast and deep model fields, each with its default shown (KBC-011). */
  protected readonly modelFields = computed(() => {
    const info = this.selected()?.info;
    const draft = this.draft();
    const errors = modelErrors(draft);
    return MODEL_FIELDS.map((field) => {
      const fallback = info?.defaultModels[field.profile] ?? null;
      return {
        ...field,
        label: field.label(),
        value: draft[field.key],
        error: errors[field.key] ?? null,
        // The default already has its own first option ("Padrão: sonnet").
        choices: (info?.models ?? []).filter(
          (name) => name !== fallback || name === draft[field.key],
        ),
        defaultLabel: fallback
          ? $localize`:@@ai.modelDefault:Padrão: ${fallback}:model:`
          : $localize`:@@ai.modelCli:Padrão da ferramenta`,
      };
    });
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
    const models = savedModels(this.store.settings(), provider);
    this.draft.update((draft) => ({ ...draft, ...models, provider, key: '' }));
    this.testState.set({ kind: 'idle' });
  }

  protected setKey(value: string): void {
    this.draft.update((draft) => ({ ...draft, key: value }));
  }

  protected setModel(key: keyof DraftModels, value: string): void {
    this.draft.update((draft) => ({ ...draft, [key]: value }));
  }

  protected setCap(value: string): void {
    const usd = Number(value);
    if (Number.isFinite(usd) && usd >= 0 && usd <= 100)
      this.draft.update((draft) => ({ ...draft, dailyCapUsd: usd }));
  }

  protected setOpenRouterMode(mode: AiDraft['openrouterMode']): void {
    this.draft.update((draft) => ({ ...draft, openrouterMode: mode }));
  }

  protected setPaidModel(value: string): void {
    this.draft.update((draft) => ({ ...draft, paidModel: value }));
  }

  protected setGeminiTier(tier: AiDraft['geminiTier']): void {
    this.draft.update((draft) => ({ ...draft, geminiTier: tier }));
  }

  /** "Conectar OpenRouter": the server makes the PKCE pair; the browser goes there. */
  protected connectOpenRouter(): void {
    this.connecting.set(true);
    this.houseApi
      .connect('own')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (url) => this.goTo(url),
        error: () => {
          this.connecting.set(false);
          this.connectFailed.set(true);
        },
      });
  }

  /** "Remover" deletes the saved key right away (BR-1). */
  protected removeKey(): void {
    const id = keyProviderOf(this.draft().provider);
    if (!id) return;
    this.store
      .save({ ai: { keys: { [id]: null } } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected test(): void {
    const { provider, key, fastModel: chosen } = this.draft();
    if (provider === 'none' || provider === 'app') return;
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

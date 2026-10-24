import type {
  AiProvider,
  ProviderList,
  SettingsUpdate,
  SettingsView,
} from '@kb-chat/contracts';

/** The fast and deep model being edited; '' = the provider's default. */
export interface DraftModels {
  readonly fastModel: string;
  readonly deepModel: string;
}

/** What the AI form edits before "Salvar" (the key is typed here and never read back). */
export interface AiDraft extends DraftModels {
  readonly provider: AiProvider;
  /** '' = keep the saved key. */
  readonly key: string;
  readonly dailyCapUsd: number;
}

/**
 * The saved choice, or the default suggestion: the Claude subscription when its CLI is
 * installed (owner's decision, BR-4), else the provider answering now.
 */
export function suggestedProvider(
  view: SettingsView,
  list: ProviderList | null,
): AiProvider {
  if (view.ai.provider) return view.ai.provider;
  const claude = list?.items.find((item) => item.id === 'claude-subscription');
  if (claude?.available) return 'claude-subscription';
  const active = list?.active;
  return active && active !== 'stub' ? active : 'none';
}

/** The models saved for a provider (each provider keeps its own, KBC-011). */
export function savedModels(
  view: SettingsView | null,
  provider: AiProvider,
): DraftModels {
  const saved = provider === 'none' ? undefined : view?.ai.models[provider];
  return { fastModel: saved?.fast ?? '', deepModel: saved?.deep ?? '' };
}

export function aiDraftFrom(
  view: SettingsView,
  list: ProviderList | null,
): AiDraft {
  const provider = suggestedProvider(view, list);
  return {
    provider,
    ...savedModels(view, provider),
    key: '',
    dailyCapUsd: view.ai.dailyCapUsd,
  };
}

/** The update for "Salvar": a typed key replaces the saved one of that provider. */
export function aiUpdateFrom(
  draft: AiDraft,
): NonNullable<SettingsUpdate['ai']> {
  const key = draft.key.trim();
  const keyProvider =
    draft.provider === 'openrouter' ||
    draft.provider === 'anthropic' ||
    draft.provider === 'openai'
      ? draft.provider
      : null;
  const models =
    draft.provider === 'none'
      ? {}
      : {
          models: {
            [draft.provider]: {
              fast: draft.fastModel.trim() || null,
              deep: draft.deepModel.trim() || null,
            },
          },
        };
  return {
    provider: draft.provider,
    ...models,
    dailyCapUsd: draft.dailyCapUsd,
    ...(key && keyProvider ? { keys: { [keyProvider]: key } } : {}),
  };
}

import type {
  AiProvider,
  ProviderList,
  SettingsUpdate,
  SettingsView,
} from '@kb-chat/contracts';

/** What the AI form edits before "Salvar" (the key is typed here and never read back). */
export interface AiDraft {
  readonly provider: AiProvider;
  /** '' = the provider's default model. */
  readonly model: string;
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

export function aiDraftFrom(
  view: SettingsView,
  list: ProviderList | null,
): AiDraft {
  return {
    provider: suggestedProvider(view, list),
    model: view.ai.model ?? '',
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
  return {
    provider: draft.provider,
    model: draft.model.trim() || null,
    dailyCapUsd: draft.dailyCapUsd,
    ...(key && keyProvider ? { keys: { [keyProvider]: key } } : {}),
  };
}

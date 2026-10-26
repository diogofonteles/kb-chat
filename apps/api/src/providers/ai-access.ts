import type { AiProvider, AppAi } from '@kb-chat/contracts';

/** What serves a person (ADR 0016): an app AI, their own provider, or nothing. */
export type AiSource =
  | { readonly source: 'app'; readonly appAi: Exclude<AppAi, 'none'> }
  | {
      readonly source: 'own';
      readonly provider: Exclude<AiProvider, 'app' | 'none'>;
    }
  | { readonly source: 'none' };

export interface AiAccessInput {
  /** The person's choice in Settings; null when they never chose. */
  readonly chosen: AiProvider | null;
  /** Their assigned app AI, the house default already applied. */
  readonly appAi: AppAi;
  /** The master made the app AI win over the person's own. */
  readonly enforced: boolean;
  /** The assigned app AI can answer now (house connected, models listed). */
  readonly appAvailable: boolean;
}

/**
 * The precedence of ADR 0016: an enforced app AI; else the person's own choice ("Nenhum"
 * included); else the assigned app AI; else nothing.
 */
export function resolveAiSource(input: AiAccessInput): AiSource {
  const { chosen, appAi, enforced, appAvailable } = input;
  const app: AiSource | null =
    appAi !== 'none' && appAvailable ? { source: 'app', appAi } : null;
  if (enforced && app) return app;
  if (chosen === 'none') return { source: 'none' };
  if (chosen !== null && chosen !== 'app')
    return { source: 'own', provider: chosen };
  return app ?? { source: 'none' };
}

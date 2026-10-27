import type { AppAi, AppAiAssignment } from '@kb-chat/contracts';

/** pt-BR names of the AIs the app lends (KBC-022, KBC-024; KBC-027 adds another). */
export const APP_AI_LABELS: Record<AppAi, () => string> = {
  house: () => $localize`:@@appAi.house:Plano da casa (OpenRouter)`,
  'chatgpt-subscription': () =>
    $localize`:@@appAi.chatgptSubscription:ChatGPT do administrador`,
  'claude-subscription': () =>
    $localize`:@@appAi.claudeSubscription:Claude do administrador`,
  none: () => $localize`:@@appAi.none:Nenhuma (IA própria ou só a busca)`,
};

/** What serves a person, short ("Plano da casa (OpenRouter) (padrão)"), for their row. */
export function servingLabel(
  assignment: AppAiAssignment,
  defaultAppAi: AppAi | null,
): string {
  if (assignment !== 'default') return APP_AI_LABELS[assignment]();
  if (!defaultAppAi) return $localize`:@@appAi.defaultShort:Padrão`;
  return $localize`:@@appAi.byDefault:${APP_AI_LABELS[defaultAppAi]()}:label: (padrão)`;
}

/** An assignment's label; `default` names what the default is now. */
export function assignmentLabel(
  assignment: AppAiAssignment,
  defaultAppAi: AppAi | null,
): string {
  if (assignment !== 'default') return APP_AI_LABELS[assignment]();
  const current = defaultAppAi ? APP_AI_LABELS[defaultAppAi]() : '…';
  return $localize`:@@appAi.default:Padrão: ${current}:current:`;
}

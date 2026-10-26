import type { AppAi, AppAiAssignment } from '@kb-chat/contracts';

/** pt-BR names of the AIs the app lends (KBC-022; KBC-024/027 add the subscriptions). */
export const APP_AI_LABELS: Record<AppAi, () => string> = {
  house: () =>
    $localize`:@@appAi.house:Plano da casa (OpenRouter da aplicação)`,
  none: () =>
    $localize`:@@appAi.none:Nenhuma (a pessoa usa a própria IA ou só a busca)`,
};

/** An assignment's label; `default` names what the default is now. */
export function assignmentLabel(
  assignment: AppAiAssignment,
  defaultAppAi: AppAi | null,
): string {
  if (assignment !== 'default') return APP_AI_LABELS[assignment]();
  const current = defaultAppAi ? APP_AI_LABELS[defaultAppAi]() : '…';
  return $localize`:@@appAi.default:Padrão: ${current}:current:`;
}

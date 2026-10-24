import { errorMessage, type UiErrorCode } from '@core/api/api-error.js';

/** Wording specific to AI answers (screens.md T4) where the generic API message would mislead. */
const AI_MESSAGES: Partial<Record<UiErrorCode, () => string>> = {
  INTERNAL: () => $localize`:@@ai.failed:Não consegui gerar a resposta agora.`,
  RATE_LIMITED: () =>
    $localize`:@@ai.rateLimited:Muitas respostas em pouco tempo. Espere um minuto e tente de novo.`,
};

export const aiErrorMessage = (code: UiErrorCode): string =>
  AI_MESSAGES[code]?.() ?? errorMessage(code);

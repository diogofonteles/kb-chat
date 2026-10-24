import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorSchema, type ApiErrorCode } from '@kb-chat/contracts';

/** Client-side failure kinds next to the API's own codes. */
export type UiErrorCode = ApiErrorCode | 'OFFLINE';

/** Reads the contract's error envelope; a network failure (status 0) or a gateway error is OFFLINE. */
export function toUiErrorCode(err: unknown): UiErrorCode {
  if (!(err instanceof HttpErrorResponse)) return 'INTERNAL';
  if (err.status === 0 || err.status === 502 || err.status === 504)
    return 'OFFLINE';
  const parsed = apiErrorSchema.safeParse(err.error);
  return parsed.success ? parsed.data.error.code : 'INTERNAL';
}

const MESSAGES: Record<UiErrorCode, () => string> = {
  OFFLINE: () =>
    $localize`:@@error.offline:Não consegui falar com o servidor de busca. Verifique se ele está rodando (pnpm dev:api).`,
  SEARCH_UNAVAILABLE: () =>
    $localize`:@@error.searchUnavailable:A busca está indisponível agora. Tente de novo em instantes.`,
  INDEX_MISSING: () =>
    $localize`:@@error.indexMissing:Este acervo ainda não tem índice de busca. Rode kb index no terminal.`,
  TOPIC_NOT_FOUND: () =>
    $localize`:@@error.topicNotFound:Este acervo não existe mais no vault.`,
  DOCUMENT_NOT_FOUND: () =>
    $localize`:@@error.documentNotFound:Este documento não está mais no acervo (foi removido ou movido para a quarentena).`,
  VALIDATION_FAILED: () =>
    $localize`:@@error.validation:A pergunta não pôde ser enviada. Revise o texto e tente de novo.`,
  LLM_NOT_CONFIGURED: () =>
    $localize`:@@error.llmNotConfigured:Configure OPENROUTER_API_KEY no servidor para usar respostas com IA.`,
  LLM_INSUFFICIENT_CREDIT: () =>
    $localize`:@@error.llmCredit:Os créditos da OpenRouter acabaram. Adicione em openrouter.ai/settings/credits.`,
  DAILY_CAP_REACHED: () =>
    $localize`:@@error.dailyCap:Limite de gasto com IA de hoje atingido.`,
  FORBIDDEN_HOST: () =>
    $localize`:@@error.forbiddenHost:Acesso recusado pelo servidor.`,
  INTERNAL: () =>
    $localize`:@@error.internal:Algo deu errado do nosso lado. Tente de novo.`,
};

export const errorMessage = (code: UiErrorCode): string => MESSAGES[code]();

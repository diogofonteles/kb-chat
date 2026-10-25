import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorSchema, type ApiErrorCode } from '@kb-chat/contracts';

/** Client-side failure kinds next to the API's own codes. */
export type UiErrorCode = ApiErrorCode | 'OFFLINE';

/** Text responses (the streamed answer) carry the error envelope as a JSON string. */
function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** Reads the contract's error envelope; a network failure (status 0) or a gateway error is OFFLINE. */
export function toUiErrorCode(err: unknown): UiErrorCode {
  // rxResource wraps non-Error failures (HttpErrorResponse is one) and keeps the original as `cause`.
  if (
    !(err instanceof HttpErrorResponse) &&
    err instanceof Error &&
    err.cause instanceof HttpErrorResponse
  ) {
    return toUiErrorCode(err.cause);
  }
  if (!(err instanceof HttpErrorResponse)) return 'INTERNAL';
  if (err.status === 0 || err.status === 502 || err.status === 504)
    return 'OFFLINE';
  const parsed = apiErrorSchema.safeParse(parseBody(err.error));
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
    $localize`:@@error.llmNotConfigured:Nenhum provedor de IA está configurado. Escolha um em ⚙ Configurações.`,
  LLM_INSUFFICIENT_CREDIT: () =>
    $localize`:@@error.llmCredit:Os créditos da OpenRouter acabaram. Adicione em openrouter.ai/settings/credits.`,
  DAILY_CAP_REACHED: () =>
    $localize`:@@error.dailyCap:Limite de gasto com IA de hoje atingido. Ele volta a zero à meia-noite; o valor se ajusta em ⚙ Configurações.`,
  NOT_FOUND: () =>
    $localize`:@@error.notFound:Este endereço não existe no servidor.`,
  ANSWER_IN_PROGRESS: () =>
    $localize`:@@error.answerInProgress:Esta resposta ainda está sendo escrita.`,
  RATE_LIMITED: () =>
    $localize`:@@error.rateLimited:Muitas buscas em pouco tempo. Espere um instante e tente de novo.`,
  FORBIDDEN_HOST: () =>
    $localize`:@@error.forbiddenHost:Acesso recusado pelo servidor.`,
  UNAUTHENTICATED: () =>
    $localize`:@@error.unauthenticated:Sua sessão terminou. Entre de novo.`,
  FORBIDDEN: () =>
    $localize`:@@error.forbidden:Você não tem permissão para isto. Peça a um master.`,
  NOT_INVITED: () =>
    $localize`:@@error.notInvited:Seu acesso ainda não foi liberado; peça a um master.`,
  CSRF_REJECTED: () =>
    $localize`:@@error.csrf:O pedido foi recusado por segurança. Recarregue a página e tente de novo.`,
  LAST_MASTER: () =>
    $localize`:@@error.lastMaster:Deve restar ao menos um master.`,
  OWNER_PROTECTED: () =>
    $localize`:@@error.ownerProtected:A conta do dono não pode ser rebaixada nem removida.`,
  ALREADY_INVITED: () =>
    $localize`:@@error.alreadyInvited:Este e-mail já foi convidado.`,
  AUTH_UNAVAILABLE: () =>
    $localize`:@@error.authUnavailable:Não consegui confirmar o login com o Google agora. Tente de novo em instantes.`,
  INVALID_CODE: () =>
    $localize`:@@error.invalidCode:Esse código não confere ou já venceu. Confira os 6 dígitos ou peça um novo.`,
  REQUEST_EXPIRED: () =>
    $localize`:@@error.requestExpired:Esta tela ficou aberta tempo demais. Entre com o Google de novo para pedir acesso.`,
  ALREADY_REQUESTED: () =>
    $localize`:@@error.alreadyRequested:Sua solicitação está em análise.`,
  REQUEST_COOLDOWN: () =>
    $localize`:@@error.requestCooldown:Sua solicitação foi recusada há pouco. Tente de novo amanhã.`,
  INTERNAL: () =>
    $localize`:@@error.internal:Algo deu errado do nosso lado. Tente de novo.`,
};

export const errorMessage = (code: UiErrorCode): string => MESSAGES[code]();

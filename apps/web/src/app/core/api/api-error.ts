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

/** The field a 400 names (`details.field` of the API's error envelope), if any. */
export function refusedFieldOf(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse) || err.status !== 400) return null;
  const parsed = apiErrorSchema.safeParse(parseBody(err.error));
  const details = parsed.success ? parsed.data.error.details : null;
  return typeof details === 'object' &&
    details !== null &&
    'field' in details &&
    typeof details.field === 'string'
    ? details.field
    : null;
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
  HOUSE_QUOTA_EXHAUSTED: () =>
    $localize`:@@error.houseQuota:Suas pesquisas com IA de hoje acabaram. Volte amanhã ou conecte a sua própria IA.`,
  AI_CAPACITY_EXHAUSTED: () =>
    $localize`:@@error.aiCapacity:A IA gratuita da aplicação está sem capacidade agora. Tente mais tarde ou conecte a sua própria IA.`,
  PROVIDER_UNAVAILABLE: () =>
    $localize`:@@error.providerUnavailable:O OpenRouter não respondeu agora. Tente de novo em instantes.`,
  MEDIA_NOT_FOUND: () =>
    $localize`:@@error.mediaNotFound:Esta mídia não está mais no acervo ou você não tem acesso a ela.`,
  MEDIA_NOT_READY: () =>
    $localize`:@@error.mediaNotReady:Esta mídia ainda não está pronta para tocar.`,
  PAYLOAD_TOO_LARGE: () =>
    $localize`:@@error.payloadTooLarge:O arquivo é maior do que o permitido. Envie um áudio de até 500 MB.`,
  MEDIA_CONFLICT: () =>
    $localize`:@@error.mediaConflict:Esta mídia mudou enquanto você agia. Atualize a lista e tente de novo.`,
  BOOKMARK_LIMIT: () =>
    $localize`:@@error.bookmarkLimit:Você chegou ao limite de 1.000 marcadores nesta mídia. Apague algum para marcar outro.`,
  VIEW_CHANGED: () =>
    $localize`:@@error.viewChanged:Esta aba estava em outra visão. Recarregando…`,
  NOT_WHILE_ACTING: () =>
    $localize`:@@error.notWhileActing:Isto só a própria pessoa pode fazer.`,
  TOPIC_EXISTS: () =>
    $localize`:@@error.topicExists:Já existe um acervo com esse nome.`,
  CONSENT_REQUIRED: () =>
    $localize`:@@error.consentRequired:Registre o consentimento antes de cadastrar o perfil de voz.`,
  VOICE_LIST_NOT_WRITTEN: () =>
    $localize`:@@error.voiceListNotWritten:O consentimento foi revogado e o perfil foi apagado, mas a lista de revogações não foi gravada. Veja "Perfis de voz".`,
  MEDIA_SPEND_CAP: () =>
    $localize`:@@error.mediaSpendCap:O limite de gasto da mídia foi atingido; a análise não rodou.`,
  EDIT_STALE: () =>
    $localize`:@@error.editStale:Outra pessoa mudou esta edição; recarregue para ver.`,
  EDIT_VERSION_REQUIRED: () =>
    $localize`:@@error.editVersionRequired:Recarregue a página para continuar esta edição.`,
  TRACKS_INVALID: () =>
    $localize`:@@error.tracksInvalid:Há faixas com problema. Corrija e tente de novo.`,
  INTERNAL: () =>
    $localize`:@@error.internal:Algo deu errado do nosso lado. Tente de novo.`,
};

export const errorMessage = (code: UiErrorCode): string => MESSAGES[code]();

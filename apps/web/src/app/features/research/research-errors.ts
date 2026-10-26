import { errorMessage, type UiErrorCode } from '@core/api/api-error.js';

/**
 * Failures of the runner itself, sent as `error` events of the research stream (KBC-007,
 * ADR 0007): the subscription CLIs and a key the provider refused.
 */
const RUNNER_CODES = [
  'CLI_LOGIN_REQUIRED',
  'PROVIDER_UNAVAILABLE',
  'LLM_KEY_REJECTED',
] as const;
type RunnerErrorCode = (typeof RUNNER_CODES)[number];

export type ResearchErrorCode = UiErrorCode | RunnerErrorCode;

/** Codes the agent stream may send that have their own wording; anything else is generic. */
const KNOWN_STREAM_CODES: readonly ResearchErrorCode[] = [
  'DAILY_CAP_REACHED',
  'LLM_INSUFFICIENT_CREDIT',
  'LLM_NOT_CONFIGURED',
  'RATE_LIMITED',
  'HOUSE_QUOTA_EXHAUSTED',
  'AI_CAPACITY_EXHAUSTED',
  ...RUNNER_CODES,
];

/** Refusals of the app's free AI (KBC-022): the reader is offered their own AI. */
export const OWN_AI_OFFER: readonly ResearchErrorCode[] = [
  'HOUSE_QUOTA_EXHAUSTED',
  'AI_CAPACITY_EXHAUSTED',
];

export const toResearchErrorCode = (code: string): ResearchErrorCode =>
  KNOWN_STREAM_CODES.find((value) => value === code) ?? 'INTERNAL';

/** Wording specific to AI answers (screens.md T4) where the generic API message would mislead. */
const AI_MESSAGES: Partial<Record<UiErrorCode, () => string>> = {
  INTERNAL: () => $localize`:@@ai.failed:Não consegui gerar a resposta agora.`,
  RATE_LIMITED: () =>
    $localize`:@@ai.rateLimited:Muitas respostas em pouco tempo. Espere um minuto e tente de novo.`,
};

/** What to do about each runner failure (KBC-007 FR-4). */
const RUNNER_MESSAGES: Record<RunnerErrorCode, () => string> = {
  CLI_LOGIN_REQUIRED: () =>
    $localize`:@@ai.cliLogin:O Claude Code (ou o Codex) deste computador não está logado. Faça o login no terminal (claude e depois /login, ou codex login) e tente de novo.`,
  PROVIDER_UNAVAILABLE: () =>
    $localize`:@@ai.providerUnavailable:O provedor de IA não respondeu agora. Tente de novo em instantes ou troque de provedor em ⚙ Configurações.`,
  LLM_KEY_REJECTED: () =>
    $localize`:@@ai.keyRejected:A chave de API não foi aceita pelo provedor. Confira a chave em ⚙ Configurações.`,
};

const isRunnerCode = (code: ResearchErrorCode): code is RunnerErrorCode =>
  RUNNER_CODES.some((value) => value === code);

export function aiErrorMessage(code: ResearchErrorCode): string {
  if (isRunnerCode(code)) return RUNNER_MESSAGES[code]();
  return AI_MESSAGES[code]?.() ?? errorMessage(code);
}

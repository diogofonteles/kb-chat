import type {
  AiProvider,
  AiTestCode,
  DefaultView,
  ProviderBilling,
  ProviderUnavailableReason,
  Theme,
} from '@kb-chat/contracts';

/**
 * Reasons that block a card (BR-3): a missing key is typed in the card itself, and another
 * person's subscription is never shown (T6).
 */
export type BlockingReason = Exclude<
  ProviderUnavailableReason,
  'key-missing' | 'owner-only'
>;

export interface ProviderCopy {
  readonly name: () => string;
  readonly description: () => string;
  /**
   * What to do, per reason the card is blocked for: install and log in (`cli-missing`), turn
   * it on (`not-enabled`, `house-off`), log in on the server, ask a master (KBC-031).
   */
  readonly steps?: Partial<Record<BlockingReason, () => string>>;
  /** The cost badge when the billing alone would mislead (free tiers, KBC-023). */
  readonly billing?: () => string;
}

const FREE_OR_PAID = () => $localize`:@@billing.freeOrPaid:Gratuito ou por uso`;

export const NOT_INSTALLED = () => $localize`:@@ai.notInstalled:Não instalado.`;
export const NOT_ENABLED = () => $localize`:@@ai.notEnabled:Desativado.`;
export const NOT_LENT = () => $localize`:@@ai.notLent:Não liberada.`;

/** The short label of a blocked card, before its steps (BR-3, KBC-031). */
export const BLOCKED_LABEL: Record<BlockingReason, () => string> = {
  'cli-missing': NOT_INSTALLED,
  'not-enabled': NOT_ENABLED,
  'house-off': NOT_ENABLED,
  'login-required': () => $localize`:@@ai.loginRequired:Sem login no servidor.`,
  'sandbox-unavailable': () =>
    $localize`:@@ai.sandboxUnavailable:Indisponível no servidor.`,
  'app-unavailable': NOT_LENT,
};

/** pt-BR copy of each provider (KBC-007 scope); the API only knows the ids. */
export const PROVIDER_COPY: Record<AiProvider, ProviderCopy> = {
  app: {
    name: () => $localize`:@@provider.app:IA da aplicação`,
    description: () =>
      $localize`:@@provider.appHint:Cedida pelo administrador: você não configura nada e não paga. Tem um limite de pesquisas por dia.`,
    steps: {
      'app-unavailable': () =>
        $localize`:@@provider.appEnable:Nenhuma IA da aplicação foi liberada para você. Peça a um master, ou use a sua própria IA.`,
    },
  },
  'claude-subscription': {
    name: () => $localize`:@@provider.claude:Assinatura do Claude`,
    description: () =>
      $localize`:@@provider.claudeHint:Usa o Claude Code já logado no servidor da Nova Alexandria, com todo o acervo como ferramenta.`,
    steps: {
      'cli-missing': () =>
        $localize`:@@provider.claudeInstall:Instale o Claude Code (claude.ai/code), abra o Terminal, rode claude e faça /login com a sua conta do Claude.`,
    },
  },
  'chatgpt-subscription': {
    name: () => $localize`:@@provider.chatgpt:Assinatura do ChatGPT`,
    description: () =>
      $localize`:@@provider.chatgptHint:Usa a sua assinatura do ChatGPT pelo Codex, rodando no servidor da Nova Alexandria.`,
    steps: {
      // The owner's Mac (ADR 0007): Codex runs there only when he asks for it.
      'cli-missing': () =>
        $localize`:@@provider.chatgptInstall:Instale o Codex CLI (developers.openai.com/codex), rode codex login no Terminal e escolha “Sign in with ChatGPT”.`,
      'not-enabled': () =>
        $localize`:@@provider.chatgptEnable:Por segurança, fica desligado: o Codex CLI pode ler outros arquivos deste computador. Para usar mesmo assim, inicie o servidor com KB_CHAT_CODEX=on.`,
      // The server (ADR 0020): Codex runs in its own container, turned on by a master.
      'house-off': () =>
        $localize`:@@provider.chatgptHouseOff:Ligue em ⚙ Configurações → IA da aplicação → “Ligar a assinatura do ChatGPT (Codex)”.`,
      'login-required': () =>
        $localize`:@@provider.chatgptLogin:Entre no servidor por SSH, rode codex login --device-auth (runbook, passo 9c) e reabra esta tela.`,
      'sandbox-unavailable': () =>
        $localize`:@@provider.chatgptSandbox:O contêiner do Codex não está configurado ou não respondeu: confira se ele está ligado (runbook, passo 9c).`,
    },
  },
  anthropic: {
    name: () => $localize`:@@provider.anthropic:Claude (API da Anthropic)`,
    description: () =>
      $localize`:@@provider.anthropicHint:Claude pela API, com a sua chave.`,
  },
  openrouter: {
    name: () => $localize`:@@provider.openrouter:OpenRouter`,
    description: () =>
      $localize`:@@provider.openrouterHint:Conecte a sua conta em um clique; modelos gratuitos ou pagos.`,
    billing: FREE_OR_PAID,
  },
  gemini: {
    name: () => $localize`:@@provider.gemini:Gemini (Google AI Studio)`,
    description: () =>
      $localize`:@@provider.geminiHint:Gratuito com uma chave do Google AI Studio; há também o plano pago.`,
    billing: FREE_OR_PAID,
  },
  openai: {
    name: () => $localize`:@@provider.openai:OpenAI (API)`,
    description: () =>
      $localize`:@@provider.openaiHint:GPT pela API, com a sua chave.`,
  },
  none: {
    name: () => $localize`:@@provider.none:Nenhum`,
    description: () =>
      $localize`:@@provider.noneHint:Só a busca nos documentos, sem IA.`,
  },
};

/** Display order (KBC-023): the app's AI, the free options, the paid keys, the owner's subscriptions, "none" last. */
export const PROVIDER_ORDER: readonly AiProvider[] = [
  'app',
  'openrouter',
  'gemini',
  'anthropic',
  'openai',
  'claude-subscription',
  'chatgpt-subscription',
  'none',
];

export const BILLING_COPY: Record<ProviderBilling, () => string> = {
  subscription: () =>
    $localize`:@@billing.subscription:Incluído na sua assinatura`,
  'per-token': () =>
    $localize`:@@billing.perToken:Cobra por uso · chave própria`,
  free: () => $localize`:@@billing.free:Gratuito · paga a aplicação`,
  none: () => $localize`:@@billing.none:Sem custo`,
};

export const TEST_COPY: Record<AiTestCode, () => string> = {
  LLM_KEY_REJECTED: () =>
    $localize`:@@aiTest.keyRejected:A chave não foi aceita pelo provedor.`,
  LLM_NOT_CONFIGURED: () =>
    $localize`:@@aiTest.noKey:Informe uma chave para testar.`,
  PROVIDER_TIMEOUT: () =>
    $localize`:@@aiTest.timeout:Sem resposta do provedor em 20 segundos.`,
  PROVIDER_UNAVAILABLE: () =>
    $localize`:@@aiTest.unavailable:O provedor não respondeu agora. Tente de novo em instantes.`,
  CLI_MISSING: () =>
    $localize`:@@aiTest.cliMissing:A ferramenta não foi encontrada no servidor da Nova Alexandria.`,
  CLI_LOGIN_REQUIRED: () =>
    $localize`:@@aiTest.cliLogin:A ferramenta não está logada. No Terminal, rode claude e use /login (ou codex login).`,
};

export const VIEW_COPY: Record<DefaultView, () => string> = {
  research: () => $localize`:@@view.research:Pesquisa com IA`,
  search: () => $localize`:@@view.search:Buscar documentos`,
};

export const THEME_COPY: Record<Theme, () => string> = {
  auto: () => $localize`:@@theme.auto:Automático (claro/escuro)`,
  light: () => $localize`:@@theme.light:Claro`,
  dark: () => $localize`:@@theme.dark:Escuro`,
  esoteric: () => $localize`:@@theme.esoteric:Esotérico`,
};

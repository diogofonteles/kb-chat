import type {
  AiProvider,
  AiTestCode,
  DefaultView,
  ProviderBilling,
  Theme,
} from '@kb-chat/contracts';

export interface ProviderCopy {
  readonly name: () => string;
  readonly description: () => string;
  /** How to install and log in, for a subscription whose CLI is missing (BR-3). */
  readonly install?: () => string;
  /** Why it is off and how to turn it on, for a provider off on this server. */
  readonly enable?: () => string;
  /** The cost badge when the billing alone would mislead (free tiers, KBC-023). */
  readonly billing?: () => string;
}

const FREE_OR_PAID = () => $localize`:@@billing.freeOrPaid:Gratuito ou por uso`;

export const NOT_INSTALLED = () => $localize`:@@ai.notInstalled:Não instalado.`;
export const NOT_ENABLED = () => $localize`:@@ai.notEnabled:Desativado.`;
export const NOT_LENT = () => $localize`:@@ai.notLent:Não liberada.`;

/** pt-BR copy of each provider (KBC-007 scope); the API only knows the ids. */
export const PROVIDER_COPY: Record<AiProvider, ProviderCopy> = {
  app: {
    name: () => $localize`:@@provider.app:IA da aplicação`,
    description: () =>
      $localize`:@@provider.appHint:Cedida pelo administrador: você não configura nada e não paga. Tem um limite de pesquisas por dia.`,
    enable: () =>
      $localize`:@@provider.appEnable:Nenhuma IA da aplicação foi liberada para você. Peça a um master, ou use a sua própria IA.`,
  },
  'claude-subscription': {
    name: () => $localize`:@@provider.claude:Assinatura do Claude`,
    description: () =>
      $localize`:@@provider.claudeHint:Usa o Claude Code já logado no servidor da Nova Alexandria, com todo o acervo como ferramenta.`,
    install: () =>
      $localize`:@@provider.claudeInstall:Instale o Claude Code (claude.ai/code), abra o Terminal, rode claude e faça /login com a sua conta do Claude.`,
  },
  'chatgpt-subscription': {
    name: () => $localize`:@@provider.chatgpt:Assinatura do ChatGPT`,
    description: () =>
      $localize`:@@provider.chatgptHint:Usa o Codex CLI já logado no servidor da Nova Alexandria.`,
    install: () =>
      $localize`:@@provider.chatgptInstall:Instale o Codex CLI (developers.openai.com/codex), rode codex login no Terminal e escolha “Sign in with ChatGPT”.`,
    enable: () =>
      $localize`:@@provider.chatgptEnable:Por segurança, fica desligado: o Codex CLI pode ler outros arquivos deste computador. Para usar mesmo assim, inicie o servidor com KB_CHAT_CODEX=on.`,
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

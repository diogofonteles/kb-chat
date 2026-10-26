import type { AiProvider } from '@kb-chat/contracts';

/** One numbered step of a guide, with an optional link that opens in a new tab. */
export interface GuideStep {
  readonly text: () => string;
  readonly link?: { readonly href: string; readonly label: () => string };
}

/** How to set up one AI, in pt-BR (KBC-023 FR-5): steps, cost, privacy and limits. */
export interface ProviderGuide {
  readonly steps: readonly GuideStep[];
  readonly cost: () => string;
  readonly privacy: () => string;
  readonly limits?: () => string;
  /** What cannot be done (subscriptions, BR-5). */
  readonly note?: () => string;
}

const TEST_STEP: GuideStep = {
  text: () =>
    $localize`:@@guide.test:Use “Testar conexão” e, se der certo, “Salvar” (no assistente, “Continuar”).`,
};

/** The guides of "Sua IA" (screens.md T6); providers without one show only their hint. */
export const PROVIDER_GUIDES: Partial<Record<AiProvider, ProviderGuide>> = {
  app: {
    steps: [
      {
        text: () =>
          $localize`:@@guide.app1:Não precisa configurar nada: o administrador empresta a IA da aplicação.`,
      },
      {
        text: () =>
          $localize`:@@guide.app2:Escolha esta opção e use “Salvar” para voltar a usá-la a qualquer momento.`,
      },
    ],
    cost: () => $localize`:@@guide.appCost:Gratuito para você.`,
    privacy: () =>
      $localize`:@@guide.appPrivacy:As perguntas e os trechos do acervo vão para os modelos gratuitos do OpenRouter escolhidos pela aplicação; alguns podem guardar os dados.`,
    limits: () =>
      $localize`:@@guide.appLimits:Há um limite de pesquisas por dia (Rápido conta 1, Profundo 2, Exaustivo 5).`,
  },
  openrouter: {
    steps: [
      {
        text: () =>
          $localize`:@@guide.or1:Use “Conectar OpenRouter”. Se ainda não tem conta, crie uma no próprio OpenRouter (com Google ou e-mail).`,
      },
      {
        text: () =>
          $localize`:@@guide.or2:Autorize a Nova Alexandria. O OpenRouter cria uma chave só para ela e você volta para cá.`,
      },
      {
        text: () =>
          $localize`:@@guide.or3:Prefere colar uma chave? Crie uma em “Keys” no OpenRouter e cole no campo abaixo.`,
        link: {
          href: 'https://openrouter.ai/settings/keys',
          label: () => $localize`:@@guide.or3Link:Chaves do OpenRouter`,
        },
      },
      {
        text: () =>
          $localize`:@@guide.or4:Deixe “Só modelos gratuitos” para não pagar nada; um modelo pago de reserva é opcional.`,
      },
      TEST_STEP,
    ],
    cost: () =>
      $localize`:@@guide.orCost:Os modelos gratuitos não custam nada. Modelos pagos cobram por uso dos seus créditos no OpenRouter, até o limite de gasto por dia definido aqui.`,
    privacy: () =>
      $localize`:@@guide.orPrivacy:As perguntas e os trechos do acervo vão para o provedor do modelo. Alguns modelos gratuitos guardam os dados para treino; ajuste em “Privacy” no OpenRouter.`,
    limits: () =>
      $localize`:@@guide.orLimits:Sem créditos comprados, são 50 pedidos gratuitos por dia (uma pesquisa usa de 7 a 16); com US$ 10 comprados uma vez, 1000 por dia. Até 20 por minuto.`,
  },
  gemini: {
    steps: [
      {
        text: () =>
          $localize`:@@guide.gm1:Abra o Google AI Studio e entre com a sua conta Google.`,
        link: {
          href: 'https://aistudio.google.com/apikey',
          label: () => $localize`:@@guide.gm1Link:Chaves do Google AI Studio`,
        },
      },
      {
        text: () =>
          $localize`:@@guide.gm2:Use “Create API key” (Criar chave de API) e copie a chave, que começa com AIza.`,
      },
      {
        text: () =>
          $localize`:@@guide.gm3:Cole a chave abaixo e escolha o plano: “Gratuito”, se você não ativou o faturamento no Google Cloud. Com o faturamento ativado, o Google cobra mesmo que você escolha “Gratuito” aqui.`,
      },
      TEST_STEP,
    ],
    cost: () =>
      $localize`:@@guide.gmCost:No plano gratuito não há custo. No pago, o Google cobra por uso (cerca de US$ 0,30 por milhão de tokens de entrada no Flash-Lite), até o limite de gasto por dia definido aqui.`,
    privacy: () =>
      $localize`:@@guide.gmPrivacy:No plano gratuito, o Google pode usar as perguntas e os trechos enviados para melhorar os produtos dele, e pessoas podem revisá-los. Não use o plano gratuito para nada sigiloso.`,
    limits: () =>
      $localize`:@@guide.gmLimits:O plano gratuito tem limites por minuto e por dia que mudam por modelo (veja no AI Studio); passando deles, a resposta avisa e você tenta mais tarde.`,
  },
  anthropic: {
    steps: [
      {
        text: () =>
          $localize`:@@guide.an1:Crie uma conta no console da Anthropic e adicione créditos em “Billing”.`,
        link: {
          href: 'https://console.anthropic.com/settings/keys',
          label: () => $localize`:@@guide.an1Link:Console da Anthropic`,
        },
      },
      {
        text: () =>
          $localize`:@@guide.an2:Em “API keys”, crie uma chave e copie (começa com sk-ant-).`,
      },
      { text: () => $localize`:@@guide.paste:Cole a chave no campo abaixo.` },
      TEST_STEP,
    ],
    cost: () =>
      $localize`:@@guide.anCost:Cobrado por uso dos seus créditos: Sonnet 5.5 a US$ 2 por milhão de tokens de entrada e US$ 10 de saída; Opus 5.5 a US$ 4 e US$ 20. Uma pesquisa rápida costuma custar poucos centavos.`,
    privacy: () =>
      $localize`:@@guide.anPrivacy:Pela API, a Anthropic não usa os dados para treinar modelos, por padrão.`,
    note: () =>
      $localize`:@@guide.anNote:Assinaturas do Claude (Pro, Max) não podem ser conectadas: os termos da Anthropic proíbem o uso delas em produtos de terceiros. Use uma chave de API.`,
  },
  openai: {
    steps: [
      {
        text: () =>
          $localize`:@@guide.oa1:Entre na plataforma da OpenAI e adicione créditos em “Billing”.`,
        link: {
          href: 'https://platform.openai.com/api-keys',
          label: () => $localize`:@@guide.oa1Link:Chaves da OpenAI`,
        },
      },
      {
        text: () =>
          $localize`:@@guide.oa2:Em “API keys”, crie uma chave secreta e copie (começa com sk-).`,
      },
      { text: () => $localize`:@@guide.paste:Cole a chave no campo abaixo.` },
      TEST_STEP,
    ],
    cost: () =>
      $localize`:@@guide.oaCost:Cobrado por uso dos seus créditos: GPT-5.4 mini a US$ 0,75 por milhão de tokens de entrada e US$ 4,50 de saída.`,
    privacy: () =>
      $localize`:@@guide.oaPrivacy:Pela API, a OpenAI não usa os dados para treinar modelos, por padrão.`,
    note: () =>
      $localize`:@@guide.oaNote:Assinaturas do ChatGPT (Plus, Pro) não podem ser conectadas a este app; use uma chave de API.`,
  },
};

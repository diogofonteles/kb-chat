import type { Lendable, LentSubscription } from '@kb-chat/contracts';

/** Whether the owner's subscriptions can be offered here (KBC-024, KBC-027). */
export interface Lending {
  /** The signed-in master is the owner: only he lends his subscriptions. */
  readonly canLend: boolean;
  /** Which of them is ready on the server now. */
  readonly lendable: Lendable;
}

export const NO_LENDING: Lending = {
  canLend: false,
  lendable: { 'claude-subscription': false, 'chatgpt-subscription': false },
};

/** What each lending says before it is confirmed (screens.md T9). */
interface LendCopy {
  /** The terms, named every time. */
  readonly terms: () => string;
  readonly toPerson: () => string;
  readonly toOne: () => string;
  readonly toSelected: (count: number) => string;
  readonly toAll: (count: number) => string;
}

export const LEND_COPY: Record<LentSubscription, LendCopy> = {
  'claude-subscription': {
    terms: () =>
      $localize`:@@lend.terms:Os termos da Anthropic não permitem usar a assinatura do Claude para atender outras pessoas. Ceder é decisão sua e pode levar a limites ou ao bloqueio da sua conta. Quem recebe passa a usar os limites da sua assinatura do Claude, com o próprio limite de pesquisas por dia.`,
    toPerson: () =>
      $localize`:@@lend.titlePerson:Ceder a assinatura do Claude a esta pessoa?`,
    toOne: () =>
      $localize`:@@lend.titleOne:Ceder a assinatura do Claude a 1 pessoa selecionada?`,
    toSelected: (count) =>
      $localize`:@@lend.titleSelected:Ceder a assinatura do Claude a ${count}:count: pessoas selecionadas?`,
    toAll: (count) =>
      $localize`:@@lend.titleAll:Ceder a assinatura do Claude a todas as ${count}:count: pessoas?`,
  },
  'chatgpt-subscription': {
    terms: () =>
      $localize`:@@lendGpt.terms:Os termos da OpenAI não permitem usar a assinatura do ChatGPT para atender outras pessoas. Ceder é decisão sua e pode levar a limites ou ao bloqueio da sua conta. Quem recebe passa a usar os limites da sua assinatura do ChatGPT, com o próprio limite de pesquisas por dia.`,
    toPerson: () =>
      $localize`:@@lendGpt.titlePerson:Ceder a assinatura do ChatGPT a esta pessoa?`,
    toOne: () =>
      $localize`:@@lendGpt.titleOne:Ceder a assinatura do ChatGPT a 1 pessoa selecionada?`,
    toSelected: (count) =>
      $localize`:@@lendGpt.titleSelected:Ceder a assinatura do ChatGPT a ${count}:count: pessoas selecionadas?`,
    toAll: (count) =>
      $localize`:@@lendGpt.titleAll:Ceder a assinatura do ChatGPT a todas as ${count}:count: pessoas?`,
  },
};

export const lendUnavailable = (): string =>
  $localize`:@@lend.unavailable:A assinatura não está disponível agora no servidor; a pessoa segue com a própria IA ou sem IA até lá.`;

export const noDefaultNote = (): string =>
  $localize`:@@lend.noDefault:A assinatura não pode valer para os próximos convidados.`;

/** Whether the owner's subscription can be offered here (KBC-024, ADR 0019). */
export interface Lending {
  /** The signed-in master is the owner: only he lends his subscription. */
  readonly canLend: boolean;
  /** Claude Code is ready on the server now. */
  readonly available: boolean;
}

export const NO_LENDING: Lending = { canLend: false, available: false };

/** The terms named every time before lending (screens.md T9). */
export const lendTerms = (): string =>
  $localize`:@@lend.terms:Os termos da Anthropic não permitem usar a assinatura do Claude para atender outras pessoas. Ceder é decisão sua e pode levar a limites ou ao bloqueio da sua conta. Quem recebe passa a usar os limites da sua assinatura do Claude, com o próprio limite de pesquisas por dia.`;

export const lendUnavailable = (): string =>
  $localize`:@@lend.unavailable:A assinatura não está disponível agora no servidor; a pessoa segue com a própria IA ou sem IA até lá.`;

export const noDefaultNote = (): string =>
  $localize`:@@lend.noDefault:A assinatura não pode valer para os próximos convidados.`;

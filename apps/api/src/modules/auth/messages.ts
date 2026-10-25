import type { CodePurpose } from './one-time-codes.js';

/**
 * The pt-BR texts the product ("Nova Alexandria", KBC-016) sends by email or SMS (KBC-014, ADR 0011), in one place. Plain
 * text: nothing the person typed is ever read as markup.
 */
export interface Text {
  readonly subject: string;
  readonly text: string;
}

const SIGNATURE = '\n\n— Nova Alexandria';

const CODE_SUBJECT: Record<CodePurpose, string> = {
  signup: 'Confirme seu e-mail na Nova Alexandria',
  login: 'Seu código de acesso à Nova Alexandria',
};

const CODE_LEAD: Record<CodePurpose, string> = {
  signup:
    'Use este código para confirmar seu e-mail e enviar sua solicitação de acesso',
  login: 'Use este código para entrar na Nova Alexandria',
};

export const codeEmail = (purpose: CodePurpose, code: string): Text => ({
  subject: CODE_SUBJECT[purpose],
  text: `${CODE_LEAD[purpose]}: ${code}\n\nEle vale por 10 minutos e só pode ser usado uma vez. Se você não pediu, ignore esta mensagem.${SIGNATURE}`,
});

export const codeSms = (code: string): string =>
  `Nova Alexandria: seu código de acesso é ${code}. Vale por 10 minutos.`;

export const alreadyHasAccess = (origin: string): Text => ({
  subject: 'Você já tem acesso à Nova Alexandria',
  text: `Recebemos um pedido de acesso para este e-mail, mas ele já tem acesso. Entre em ${origin} com o Google ou com um código por e-mail.${SIGNATURE}`,
});

export const requestPending = (): Text => ({
  subject: 'Sua solicitação de acesso à Nova Alexandria está em análise',
  text: `Já existe uma solicitação de acesso para este e-mail. Você recebe outro e-mail quando um master aprovar.${SIGNATURE}`,
});

export const requestCooldown = (retryAt: string): Text => ({
  subject: 'Sua solicitação de acesso à Nova Alexandria',
  text: `A última solicitação deste e-mail foi recusada. Você pode pedir de novo a partir de ${formatDateTime(retryAt)} (horário de Brasília).${SIGNATURE}`,
});

export interface RequestSummary {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly source: 'form' | 'google';
}

export const newRequestForMasters = (
  request: RequestSummary,
  origin: string,
): Text => ({
  subject:
    `Nova solicitação de acesso: ${request.firstName} ${request.lastName}`.trim(),
  text: [
    'Alguém pediu acesso à Nova Alexandria:',
    '',
    `Nome: ${`${request.firstName} ${request.lastName}`.trim()}`,
    `E-mail: ${request.email}`,
    `Celular: ${request.phone ?? 'não informado'}`,
    `Origem: ${request.source === 'google' ? 'conta Google' : 'cadastro'}`,
    '',
    `Aprove ou recuse em ${origin}, em Pessoas e permissões.${SIGNATURE}`,
  ].join('\n'),
});

export const approved = (firstName: string, origin: string): Text => ({
  subject: 'Seu acesso à Nova Alexandria foi aprovado',
  text: `Olá${firstName ? `, ${firstName}` : ''}! Seu acesso à Nova Alexandria foi aprovado. Entre em ${origin} com o Google ou com um código enviado para este e-mail.${SIGNATURE}`,
});

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(iso));
}

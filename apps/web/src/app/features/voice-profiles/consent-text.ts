import type {
  VoiceConsentMethod,
  VoiceProfileStatus,
  VoiceRevocationListState,
  VoiceSubject,
} from '@kb-chat/contracts';

/**
 * The consent text on screen, version VOICE_CONSENT_TEXT_VERSION. A change to these words
 * bumps the version, which is kept with each consent.
 */
const LIVING: () => readonly string[] = () => [
  $localize`:@@voiceConsent.livingTitle:Autorização para uso da minha voz`,
  $localize`:@@voiceConsent.livingWhat:Autorizo a Nova Alexandria a criar, a partir de gravações em que eu falo, um perfil da minha voz: uma representação numérica da voz. É um dado biométrico, dado pessoal sensível pela LGPD (art. 5º, II, e art. 11).`,
  $localize`:@@voiceConsent.purpose:Finalidade única: sugerir o nome a quem edita as gravações deste acervo. A sugestão só vira nome quando uma pessoa confirma. O perfil não será usado para outra finalidade, nem em outro acervo.`,
  $localize`:@@voiceConsent.keeping:Guarda: o perfil fica cifrado na infraestrutura do responsável pela Nova Alexandria, não vai para terceiros e dura enquanto esta autorização valer.`,
  $localize`:@@voiceConsent.revoking:Revogação: pode ser pedida a qualquer momento, sem justificativa e sem custo, ao responsável pela Nova Alexandria. O perfil é apagado em até 1 minuto depois de a revogação ser registrada; se o computador que faz a comparação estiver suspenso nesse momento, a cópia temporária na memória dele é apagada assim que ele voltar. Os nomes já confirmados por uma pessoa continuam nas gravações, e este registro fica guardado como prova do consentimento e da revogação.`,
];

const DECEASED: () => readonly string[] = () => [
  $localize`:@@voiceConsent.deceasedTitle:Autorização de quem responde pela obra`,
  $localize`:@@voiceConsent.deceasedWhat:Na qualidade de responsável pela obra da pessoa nomeada abaixo, já falecida, autorizo a Nova Alexandria a criar, a partir de gravações em que ela fala, um perfil da sua voz: uma representação numérica da voz.`,
  $localize`:@@voiceConsent.purpose:Finalidade única: sugerir o nome a quem edita as gravações deste acervo. A sugestão só vira nome quando uma pessoa confirma. O perfil não será usado para outra finalidade, nem em outro acervo.`,
  $localize`:@@voiceConsent.keeping:Guarda: o perfil fica cifrado na infraestrutura do responsável pela Nova Alexandria, não vai para terceiros e dura enquanto esta autorização valer.`,
  $localize`:@@voiceConsent.revoking:Revogação: pode ser pedida a qualquer momento, sem justificativa e sem custo, ao responsável pela Nova Alexandria. O perfil é apagado em até 1 minuto depois de a revogação ser registrada; se o computador que faz a comparação estiver suspenso nesse momento, a cópia temporária na memória dele é apagada assim que ele voltar. Os nomes já confirmados por uma pessoa continuam nas gravações, e este registro fica guardado como prova do consentimento e da revogação.`,
];

export const consentParagraphs = (subject: VoiceSubject): readonly string[] =>
  subject === 'living' ? LIVING() : DECEASED();

export const METHOD_LABELS: Record<VoiceConsentMethod, () => string> = {
  'signed-paper': () =>
    $localize`:@@voiceConsent.signedPaper:Documento assinado em papel`,
  'signed-digital': () =>
    $localize`:@@voiceConsent.signedDigital:Assinatura digital`,
  email: () => $localize`:@@voiceConsent.email:E-mail de quem autorizou`,
};

export const SUBJECT_LABELS: Record<VoiceSubject, () => string> = {
  living: () => $localize`:@@voiceConsent.living:Pessoa viva`,
  deceased: () => $localize`:@@voiceConsent.deceased:Pessoa falecida`,
};

/** What the screen says about the revocation list, and what the owner does (ADR 0032). */
export interface ListNotice {
  readonly what: string;
  readonly step: string;
}

export const LIST_NOTICES: Record<
  Exclude<VoiceRevocationListState, 'ok'>,
  () => ListNotice
> = {
  lost: () => ({
    what: $localize`:@@voiceProfiles.listLost:A lista de revogações se perdeu ou tem uma linha ilegível, então uma revogação antiga pode não valer. Nenhum perfil novo será calculado até o dono conferir. Revogar continua funcionando.`,
    step: $localize`:@@voiceProfiles.listLostStep:Passo do dono: confira se houve revogação depois do backup mais recente, revogue aqui de novo cada uma e marque a lista como conferida (runbook, seção 11).`,
  }),
  exposed: () => ({
    what: $localize`:@@voiceProfiles.listExposed:A lista de revogações pode ter sido alterada: o arquivo não é do usuário da API ou não está fechado. Nada dela foi aplicado, e nenhum perfil novo será calculado até o dono conferir. Revogar continua funcionando.`,
    step: $localize`:@@voiceProfiles.listExposedStep:Passo do dono: confira cada linha da lista, corrija o dono e a permissão do arquivo e reinicie a API (runbook, seção 11).`,
  }),
  behind: () => ({
    what: $localize`:@@voiceProfiles.listBehind:Uma revogação valeu, e o perfil já foi apagado, mas ela não foi gravada na lista de revogações. Restaurar um backup agora poderia trazê-la de volta.`,
    step: $localize`:@@voiceProfiles.listBehindStep:Passo do dono: libere espaço no disco ou corrija a permissão da lista e reinicie a API, que grava o que faltou (runbook, seção 11).`,
  }),
};

export const STATUS_LABELS: Record<VoiceProfileStatus, () => string> = {
  calculating: () => $localize`:@@voiceProfiles.calculating:Calculando`,
  ready: () => $localize`:@@voiceProfiles.ready:Pronto`,
  failed: () => $localize`:@@voiceProfiles.failed:Precisa calcular de novo`,
};

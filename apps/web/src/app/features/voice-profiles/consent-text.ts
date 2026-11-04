import type {
  VoiceConsentMethod,
  VoiceProfileStatus,
  VoiceSubject,
} from '@kb-chat/contracts';

/**
 * The consent text on screen, version VOICE_CONSENT_TEXT_VERSION. A recommended default, not
 * legal advice: it needs human legal review before any real use (ADR 0032). A change to these
 * words bumps the version, which is kept with each consent.
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

export const STATUS_LABELS: Record<VoiceProfileStatus, () => string> = {
  calculating: () => $localize`:@@voiceProfiles.calculating:Calculando`,
  ready: () => $localize`:@@voiceProfiles.ready:Pronto`,
  failed: () => $localize`:@@voiceProfiles.failed:Precisa calcular de novo`,
};

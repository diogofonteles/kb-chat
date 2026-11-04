import type {
  OptionRefusal,
  PreparationStage,
  PreparationStageId,
  PreparationTrack,
  StageFailure,
  StageState,
  TrackPerson,
  TrackRowStatus,
} from '@kb-chat/contracts';

/** The words of T20: the same on every screen (DS-18). */

export const STAGE_NAMES: Record<PreparationStageId, () => string> = {
  upload: () => $localize`:@@prep.stage.upload:Envio`,
  convert: () => $localize`:@@prep.stage.convert:Conversão`,
  transcribe: () => $localize`:@@prep.stage.transcribe:Transcrição`,
  speakers: () => $localize`:@@prep.stage.speakers:Vozes`,
  tracks: () => $localize`:@@prep.stage.tracks:Faixas com IA`,
};

/** Why an option is off, with the way out (BR-3, UP-11). */
export const REFUSAL_TEXTS: Record<OptionRefusal, () => string> = {
  permission: () =>
    $localize`:@@prep.refusal.permission:Você não tem permissão para isto. Peça a um master em Pessoas e permissões.`,
  dependency: () =>
    $localize`:@@prep.refusal.dependency:Depende de uma opção desmarcada acima.`,
  unavailable: () =>
    $localize`:@@prep.refusal.unavailable:Ainda não está disponível nesta versão.`,
  'not-connected': () =>
    $localize`:@@prep.refusal.notConnected:A IA da aplicação não está conectada. Peça a um master em Configurações.`,
  'run-cap': () =>
    $localize`:@@prep.refusal.runCap:Esta gravação passa do teto por análise da mídia.`,
  'monthly-cap': () =>
    $localize`:@@prep.refusal.monthlyCap:O limite mensal da mídia foi atingido.`,
  'no-estimate': () =>
    $localize`:@@prep.refusal.noEstimate:Escolha um arquivo que o navegador consiga ler para ver a estimativa de custo.`,
};

const FAILURES: Record<StageFailure, () => string> = {
  work: () =>
    $localize`:@@prep.failure.work:Falhou: o trabalho não terminou no computador do transcritor.`,
  provider: () =>
    $localize`:@@prep.failure.provider:Falhou: o provedor de IA não respondeu.`,
  'invalid-output': () =>
    $localize`:@@prep.failure.invalidOutput:Falhou: a resposta da IA veio incompleta.`,
  interrupted: () =>
    $localize`:@@prep.failure.interrupted:Falhou: a análise foi interrompida.`,
  'run-cap': () =>
    $localize`:@@prep.failure.runCap:A análise passaria do teto por gravação. As faixas com IA não rodaram.`,
  'monthly-cap': () =>
    $localize`:@@prep.failure.monthlyCap:O limite mensal da mídia foi atingido. As faixas com IA não rodaram.`,
  'no-permission': () =>
    $localize`:@@prep.failure.noPermission:Quem pediu não tem mais permissão para propor faixas com IA. Nada foi cobrado.`,
  'not-connected': () =>
    $localize`:@@prep.failure.notConnected:A IA da aplicação não está conectada. Nada foi cobrado.`,
  'provider-unavailable': () =>
    $localize`:@@prep.failure.unavailable:Não consegui falar com o provedor de IA. Nada foi cobrado.`,
  'estimate-rose': () =>
    $localize`:@@prep.failure.estimateRose:A estimativa subiu depois da transcrição, então a análise não rodou. Nada foi cobrado.`,
};

export const failureText = (failure: StageFailure): string =>
  FAILURES[failure]();

const STATUS_TEXTS: Record<TrackRowStatus, () => string> = {
  proposed: () => $localize`:@@prep.track.proposed:Proposta pela IA`,
  manual: () => $localize`:@@prep.track.manual:Criada por você`,
  approved: () => $localize`:@@prep.track.approved:Aprovada`,
  preparing: () => $localize`:@@prep.track.preparing:Preparando arquivo`,
};

export const trackStatusText = (status: TrackRowStatus): string =>
  STATUS_TEXTS[status]();

/** "3 min 43 s", "1 h 02 min": how long a track lasts. */
export function spanText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0)
    return $localize`:@@prep.span.hours:${hours}:hours: h ${String(minutes).padStart(2, '0')}:minutes: min`;
  if (minutes > 0)
    return $localize`:@@prep.span.minutes:${minutes}:minutes: min ${rest}:seconds: s`;
  return $localize`:@@prep.span.seconds:${rest}:seconds: s`;
}

/** "Pergunta da plateia", "Mestre Gabriel", "Voz 2". */
export function personText(person: TrackPerson): string {
  if (person.audience)
    return $localize`:@@prep.person.audience:Pergunta da plateia`;
  if (person.name) return person.name;
  return $localize`:@@prep.person.voice:Voz ${person.voice ?? 0}:number:`;
}

/** "Pergunta: … · Resposta: …": empty without either. */
export function whoText(track: PreparationTrack): string {
  const asker =
    track.asker &&
    $localize`:@@prep.track.asker:Pergunta: ${personText(track.asker)}:name:`;
  const answerer =
    track.answerer &&
    $localize`:@@prep.track.answerer:Resposta: ${personText(track.answerer)}:name:`;
  return [asker, answerer].filter(Boolean).join(' · ');
}

const percentText = (stage: PreparationStage): string =>
  stage.percent === null ? '' : ` ${stage.percent} %`;

/** How the progress bar reads aloud: "Transcrição: 35 por cento". */
export const progressValueText = (stage: PreparationStage): string =>
  $localize`:@@prep.progress.value:${STAGE_NAMES[stage.stage]()}:name:: ${stage.percent ?? 0}:percent: por cento`;

const runningText = (stage: PreparationStage): string => {
  if (stage.stage === 'transcribe' && stage.cuts)
    return $localize`:@@prep.state.cuts:${percentText(stage)}:percent: (cortes ${stage.cuts.done}:done: de ${stage.cuts.total}:total:)`;
  if (stage.stage === 'transcribe')
    return $localize`:@@prep.state.transcribing:Transcrevendo…`;
  if (stage.stage === 'speakers')
    return $localize`:@@prep.state.separating:Separando as vozes…`;
  if (stage.stage === 'tracks' && stage.windows)
    return $localize`:@@prep.state.windows:Propondo… janela ${stage.windows.done}:done: de ${stage.windows.total}:total:`;
  if (stage.percent !== null)
    return $localize`:@@prep.state.percent:${stage.percent}:percent: %`;
  return $localize`:@@prep.state.running:Em andamento…`;
};

const queuedText = (stage: PreparationStage): string => {
  if (stage.ahead === null || stage.ahead === 0)
    return $localize`:@@prep.state.queued:Na fila`;
  return stage.ahead === 1
    ? $localize`:@@prep.state.aheadOne:Na fila: 1 trabalho antes deste`
    : $localize`:@@prep.state.ahead:Na fila: ${stage.ahead}:count: trabalhos antes deste`;
};

const blockedText = ({ blockedBy }: PreparationStage): string =>
  blockedBy
    ? $localize`:@@prep.state.blocked:Esperando: ${STAGE_NAMES[blockedBy]()}:stage: não terminou`
    : $localize`:@@prep.state.waitingAlone:Esperando`;

const waitingText = (before: PreparationStage | null): string =>
  before
    ? $localize`:@@prep.state.waiting:Esperando: ${STAGE_NAMES[before.stage]()}:stage:`
    : $localize`:@@prep.state.waitingAlone:Esperando`;

/** The state of a stage in words: never by colour alone (UP-20). */
const STATE_TEXTS: Record<
  StageState,
  (stage: PreparationStage, before: PreparationStage | null) => string
> = {
  waiting: (_stage, before) => waitingText(before),
  queued: queuedText,
  running: runningText,
  done: () => $localize`:@@prep.state.done:Feito`,
  failed: (stage) => failureText(stage.failure ?? 'work'),
  blocked: blockedText,
};

export const stageStateText = (
  stage: PreparationStage,
  before: PreparationStage | null,
): string => STATE_TEXTS[stage.state](stage, before);

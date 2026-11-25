import type {
  DocumentUpload,
  DocumentUploadFailure,
  DocumentUploadState,
} from '@kb-chat/contracts';
import type { Tone } from '@ui/pill.js';

export interface StateLabel {
  readonly text: () => string;
  readonly tone: Tone;
}

/** Each state in words, with its tone (a word always, never only a colour, MA rules). */
const STATE_LABELS: Record<DocumentUploadState, StateLabel> = {
  receiving: {
    text: () => $localize`:@@docUploads.state.receiving:Enviando`,
    tone: 'info',
  },
  received: {
    text: () => $localize`:@@docUploads.state.received:Recebido`,
    tone: 'muted',
  },
  converting: {
    text: () => $localize`:@@docUploads.state.converting:Convertendo`,
    tone: 'info',
  },
  transcribing: {
    text: () => $localize`:@@docUploads.state.transcribing:Transcrevendo`,
    tone: 'info',
  },
  choosing: {
    text: () => $localize`:@@docUploads.state.choosing:Escolha o que entra`,
    tone: 'warn',
  },
  classifying: {
    text: () => $localize`:@@docUploads.state.classifying:Classificando`,
    tone: 'info',
  },
  mapping: {
    text: () => $localize`:@@docUploads.state.mapping:Entrando no mapa`,
    tone: 'info',
  },
  mapped: {
    text: () => $localize`:@@docUploads.state.mapped:No mapa`,
    tone: 'info',
  },
  ready: {
    text: () => $localize`:@@docUploads.state.ready:Pronto`,
    tone: 'ok',
  },
  failed: {
    text: () => $localize`:@@docUploads.state.failed:Falhou`,
    tone: 'err',
  },
};

/** Why it did not enter, and what to do (PD-15). */
const FAILURE_TEXTS: Record<DocumentUploadFailure, () => string> = {
  'conversion-failed': () =>
    $localize`:@@docUploads.failure.conversion:Não consegui converter. Confira se o arquivo abre ou se o link está no ar, e envie de novo.`,
  live: () =>
    $localize`:@@docUploads.failure.live:É uma transmissão ao vivo. Envie o link depois que ela terminar.`,
  'too-large': () =>
    $localize`:@@docUploads.failure.tooLarge:A gravação passa de 2 GB. Envie só o áudio dela.`,
  empty: () =>
    $localize`:@@docUploads.failure.empty:A conversão saiu vazia ou ilegível. Um escaneado muito apagado? Tente um arquivo melhor.`,
  'not-accepted': () =>
    $localize`:@@docUploads.failure.notAccepted:O kb deixou este documento de fora do acervo. Tente de novo para ver o que foi lido e decidir.`,
  'not-allowed': () =>
    $localize`:@@docUploads.failure.notAllowed:A gravação passa da cota de envio de quem a incluiu, ou essa pessoa não pode mais enviar para este acervo. Fale com um master.`,
  'gave-up': () =>
    $localize`:@@docUploads.failure.gaveUp:O Mac tentou três vezes e desistiu. Envie de novo mais tarde.`,
  'upload-abandoned': () =>
    $localize`:@@docUploads.failure.abandoned:O envio parou no meio e expirou. Envie de novo.`,
};

/** Why kb left it out, in the person's words; kb's own reasons (`triage_reason`). */
const REFUSED_TEXTS: Readonly<Record<string, () => string>> = {
  thin: () =>
    $localize`:@@docUploads.refused.thin:Quase não há texto aqui. Costuma ser a tela de entrada do site, ou só imagens e menus.`,
  paywall: () =>
    $localize`:@@docUploads.refused.paywall:O texto está atrás de um login ou de uma assinatura.`,
  off_topic: () =>
    $localize`:@@docUploads.refused.offTopic:Não parece ser sobre este acervo.`,
  duplicate: () =>
    $localize`:@@docUploads.refused.duplicate:É o mesmo texto de outro documento do acervo.`,
};

/** Why it did not enter, for this item: what was refused says kb's reason and who decides. */
export function failureTextOf({
  failure,
  kind,
  refused,
}: DocumentUpload): string {
  if (failure === null) return '';
  if (failure === 'empty' && kind === 'list')
    return $localize`:@@docUploads.failure.emptyList:Não há gravações nesta lista.`;
  if (!refused) return FAILURE_TEXTS[failure]();
  if (refused.accepted)
    return $localize`:@@docUploads.refused.accepted:Um master o incluiu mesmo assim, mas o Mac não conseguiu colocá-lo no acervo.`;
  const why =
    REFUSED_TEXTS[refused.why]?.() ??
    $localize`:@@docUploads.refused.other:O kb não o reconheceu como conteúdo deste acervo.`;
  const who = refused.acceptable
    ? $localize`:@@docUploads.refused.you:Ficou de fora até você decidir.`
    : $localize`:@@docUploads.refused.master:Ficou de fora até um master decidir.`;
  return `${why} ${who}`;
}

/**
 * It will not change by itself: nothing more to poll for. What waits for a master's decision
 * may, for who sent it.
 */
export const isSettled = ({ state, refused }: DocumentUpload): boolean =>
  state === 'ready' ||
  state === 'choosing' ||
  (state === 'failed' && (refused === null || refused.acceptable));

/** The Mac has it, or its bytes are arriving: it cannot be taken out now. */
export const isWorking = (state: DocumentUploadState): boolean =>
  state === 'converting' || state === 'classifying' || state === 'mapping';

const DOWNLOADING: StateLabel = {
  text: () => $localize`:@@docUploads.state.downloading:Baixando`,
  tone: 'info',
};
const LISTING: StateLabel = {
  text: () => $localize`:@@docUploads.state.listing:Lendo a lista`,
  tone: 'info',
};
const YOURS: StateLabel = {
  text: () => $localize`:@@docUploads.state.yours:Espera você`,
  tone: 'warn',
};

const STALLED: StateLabel = {
  text: () => $localize`:@@docUploads.state.stalled:Parado`,
  tone: 'warn',
};

/** Its state in words: what the Mac does depends on what it is. */
export function labelOf(upload: DocumentUpload): StateLabel {
  const { kind, state, progress } = upload;
  if (upload.refused?.acceptable && !upload.refused.accepted) return YOURS;
  if (progress.stalledSince !== null) return STALLED;
  if (state === 'converting' && kind === 'recording') return DOWNLOADING;
  if (state === 'converting' && kind === 'list') return LISTING;
  if (state === 'transcribing' && progress.media?.step === 'publishing')
    return STATE_LABELS.classifying;
  if (state === 'transcribing' && progress.media?.step === 'attention')
    return YOURS;
  return STATE_LABELS[state];
}

/** "No mapa" waits for the next sync to the app; the rest waits for the Mac. */
const WAITING_HINTS: Partial<Record<DocumentUploadState, () => string>> = {
  mapped: () =>
    $localize`:@@docUploads.hint.mapped:Chega à busca com a próxima sincronização do acervo.`,
  receiving: () =>
    $localize`:@@docUploads.hint.receiving:Se o envio parou, inclua o mesmo arquivo de novo: ele continua de onde estava.`,
};

/** What the person should know of it now: kb's own review first, else what it waits for. */
export const hintOf = (upload: DocumentUpload): string =>
  upload.review
    ? $localize`:@@docUploads.hint.review:Está no acervo. O kb o deixou na fila de revisão do dono.`
    : (WAITING_HINTS[upload.state]?.() ?? '');

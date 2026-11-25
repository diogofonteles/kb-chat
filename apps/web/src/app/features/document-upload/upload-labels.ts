import type {
  DocumentUploadFailure,
  DocumentUploadState,
} from '@kb-chat/contracts';
import type { Tone } from '@ui/pill.js';

/** Each state in words, with its tone (a word always, never only a colour, MA rules). */
export const STATE_LABELS: Record<
  DocumentUploadState,
  { readonly text: () => string; readonly tone: Tone }
> = {
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
export const FAILURE_TEXTS: Record<DocumentUploadFailure, () => string> = {
  'conversion-failed': () =>
    $localize`:@@docUploads.failure.conversion:Não consegui converter. Confira se o arquivo abre ou se o link está no ar, e envie de novo.`,
  empty: () =>
    $localize`:@@docUploads.failure.empty:A conversão saiu vazia ou ilegível. Um escaneado muito apagado? Tente um arquivo melhor.`,
  'not-accepted': () =>
    $localize`:@@docUploads.failure.notAccepted:O kb não aceitou o documento no acervo; ele ficou para revisão do dono.`,
  'gave-up': () =>
    $localize`:@@docUploads.failure.gaveUp:O Mac tentou três vezes e desistiu. Envie de novo mais tarde.`,
  'upload-abandoned': () =>
    $localize`:@@docUploads.failure.abandoned:O envio parou no meio e expirou. Envie de novo.`,
};

/** States that will not change by themselves: nothing more to poll for. */
export const isSettled = (state: DocumentUploadState): boolean =>
  state === 'ready' || state === 'failed';

/** "No mapa" waits for the next sync to the app; the rest waits for the Mac. */
export const WAITING_HINTS: Partial<Record<DocumentUploadState, () => string>> =
  {
    received: () =>
      $localize`:@@docUploads.hint.received:Na vez do Mac: ele liga sozinho quando há trabalho.`,
    mapped: () =>
      $localize`:@@docUploads.hint.mapped:Chega à busca com a próxima sincronização do acervo.`,
    receiving: () =>
      $localize`:@@docUploads.hint.receiving:O envio continua de onde parou se você abrir a janela de envio de novo.`,
  };

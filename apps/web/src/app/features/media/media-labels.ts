import { formatDate } from '@angular/common';
import type {
  MediaFailure,
  MediaItem,
  MediaStatus,
  MediaTranscription,
  TranscriberPresence,
  TranscriptionStatus,
} from '@kb-chat/contracts';

/** Why an item failed, in plain words (MA-25): after "Falhou: ". */
export const FAILURE_LABELS: Record<MediaFailure, () => string> = {
  'invalid-audio': () =>
    $localize`:@@media.failure.invalid:o arquivo não é um áudio válido`,
  'conversion-failed': () =>
    $localize`:@@media.failure.conversion:a conversão falhou várias vezes`,
  'too-many-attempts': () =>
    $localize`:@@media.failure.attempts:a conversão parou várias vezes`,
  'upload-abandoned': () =>
    $localize`:@@media.failure.abandoned:o envio não terminou`,
};

const STATUS_LABELS: Record<MediaStatus, (item: MediaItem) => string> = {
  uploading: () => $localize`:@@media.status.uploading:Enviando…`,
  queued: () => $localize`:@@media.status.queued:Na fila`,
  processing: (item) =>
    item.progress === null
      ? $localize`:@@media.status.processing:Convertendo…`
      : $localize`:@@media.status.processingPercent:Convertendo… ${item.progress}:percent:%`,
  ready: () => $localize`:@@media.status.ready:Pronta`,
  failed: (item) =>
    $localize`:@@media.status.failed:Falhou: ${item.failure ? FAILURE_LABELS[item.failure]() : ''}:reason:`,
};

/** The status of an item in words, never by color alone (UP-20). */
export const statusTextOf = (item: MediaItem): string =>
  STATUS_LABELS[item.status](item);

/**
 * Items the server is working on (queued or converting): the list and the player page ask
 * again until they settle. An upload in progress is not polled: its own panel reports it,
 * and another person's half-sent file would keep every open page polling for a day.
 */
export const isInFlight = (item: MediaItem): boolean =>
  item.status === 'queued' ||
  item.status === 'processing' ||
  isTranscribing(item.transcription);

/**
 * A transcription that will move soon: running, or waiting while a transcriber is on. One
 * waiting for a Mac that is off is not polled: nothing changes until it comes back.
 */
const isTranscribing = (transcription: MediaTranscription): boolean =>
  transcription.status === 'transcribing' ||
  (transcription.status === 'waiting' && transcription.transcriber === 'on');

/** "03/11 às 14:05": when the transcriber was last seen, in the person's locale. */
const seenAt = (iso: string): string =>
  formatDate(
    iso,
    $localize`:@@media.transcription.offDateFormat:dd/MM 'às' HH:mm`,
    'pt-BR',
  );

/** Why the transcription waits, after "Aguardando o transcritor" (FR-1). */
const WAITING_REASONS: Record<
  TranscriberPresence,
  (transcription: MediaTranscription) => string
> = {
  on: () => '',
  off: (transcription) =>
    transcription.transcriberOffSince
      ? $localize`:@@media.transcription.offSince: · desligado desde ${seenAt(transcription.transcriberOffSince)}:date:`
      : '',
  none: () =>
    $localize`:@@media.transcription.noTranscriber: · nenhum transcritor pareado`,
};

const TRANSCRIPTION_LABELS: Record<
  TranscriptionStatus,
  (transcription: MediaTranscription) => string
> = {
  none: () => '',
  waiting: (transcription) =>
    $localize`:@@media.transcription.waiting:Aguardando o transcritor` +
    WAITING_REASONS[transcription.transcriber](transcription),
  transcribing: () =>
    $localize`:@@media.transcription.transcribing:Transcrevendo…`,
  done: (transcription) =>
    transcription.confidence === 'low'
      ? LOW_CONFIDENCE()
      : $localize`:@@media.transcription.done:Transcrita`,
  failed: () => $localize`:@@media.transcription.failed:A transcrição falhou`,
};

/** BR-5: every place that shows a low-confidence transcript says so. */
export const LOW_CONFIDENCE = (): string =>
  $localize`:@@media.transcription.low:Transcrição automática de baixa confiança`;

/** Where the transcription is, in words (UP-20); '' when there is nothing to say yet. */
export const transcriptionTextOf = (item: MediaItem): string =>
  item.status === 'ready'
    ? TRANSCRIPTION_LABELS[item.transcription.status](item.transcription)
    : '';

/** The current transcript is of low confidence (BR-5). */
export const isLowConfidence = (item: MediaItem): boolean =>
  item.transcription.confidence === 'low';

/**
 * The low-confidence notice while the row says something else (a new transcription waiting
 * or running): the current transcript is still the low one (BR-5).
 */
export const lowNoticeOf = (item: MediaItem): string =>
  item.status === 'ready' &&
  isLowConfidence(item) &&
  item.transcription.status !== 'done'
    ? LOW_CONFIDENCE()
    : '';

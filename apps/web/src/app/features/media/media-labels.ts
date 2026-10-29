import type { MediaFailure, MediaItem, MediaStatus } from '@kb-chat/contracts';

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
  item.status === 'queued' || item.status === 'processing';

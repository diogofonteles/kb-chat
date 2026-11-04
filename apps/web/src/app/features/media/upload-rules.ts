import type { AbstractControl } from '@angular/forms';
import {
  MEDIA_MAX_UPLOAD_BYTES,
  hasAcceptedAudioExtension,
} from '@kb-chat/contracts';

/** The rule shown before the choice (MA-20). */
export const uploadRule = (): string =>
  $localize`:@@media.upload.rule:mp3, m4a, wav, flac, ogg ou opus, até 4 GB cada`;

/** Megabytes with a decimal below 10 MB ("2,9 MB"), whole above ("128 MB"). */
const megabytes = (bytes: number): string => {
  const mb = bytes / 1024 / 1024;
  return new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: mb < 10 ? 1 : 0,
  }).format(mb);
};

/** Gigabytes with one decimal ("4,1"). */
const gigabytes = (bytes: number): string =>
  new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(
    bytes / 1024 ** 3,
  );

/** Rounded up: a file over the limit never reads as the limit. */
const gigabytesAbove = (bytes: number): string =>
  new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: 1,
    roundingMode: 'ceil',
  }).format(bytes / 1024 ** 3);

/** One decimal of a GB is about 100 MB: below half of that, it would read as "0 GB". */
const SMALLEST_IN_GB = 0.05 * 1024 ** 3;

const quotaText = (bytes: number): string =>
  bytes < SMALLEST_IN_GB ? `${megabytes(bytes)} MB` : `${gigabytes(bytes)} GB`;

/** The wall a person hit, in their own numbers (KBC-035 AC-3). */
export const overQuota = (quotaBytes: number): string =>
  $localize`:@@media.upload.overQuota:Este envio passa da sua cota de ${quotaText(quotaBytes)}:quota:. Fale com um master para aumentar.`;

/** A file that moved or changed after it was chosen (MA-25). */
export const unreadableFile = (): string =>
  $localize`:@@media.upload.unreadable:Não foi possível ler este arquivo. Tire-o da lista e escolha de novo.`;

/** Why a chosen file cannot be sent, with the fix (MA-25); null when it can. */
export function fileProblemOf(
  file: Pick<File, 'name' | 'size'>,
): string | null {
  if (!hasAcceptedAudioExtension(file.name))
    return $localize`:@@media.upload.badType:Este arquivo não é um áudio aceito. Envie mp3, m4a, wav, flac, ogg ou opus.`;
  if (file.size > MEDIA_MAX_UPLOAD_BYTES)
    return $localize`:@@media.upload.tooLarge:Este arquivo tem ${gigabytesAbove(file.size)}:size: GB. O limite é 4 GB.`;
  if (file.size === 0)
    return $localize`:@@media.upload.empty:Este arquivo está vazio. Escolha outro.`;
  return null;
}

/** The title suggested from the file name (MA-15): no extension, no underscores. */
export function titleFromFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** "128 de 312 MB" while sending. */
export const sentOf = (loaded: number, total: number): string =>
  $localize`:@@media.upload.sent:${megabytes(loaded)}:loaded: de ${megabytes(total)}:total: MB`;

/** A title is required, and spaces alone are not one (the API trims it too). */
export const notBlank = (control: AbstractControl<string>) =>
  control.value.trim() ? null : { required: true };

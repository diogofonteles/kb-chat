import {
  MEDIA_MAX_UPLOAD_BYTES,
  hasAcceptedAudioExtension,
} from '@kb-chat/contracts';

/** The rule shown before the choice (MA-20). */
export const uploadRule = (): string =>
  $localize`:@@media.upload.rule:mp3, m4a, wav, flac, ogg ou opus, até 500 MB`;

/** Megabytes with a decimal below 10 MB ("2,9 MB"), whole above ("128 MB"). */
const megabytes = (bytes: number): string => {
  const mb = bytes / 1024 / 1024;
  return new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: mb < 10 ? 1 : 0,
  }).format(mb);
};

/** Why a chosen file cannot be sent, with the fix (MA-25); null when it can. */
export function fileProblemOf(
  file: Pick<File, 'name' | 'size'>,
): string | null {
  if (!hasAcceptedAudioExtension(file.name))
    return $localize`:@@media.upload.badType:Este arquivo não é um áudio aceito. Envie mp3, m4a, wav, flac, ogg ou opus.`;
  if (file.size > MEDIA_MAX_UPLOAD_BYTES)
    return $localize`:@@media.upload.tooLarge:Este arquivo tem ${megabytes(file.size)}:size: MB. O limite é 500 MB.`;
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

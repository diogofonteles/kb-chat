import {
  DOCUMENT_UPLOAD_EXTENSIONS,
  DOCUMENT_UPLOAD_MAX_BYTES,
  hasDocumentExtension,
} from '@kb-chat/contracts';

/** A chosen file, and why it cannot go ('' when it can). */
export interface ChosenFile {
  readonly key: number;
  readonly file: File;
  readonly problem: string;
}

export const DOCUMENT_ACCEPT = DOCUMENT_UPLOAD_EXTENSIONS.map(
  (one) => `.${one}`,
).join(',');
const MAX_MB = Math.round(DOCUMENT_UPLOAD_MAX_BYTES / 1024 ** 2);

export function fileProblem(file: File): string {
  if (!hasDocumentExtension(file.name))
    return $localize`:@@addContent.badType:Este tipo não é um documento. Áudio vai em "Áudio e vídeo".`;
  if (file.size > DOCUMENT_UPLOAD_MAX_BYTES)
    return $localize`:@@addContent.tooBig:O arquivo passa de ${MAX_MB}:max: MB.`;
  if (file.size === 0)
    return $localize`:@@addContent.empty:O arquivo está vazio.`;
  return '';
}

import {
  DOCUMENT_UPLOAD_EXTENSIONS,
  DOCUMENT_UPLOAD_MAX_BYTES,
  MEDIA_UPLOAD_EXTENSIONS,
  MEDIA_VIDEO_EXTENSIONS,
  hasDocumentExtension,
} from '@kb-chat/contracts';
import { fileProblemOf } from '@features/media/upload-rules.js';

/** What a chosen file becomes: a document, a recording (a video's sound), or nothing. */
export type FileRole = 'document' | 'audio' | 'video' | 'refused' | 'ignored';

/** A chosen file, where it was in its folder, and why it does not go ('' when it does). */
export interface ChosenFile {
  readonly key: number;
  readonly file: File;
  /** `Pasta/sub/arquivo.pdf`, or the file's name when it was chosen alone. */
  readonly path: string;
  readonly role: FileRole;
  readonly problem: string;
}

export const FILE_ACCEPT = [
  ...DOCUMENT_UPLOAD_EXTENSIONS,
  ...MEDIA_UPLOAD_EXTENSIONS,
  ...MEDIA_VIDEO_EXTENSIONS,
]
  .map((one) => `.${one}`)
  .join(',');
const MAX_MB = Math.round(DOCUMENT_UPLOAD_MAX_BYTES / 1024 ** 2);

/** What an operating system or an office program leaves in a folder: never content. */
const isSystemFile = (name: string): boolean =>
  name.startsWith('.') ||
  name.startsWith('~$') ||
  /^(thumbs\.db|desktop\.ini)$/i.test(name);

const extensionOf = (name: string): string =>
  name.slice(name.lastIndexOf('.') + 1).toLowerCase();

const isAudio = (name: string): boolean =>
  (MEDIA_UPLOAD_EXTENSIONS as readonly string[]).includes(extensionOf(name));
const isVideo = (name: string): boolean =>
  (MEDIA_VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(name));
/** An image is described by a vision model: it costs a little more than a text. */
export const isImage = (name: string): boolean =>
  /\.(png|jpe?g|tiff?|webp)$/i.test(name);

function documentProblem(file: File): string {
  if (file.size > DOCUMENT_UPLOAD_MAX_BYTES)
    return $localize`:@@addContent.tooBig:O arquivo passa de ${MAX_MB}:max: MB.`;
  return file.size === 0
    ? $localize`:@@addContent.empty:O arquivo está vazio.`
    : '';
}

/** What the file becomes. Nothing is left out in silence: what does not go says why. */
export function sortFile(file: File): Pick<ChosenFile, 'role' | 'problem'> {
  if (isSystemFile(file.name))
    return {
      role: 'ignored',
      problem: $localize`:@@addContent.systemFile:Arquivo do sistema.`,
    };
  if (hasDocumentExtension(file.name)) {
    const problem = documentProblem(file);
    return { role: problem ? 'refused' : 'document', problem };
  }
  if (isAudio(file.name) || isVideo(file.name)) {
    const problem = fileProblemOf(file) ?? '';
    const role = isVideo(file.name) ? 'video' : 'audio';
    return { role: problem ? 'refused' : role, problem };
  }
  return {
    role: 'refused',
    problem: $localize`:@@addContent.badType:Este tipo de arquivo não entra no acervo.`,
  };
}

export interface PickedFile {
  readonly file: File;
  readonly path: string;
}

/** The files of an `<input type="file">`, a folder's with their place in it. */
export const pickedOf = (list: FileList | null): PickedFile[] =>
  [...(list ?? [])].map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));

/** Every file under a dropped entry, folders inside folders included. */
async function walk(entry: FileSystemEntry, at: string): Promise<PickedFile[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [{ file, path: `${at}${file.name}` }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const found: PickedFile[] = [];
  // A reading answers a part of the folder at a time, and nothing once it is over.
  for (;;) {
    const part = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (part.length === 0) return found;
    for (const one of part)
      found.push(...(await walk(one, `${at}${entry.name}/`)));
  }
}

/** What was dropped: files and whole folders. Call it inside the drop event. */
export async function droppedFiles(data: DataTransfer): Promise<PickedFile[]> {
  // Read before the first wait: the list is empty once the event is over.
  const entries = [...data.items].map((one) => one.webkitGetAsEntry());
  if (entries.every((one) => one === null)) return pickedOf(data.files);
  const found = await Promise.all(
    entries.flatMap((one) => (one ? [walk(one, '')] : [])),
  );
  return found.flat();
}

/** Whether this browser can choose a folder (an iPhone's older ones cannot). */
export const canPickFolder = (): boolean =>
  'webkitdirectory' in document.createElement('input');

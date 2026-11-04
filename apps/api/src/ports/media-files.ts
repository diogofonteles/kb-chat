import type { Readable } from 'node:stream';

/** Why an upload was refused while it streamed in. */
export type UploadProblem = 'too-large' | 'incomplete';

export class UploadRefusedError extends Error {
  constructor(readonly problem: UploadProblem) {
    super(`upload refused: ${problem}`);
    this.name = 'UploadRefusedError';
  }
}

/** A file the API serves, with what HTTP needs to answer Range and If-Range. */
export interface StoredFile {
  readonly size: number;
  readonly modifiedMs: number;
}

/**
 * The media files on disk (ADR 0022): uploads waiting for the worker and the converted
 * renditions. Paths are relative to the media directory and never leave it.
 */
export interface MediaFilesPort {
  /** Where a media item's upload is kept until the worker converts it. */
  uploadPath(mediaId: string): string;
  /** Where its audio rendition goes. */
  audioPath(mediaId: string): string;
  /**
   * Where one lease writes its output: never the final path, so a worker that lost its
   * lease cannot overwrite (or, cleaning up, delete) another worker's result.
   */
  workPath(mediaId: string, leaseId: string): string;
  /** Where a cut waits, and then stays: a new cut of a track never overwrites the file in use. */
  trackPath(mediaId: string, leaseId: string): string;
  /** Where the 16 kHz mono FLAC for the transcriber waits (ADR 0022 §4). */
  flacPath(mediaId: string): string;
  /** Where one lease of the conversion writes that FLAC. */
  flacWorkPath(mediaId: string, leaseId: string): string;
  /** Where one transcript's raw JSON is kept (ADR 0023 §4: next to the database). */
  transcriptPath(mediaId: string, transcriptId: string): string;
  /** Where one voice separation's raw JSON is kept, beside the item's transcripts. */
  diarizationPath(mediaId: string, diarizationId: string): string;
  /** Writes a whole file atomically (temp file and rename), creating its folder. */
  writeFile(path: string, data: string): Promise<void>;
  /** Removes every raw transcript and separation of an item (the item is being removed). */
  removeTranscripts(mediaId: string): Promise<void>;
  /** Moves a finished work file to its final path (atomic rename). */
  promote(from: string, to: string): Promise<void>;
  /**
   * Writes the upload, refusing more or fewer bytes than announced (the partial file is
   * removed); it appears under `uploadPath` only when complete.
   */
  saveUpload(input: {
    readonly mediaId: string;
    readonly body: Readable;
    readonly expectedBytes: number;
  }): Promise<void>;
  /** Removes an upload, complete or partial (removal, abandonment, after conversion). */
  discardUpload(mediaId: string): Promise<void>;
  stat(path: string): Promise<StoredFile | null>;
  /** A stream of the bytes `start..end` (inclusive) of a stored file. */
  read(
    path: string,
    range: { readonly start: number; readonly end: number },
  ): Readable;
  /** Removes the files; a missing one is not an error. */
  remove(paths: readonly string[]): Promise<void>;
  /** Fails when the directory cannot be written (fail fast at start). */
  assertWritable(): Promise<void>;
}

import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type {
  CompleteTranscribeRequest,
  TranscriptionTerms,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type { LeaseOwner, MediaStorePort } from '../../ports/media-store.js';
import type {
  JobLease,
  NewTranscript,
  TranscriptStorePort,
} from '../../ports/transcript-store.js';
import { assertPlausible } from './transcript-bounds.js';
import { CONFIDENCE_VERSION, confidenceOf } from './transcript-confidence.js';
import { FILTER_VERSION, deriveTranscript } from './transcript-filter.js';
import type { PlayableFile } from './media-service.js';

export interface TranscriptionServiceDeps {
  readonly store: MediaStorePort;
  readonly transcripts: TranscriptStorePort;
  readonly files: MediaFilesPort;
  readonly now?: () => Date;
}

const FLAC_MIME = 'audio/flac';

const notYours = () => new AppError('NOT_FOUND', 'No such job for this worker');
const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

/** How a transcript was made: the worker's model, parameters, terms and VAD. */
const provenanceOf = (done: CompleteTranscribeRequest) => ({
  provider: done.provider,
  model: done.model,
  parameters: JSON.stringify(done.parameters),
  parametersVersion: done.parametersVersion,
  termsVersion: done.termsVersion,
  vad: done.vad,
  speechRatio: done.speechRatio,
  elapsedMs: done.elapsedMs,
});

/** The raw result as stored: everything the worker sent but its lease (ADR 0023 §4). */
function rawFileOf(done: CompleteTranscribeRequest): string {
  return JSON.stringify({
    provider: done.provider,
    model: done.model,
    parametersVersion: done.parametersVersion,
    parameters: done.parameters,
    termsVersion: done.termsVersion,
    vad: done.vad,
    speechRatio: done.speechRatio,
    elapsedMs: done.elapsedMs,
    raw: done.raw,
  });
}

/**
 * The transcriber's side of a transcribe job (ADR 0023): the term list, the job's audio
 * and the raw result, which the API keeps and derives (segments, words, filter, confidence).
 */
export class TranscriptionService {
  private readonly now: () => Date;

  constructor(private readonly deps: TranscriptionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  terms(): TranscriptionTerms {
    return this.deps.transcripts.currentTerms();
  }

  /**
   * The audio of a transcription or voice separation this worker holds (BR-2): the 16 kHz
   * FLAC, or the audio rendition when there is none (a separation usually comes after the
   * FLAC went, ADR 0022 §4). Any other job is 404, not even confirmed to exist.
   */
  async audio(owner: LeaseOwner): Promise<PlayableFile> {
    const job = this.heldSpeechJob(owner);
    if (!job) throw notYours();
    return this.audioOf(job.mediaId);
  }

  /**
   * One of the recordings a `voice-profile` job uses (KBC-071 FR-2): `usesMedia` says whether
   * the lease covers it.
   */
  async sourceAudio(input: {
    readonly mediaId: string;
    readonly usesMedia: boolean;
  }): Promise<PlayableFile> {
    if (!input.usesMedia) throw notYours();
    return this.audioOf(input.mediaId);
  }

  private async audioOf(mediaId: string): Promise<PlayableFile> {
    const { files, store } = this.deps;
    const flac = await files.stat(files.flacPath(mediaId));
    if (flac)
      return { path: files.flacPath(mediaId), mime: FLAC_MIME, ...flac };
    const rendition = store.getRendition(mediaId);
    const file = rendition ? await files.stat(rendition.path) : null;
    if (!rendition || !file) throw notYours();
    return { path: rendition.path, mime: rendition.mime, ...file };
  }

  /**
   * Keeps the raw JSON as a file, derives it and stores the new version (BR-3, FR-3) in
   * one transaction with the job's end. A lost lease drops the file and is 409.
   */
  async complete(
    owner: LeaseOwner,
    done: CompleteTranscribeRequest,
  ): Promise<void> {
    const job = this.heldTranscription(owner);
    if (!job) throw leaseLost();
    const { files, transcripts, store } = this.deps;
    assertPlausible(done.raw, store.getMedia(job.mediaId)?.durationMs ?? null);
    const id = randomUUID();
    const rawPath = files.transcriptPath(job.mediaId, id);
    await files.writeFile(rawPath, rawFileOf(done));
    const transcript = this.derive({ id, mediaId: job.mediaId, rawPath, done });
    if (
      !transcripts.completeTranscribe({ owner, transcript, now: this.now() })
    ) {
      await files.remove([rawPath]);
      throw leaseLost();
    }
    // ADR 0022 §4: the FLAC is made for the transcription and goes once it is stored.
    await files.remove([files.flacPath(job.mediaId)]);
  }

  /** The bytes `start..end` of the job's audio. */
  openRange(path: string, range: { start: number; end: number }): Readable {
    return this.deps.files.read(path, range);
  }

  private derive(input: {
    id: string;
    mediaId: string;
    rawPath: string;
    done: CompleteTranscribeRequest;
  }): NewTranscript {
    const { done } = input;
    const derived = deriveTranscript(done.raw, this.terms().terms);
    const verdict = confidenceOf(derived);
    return {
      id: input.id,
      mediaId: input.mediaId,
      ...provenanceOf(done),
      rawPath: input.rawPath,
      filterVersion: FILTER_VERSION,
      confidenceVersion: CONFIDENCE_VERSION,
      confidence: verdict.confidence,
      wordCount: verdict.wordCount,
      removedWords: derived.stats.removedWords,
      lowWords: verdict.doubtedWords,
      segments: derived.segments,
      words: derived.words,
    };
  }

  /** A job whose audio a paired transcriber may fetch: a transcription or a separation. */
  private heldSpeechJob(owner: LeaseOwner): JobLease | null {
    const job = this.deps.transcripts.heldJob(owner);
    return job?.kind === 'transcribe' || job?.kind === 'diarize' ? job : null;
  }

  private heldTranscription(owner: LeaseOwner): JobLease | null {
    const job = this.deps.transcripts.heldJob(owner);
    return job?.kind === 'transcribe' ? job : null;
  }
}

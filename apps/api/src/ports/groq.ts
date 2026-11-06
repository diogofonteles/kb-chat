/** How Groq answered a key check (KBC-037 FR-1). */
export type GroqKeyCheck = 'ok' | 'key-rejected' | 'unreachable';

/** How Groq answered one transcription request (FR-3). */
export type GroqTranscription =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number }
  | { readonly kind: 'key-rejected' }
  | {
      readonly kind: 'failed';
      readonly status: number | null;
      /** Groq answered 200 but its body broke: it charged the request anyway. */
      readonly charged?: true;
    };

/** One chunk as sent: 16 kHz mono FLAC and the term list's prompt. */
export interface GroqChunkRequest {
  readonly key: string;
  readonly audio: Buffer;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

/** Groq's speech-to-text API (console.groq.com/docs/speech-to-text); a fake in tests. */
export interface GroqPort {
  /** Lists the models with `key`: the cheapest proof the key works. */
  checkKey(key: string, signal?: AbortSignal): Promise<GroqKeyCheck>;
  transcribe(request: GroqChunkRequest): Promise<GroqTranscription>;
}

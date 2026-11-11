import { GROQ_MODEL } from '@kb-chat/contracts';
import type {
  GroqChunkRequest,
  GroqKeyCheck,
  GroqPort,
  GroqTranscription,
} from '../ports/groq.js';

export const GROQ_API_URL = 'https://api.groq.com/openai/v1';
/** A key check answers fast or the screen says Groq is unreachable. */
const CHECK_TIMEOUT_MS = 15_000;
/** A 28 s chunk takes about a second; this leaves room for a slow moment. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** When a 429 names no wait (Groq always does, but a proxy may not). */
const DEFAULT_RETRY_AFTER_MS = 30_000;

/**
 * `Retry-After` in seconds or as an HTTP date (RFC 9110 §10.2.3), in ms; the default when
 * absent or unreadable.
 */
export function retryAfterMsOf(
  header: string | null,
  now = Date.now(),
): number {
  if (header === null || header.trim() === '') return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, at - now);
}

/** Groq's OpenAI-compatible API over `fetch`; the key goes only in the header. */
export class GroqClient implements GroqPort {
  constructor(
    private readonly options: {
      readonly fetch?: typeof fetch;
      readonly baseUrl?: string;
    } = {},
  ) {}

  async checkKey(key: string, signal?: AbortSignal): Promise<GroqKeyCheck> {
    try {
      const response = await this.call('/models', {
        method: 'GET',
        headers: { authorization: `Bearer ${key}` },
        signal: withTimeout(signal, CHECK_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) return 'ok';
      return response.status === 401 || response.status === 403
        ? 'key-rejected'
        : 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  async transcribe(request: GroqChunkRequest): Promise<GroqTranscription> {
    let response: Response;
    try {
      response = await this.call('/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${request.key}` },
        body: formOf(request),
        signal: withTimeout(request.signal, TRANSCRIBE_TIMEOUT_MS),
      });
    } catch {
      return { kind: 'failed', status: null };
    }
    if (response.ok) return bodyOf(response);
    await response.body?.cancel();
    if (response.status === 429)
      return {
        kind: 'rate-limited',
        retryAfterMs: retryAfterMsOf(response.headers.get('retry-after')),
      };
    if (response.status === 401 || response.status === 403)
      return { kind: 'key-rejected' };
    return { kind: 'failed', status: response.status };
  }

  private call(path: string, init: RequestInit): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    return doFetch(`${this.options.baseUrl ?? GROQ_API_URL}${path}`, init);
  }
}

/** Groq charged a 200 even when its body does not arrive whole: it is paid for. */
async function bodyOf(response: Response): Promise<GroqTranscription> {
  try {
    return { kind: 'ok', body: await response.json() };
  } catch {
    return { kind: 'failed', status: response.status, charged: true };
  }
}

/** The request as the pilot's parameters set it (ADR 0023 §3), words and segments timed. */
function formOf(request: GroqChunkRequest): FormData {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(request.audio)], { type: 'audio/flac' }),
    'chunk.flac',
  );
  form.append('model', GROQ_MODEL);
  form.append('language', 'pt');
  if (request.prompt) form.append('prompt', request.prompt);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  return form;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

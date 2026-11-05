/** One transcription request as Groq received it. */
export interface GroqCall {
  readonly key: string;
  readonly model: string;
  readonly language: string;
  readonly prompt: string;
  readonly granularities: readonly string[];
  readonly bytes: number;
}

/**
 * Groq's speech-to-text API without the network (KBC-037): a key ending in "valid" is
 * accepted, any other gets 401. A chunk's text has "Hoasca" spelt as the list spells it only
 * when the prompt carries the term (AC-6), as the pilot measured; without it, "Oasca".
 */
export class FakeGroq {
  readonly calls: GroqCall[] = [];
  readonly keyChecks: string[] = [];
  /** The next answers are 429 with this `retry-after` (seconds), then normal again. */
  private limited: { remaining: number; retryAfter: string } = {
    remaining: 0,
    retryAfter: '0',
  };

  /** Every key is refused from now on, as if revoked in Groq's console. */
  revokeKeys(): void {
    this.revoked = true;
  }

  private revoked = false;

  rateLimitNext(times: number, retryAfterSeconds: number): void {
    this.limited = { remaining: times, retryAfter: String(retryAfterSeconds) };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(String(input), init);
    const key = (request.headers.get('authorization') ?? '').replace(
      /^Bearer /,
      '',
    );
    const path = new URL(request.url).pathname;
    if (path.endsWith('/models')) {
      this.keyChecks.push(key);
      return this.accepts(key)
        ? Response.json({ data: [{ id: 'whisper-large-v3-turbo' }] })
        : Response.json(
            { error: { message: 'Invalid API Key' } },
            { status: 401 },
          );
    }
    if (!this.accepts(key))
      return Response.json(
        { error: { message: 'Invalid API Key' } },
        { status: 401 },
      );
    return this.transcribe(request, key);
  };

  private accepts(key: string): boolean {
    return !this.revoked && key.endsWith('valid');
  }

  private async transcribe(request: Request, key: string): Promise<Response> {
    const form = await request.formData();
    const file = form.get('file');
    const prompt = String(form.get('prompt') ?? '');
    this.calls.push({
      key,
      model: String(form.get('model')),
      language: String(form.get('language')),
      prompt,
      granularities: form.getAll('timestamp_granularities[]').map(String),
      bytes: file instanceof Blob ? file.size : 0,
    });
    if (this.limited.remaining > 0) {
      this.limited.remaining--;
      return new Response('{"error":{"message":"Rate limit"}}', {
        status: 429,
        headers: { 'retry-after': this.limited.retryAfter },
      });
    }
    const term = prompt.includes('Hoasca') ? 'Hoasca' : 'Oasca';
    return Response.json(verboseJson(`O chá ${term} foi servido.`));
  }
}

/** Groq's `verbose_json` for one chunk: one segment, its words at the top level. */
export function verboseJson(text: string) {
  const words = text.split(' ').map((word, index) => ({
    word,
    start: index * 0.5,
    end: index * 0.5 + 0.4,
  }));
  return {
    task: 'transcribe',
    language: 'Portuguese',
    duration: words.length * 0.5,
    text,
    segments: [
      {
        id: 0,
        seek: 0,
        start: 0,
        end: words.length * 0.5,
        text: ` ${text}`,
        tokens: [1, 2, 3],
        temperature: 0,
        avg_logprob: -0.2,
        compression_ratio: 1.1,
        no_speech_prob: 0.01,
      },
    ],
    words,
  };
}

/**
 * The Gemini API without the network (KBC-023 NFR-1): a key ending in "valid" is accepted,
 * every other gets 400 API_KEY_INVALID; the answer is one recorded text stream.
 */
export class FakeGemini {
  readonly calls: { model: string; body: unknown }[] = [];
  /** Answers 429 (the free tier's limit) when set. */
  busy = false;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = new Headers(init?.headers).get('x-goog-api-key') ?? '';
    if (!key.endsWith('valid'))
      return new Response(
        JSON.stringify({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }),
        { status: 400 },
      );
    if (this.busy) return new Response('{}', { status: 429 });
    const model = /models\/([^:]+):/.exec(url.pathname)?.[1] ?? '';
    this.calls.push({
      model,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const chunks = [
      {
        candidates: [{ content: { parts: [{ text: 'Resposta do Gemini.' }] } }],
      },
      {
        candidates: [{ content: { parts: [{ text: '' }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
      },
    ];
    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    );
  };
}

/**
 * One fetch for every fake provider, by host: Gemini, OpenRouter, and the other providers
 * (`others`; OpenRouter's fake when absent).
 */
export function fakeProvidersFetch(routes: {
  readonly openrouter: typeof fetch;
  readonly gemini: typeof fetch;
  readonly others?: typeof fetch;
}): typeof fetch {
  return async (input, init) => {
    const host = new URL(String(input)).hostname;
    if (host === 'generativelanguage.googleapis.com')
      return routes.gemini(input, init);
    if (host === 'openrouter.ai' || !routes.others)
      return routes.openrouter(input, init);
    return routes.others(input, init);
  };
}

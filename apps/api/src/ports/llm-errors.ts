/** The provider refused the API key (HTTP 401/403); a connection test reports LLM_KEY_REJECTED. */
export class LlmKeyRejectedError extends Error {
  constructor(provider: string, status: number) {
    super(`${provider} rejected the API key (HTTP ${status})`);
    this.name = 'LlmKeyRejectedError';
  }
}

/**
 * Every model the request could use is rate-limited, out of credit or down (KBC-022): the
 * research turn ends with AI_CAPACITY_EXHAUSTED.
 */
export class LlmCapacityError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} has no capacity: ${detail}`);
    this.name = 'LlmCapacityError';
  }
}

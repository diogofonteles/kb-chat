/** The provider refused the API key (HTTP 401/403); a connection test reports LLM_KEY_REJECTED. */
export class LlmKeyRejectedError extends Error {
  constructor(provider: string, status: number) {
    super(`${provider} rejected the API key (HTTP ${status})`);
    this.name = 'LlmKeyRejectedError';
  }
}

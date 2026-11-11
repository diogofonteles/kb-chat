/**
 * kb's own words when the Mac is not set up to run it (KBC-117): its AI key missing
 * ("decisions: OPENROUTER_API_KEY is not set; the decision model is required", kb 0.0.12), or
 * the transcriber's "chave da IA do kb ausente". A document given up on for one of these never
 * had a real try: it goes back to the queue once a Mac says it can publish.
 */
const CONFIGURATION_ERROR =
  /_API_KEY is not set|model is required|missing API key|chave da IA do kb ausente/i;

export const isKbConfigurationError = (error: string): boolean =>
  CONFIGURATION_ERROR.test(error);

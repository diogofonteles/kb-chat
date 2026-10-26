/**
 * Seals secrets kept on disk (ADR 0016): provider keys of each person and of the house.
 * `open` throws on a value sealed with another key or tampered with.
 */
export interface SecretSealerPort {
  /**
   * `context` names where the value lives ("settings:<principal>:openrouter"): it is bound to
   * the ciphertext (AES-GCM associated data), so a sealed value copied elsewhere will not open.
   */
  seal(plain: string, context: string): string;
  open(sealed: string, context: string): string;
  isSealed(value: string): boolean;
}

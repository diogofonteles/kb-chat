/**
 * Seals secrets kept on disk (ADR 0016): provider keys of each person and of the house.
 * `open` throws on a value sealed with another key or tampered with.
 */
export interface SecretSealerPort {
  seal(plain: string): string;
  open(sealed: string): string;
  isSealed(value: string): boolean;
}

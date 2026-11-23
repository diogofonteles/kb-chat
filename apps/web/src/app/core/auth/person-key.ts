/**
 * The name of a person's own entry in this browser's storage: `<prefix>:<fingerprint>`, so
 * the next person in the same browser never reads what another one kept. The fingerprint
 * (FNV-1a of the lowercased address) is not a secret, only a name that does not show who.
 */
export function personStorageKey(prefix: string, email: string): string {
  return `${prefix}:${fingerprint(email.toLowerCase())}`;
}

function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

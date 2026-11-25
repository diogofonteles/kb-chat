/** Documents of one inclusion land seconds apart: the collection is read once after them. */
export const REFRESH_DELAY_MS = 2_000;

/**
 * Reads a collection again shortly after the Mac says it wrote a document there, so an API on
 * the same vault (development) shows it without a restart. On production the vault comes with
 * the sync, which reloads the whole catalog (KBC-100 FR-5); this reading finds nothing new.
 */
export function refreshSoon(
  refresh: (topic: string) => Promise<void>,
  options: {
    readonly onError: (err: unknown) => void;
    readonly delayMs?: number;
  },
): (topic: string) => void {
  const waiting = new Set<string>();
  return (topic) => {
    if (waiting.has(topic)) return;
    waiting.add(topic);
    const timer = setTimeout(() => {
      waiting.delete(topic);
      refresh(topic).catch(options.onError);
    }, options.delayMs ?? REFRESH_DELAY_MS);
    timer.unref();
  };
}

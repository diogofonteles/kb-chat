import type { MediaItem } from '@kb-chat/contracts';

/** "42 áudios · 31 h" (or "· 45 min" under an hour): what the list holds (T14). */
export function summaryOf(items: readonly MediaItem[]): string {
  const count = $localize`:@@media.summary.count:${items.length}:count: ${items.length === 1 ? 'áudio' : 'áudios'}:noun:`;
  const totalMs = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
  if (totalMs === 0) return count;
  const minutes = Math.round(totalMs / 60_000);
  const length =
    minutes >= 60
      ? $localize`:@@media.summary.hours:${Math.round(minutes / 60)}:hours: h`
      : $localize`:@@media.summary.minutes:${Math.max(1, minutes)}:minutes: min`;
  return `${count} · ${length}`;
}

/** Search in titles without accents or case ("palestra" finds "Palestra Ó"). */
const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR');

export const matchesTitle = (item: MediaItem, query: string): boolean =>
  fold(item.title).includes(fold(query.trim()));

/** Items that just became ready, between two refreshes of the list. */
export function newlyReady(
  before: readonly MediaItem[],
  after: readonly MediaItem[],
): MediaItem[] {
  const was = new Map(before.map((item) => [item.id, item.status]));
  return after.filter(
    (item) =>
      item.status === 'ready' &&
      was.has(item.id) &&
      was.get(item.id) !== 'ready',
  );
}

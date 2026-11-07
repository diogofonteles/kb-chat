const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const clock = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
});
const dayAndClock = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** "14:02" today, "12/03 14:02" on another day: the "desde" of a publication state. */
export function publicationTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  return (sameDay(at, now) ? clock : dayAndClock).format(at).replace(',', '');
}

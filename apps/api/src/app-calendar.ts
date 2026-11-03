/**
 * The app's calendar (KBC-061): "today" and "this month" are the owner's, in Recife, never
 * the server process's (the container runs in UTC, so a day ended at 21:00 there).
 */
export const APP_TIME_ZONE = 'America/Recife';

/** One formatter per zone: building one is far slower than using it. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

const partsIn = (instant: Date, timeZone: string) => {
  const parts = formatterOf(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
};

/** How far the zone is from UTC at this instant, in ms (negative west of Greenwich). */
function offsetAt(instant: Date, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant a local calendar date starts in the zone: its midnight, or the first instant
 * of the day when the clocks jumped over midnight that night (daylight saving).
 */
function midnightOf(
  date: { year: number; month: number; day: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  const first = guess - offsetAt(new Date(guess), timeZone);
  const second = guess - offsetAt(new Date(first), timeZone);
  const sameDay = (instant: number) => {
    const p = partsIn(new Date(instant), timeZone);
    return p.year === date.year && p.month === date.month && p.day === date.day;
  };
  const inDay = [first, second].filter(sameDay);
  return new Date(
    inDay.length > 0 ? Math.min(...inDay) : Math.max(first, second),
  );
}

/** The start of the day `now` falls in, in the app's zone. */
export function startOfAppDay(now: Date, timeZone = APP_TIME_ZONE): Date {
  const { year, month, day } = partsIn(now, timeZone);
  return midnightOf({ year, month, day }, timeZone);
}

/** The start of the month `now` falls in, in the app's zone. */
export function startOfAppMonth(now: Date, timeZone = APP_TIME_ZONE): Date {
  const { year, month } = partsIn(now, timeZone);
  return midnightOf({ year, month, day: 1 }, timeZone);
}

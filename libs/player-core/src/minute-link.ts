/**
 * Links to a minute of a media (KBC-038 FR-5, FR-9): `?t=` in whole seconds, which wins
 * over the saved position when the page opens.
 */

/** The longest `?t=` taken: 100 hours. */
const MAX_SECONDS = 360_000;

/** The start asked by `?t=754` in ms; null when absent or not a whole number of seconds. */
export function startFromParam(
  value: string | null | undefined,
): number | null {
  if (!value || !/^\d{1,6}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds <= MAX_SECONDS ? seconds * 1000 : null;
}

/** `page` with `?t=` of the second at `ms` (floored), replacing any `t` it had. */
export function minuteLink(page: string, ms: number): string {
  const url = new URL(page);
  url.searchParams.set('t', String(Math.max(0, Math.floor(ms / 1000))));
  return url.toString();
}

/** What "Copiar com o link do minuto" copies: the passage in quotes, the title, the link. */
export function quoteWithLink(input: {
  readonly text: string;
  readonly title: string;
  readonly link: string;
}): string {
  const passage = input.text.replace(/\s+/g, ' ').trim();
  return `“${passage}”\n${input.title}\n${input.link}`;
}

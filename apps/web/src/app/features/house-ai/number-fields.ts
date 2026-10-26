import { MAX_DAILY_RESEARCHES, MAX_MONTHLY_CAP_USD } from '@kb-chat/contracts';

/** A number field's outcome: the value to save, or why it cannot be saved (MA-23). */
export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const DAILY_ERROR = () =>
  $localize`:@@numbers.daily:Use um número inteiro de 0 a ${MAX_DAILY_RESEARCHES}:max:.`;
const CAP_ERROR = () =>
  $localize`:@@numbers.cap:Use um valor de 0 a ${MAX_MONTHLY_CAP_USD}:max: (US$).`;

/** Researches a day: a whole number in range; blank means the default when allowed. */
export function parseDaily(
  typed: string,
  allowBlank: boolean,
): Parsed<number | null> {
  if (typed.trim() === '')
    return allowBlank
      ? { ok: true, value: null }
      : { ok: false, error: DAILY_ERROR() };
  const daily = Number(typed);
  return Number.isInteger(daily) && daily >= 0 && daily <= MAX_DAILY_RESEARCHES
    ? { ok: true, value: daily }
    : { ok: false, error: DAILY_ERROR() };
}

/** A monthly cap in US$, within the contract's range. */
export function parseCap(typed: string): Parsed<number> {
  const cap = Number(typed);
  return typed.trim() !== '' &&
    Number.isFinite(cap) &&
    cap >= 0 &&
    cap <= MAX_MONTHLY_CAP_USD
    ? { ok: true, value: cap }
    : { ok: false, error: CAP_ERROR() };
}

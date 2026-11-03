/**
 * "03/11/2026 às 14:05": when something was last seen (a transcriber, KBC-036). One format,
 * externalized, for every screen that shows it (UP-05, skill i18n); used with LOCALE_ID.
 */
export const seenAtFormat = (): string =>
  $localize`:@@date.seenAtFormat:dd/MM/yyyy 'às' HH:mm`;

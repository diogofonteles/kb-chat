import { spokenTime, type SpokenUnits } from '@kb-chat/player-core';

/** The words of a spoken time in the UI's language (screen readers, aria-valuetext). */
export const SPOKEN_UNITS: SpokenUnits = {
  hour: [$localize`:@@time.hour:hora`, $localize`:@@time.hours:horas`],
  minute: [
    $localize`:@@time.minute:minuto`,
    $localize`:@@time.minutes:minutos`,
  ],
  second: [
    $localize`:@@time.second:segundo`,
    $localize`:@@time.seconds:segundos`,
  ],
  and: $localize`:@@time.and:e`,
};

/** "23 minutos e 10 segundos". */
export const speak = (ms: number): string => spokenTime(ms, SPOKEN_UNITS);

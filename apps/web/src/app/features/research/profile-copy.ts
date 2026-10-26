import type { ResearchProfile } from '@kb-chat/contracts';

export interface ProfileCopy {
  readonly label: () => string;
  /** What the reader gets, in one line: speed against depth (KBC-011). */
  readonly help: () => string;
}

/** pt-BR copy of the research profiles, for the composer toggle and Settings. */
export const PROFILE_COPY: Record<ResearchProfile, ProfileCopy> = {
  fast: {
    label: () => $localize`:@@profile.fast:Rápido`,
    help: () =>
      $localize`:@@profile.fastHelp:Responde em segundos, com uma pesquisa curta e uma resposta direta.`,
  },
  deep: {
    label: () => $localize`:@@profile.deep:Profundo`,
    help: () =>
      $localize`:@@profile.deepHelp:Pesquisa mais e usa o modelo mais forte; pode levar um minuto.`,
  },
  exhaustive: {
    label: () => $localize`:@@profile.exhaustive:Exaustivo`,
    help: () =>
      $localize`:@@profile.exhaustiveHelp:Varre o acervo inteiro, página por página, e lista tudo o que achar; pode levar vários minutos.`,
  },
};

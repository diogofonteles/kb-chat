import type { Me } from '@kb-chat/contracts';
import type { SettingsSection } from './settings-store.js';

/** The groups of the index (KBC-131): Você · Administração · Mídia, and Sobre on its own. */
export type SettingsGroup = 'you' | 'admin' | 'media' | 'end';

export interface SectionEntry {
  readonly id: SettingsSection;
  /** The address: /configuracoes/<slug> (BR-5). */
  readonly slug: string;
  readonly group: SettingsGroup;
  readonly label: () => string;
  /** Words the corner search also finds this section by. */
  readonly keywords: () => string;
}

/** Who may see a section: the same rules as the v1 modal (KBC-010, BR-4). */
export interface SectionAccess {
  readonly me: Me | null;
  readonly master: boolean;
  readonly ownAi: boolean;
}

export const SETTINGS_SECTIONS: readonly SectionEntry[] = [
  {
    id: 'account',
    slug: 'conta',
    group: 'you',
    label: () => $localize`:@@settings.account:Conta`,
    keywords: () => $localize`:@@settings.accountWords:sair e-mail perfil`,
  },
  {
    id: 'ai',
    slug: 'sua-ia',
    group: 'you',
    label: () => $localize`:@@settings.ai:Sua IA`,
    keywords: () =>
      $localize`:@@settings.aiWords:provedor chave openrouter gemini claude openai modelo`,
  },
  {
    id: 'preferences',
    slug: 'preferencias',
    group: 'you',
    label: () => $localize`:@@settings.preferences:Preferências`,
    keywords: () =>
      $localize`:@@settings.preferencesWords:tema acervo padrão busca pesquisa aprofundar`,
  },
  {
    id: 'accesses',
    slug: 'acessos',
    group: 'you',
    label: () => $localize`:@@settings.accesses:Acessos à sua conta`,
    keywords: () => $localize`:@@settings.accessesWords:ver como master`,
  },
  {
    id: 'people',
    slug: 'pessoas',
    group: 'admin',
    label: () => $localize`:@@settings.people:Pessoas e permissões`,
    keywords: () =>
      $localize`:@@settings.peopleWords:convite convidar solicitações pedidos perfis níveis`,
  },
  {
    id: 'house',
    slug: 'ia-da-aplicacao',
    group: 'admin',
    label: () => $localize`:@@settings.house:IA da aplicação`,
    keywords: () =>
      $localize`:@@settings.houseWords:openrouter codex chatgpt modelos gratuitos reserva`,
  },
  {
    id: 'audit',
    slug: 'auditoria',
    group: 'admin',
    label: () => $localize`:@@settings.audit:Auditoria do Ver como`,
    keywords: () => $localize`:@@settings.auditWords:registro ver como`,
  },
  {
    id: 'transcribers',
    slug: 'transcritores',
    group: 'media',
    label: () => $localize`:@@settings.transcribers:Transcritores`,
    keywords: () =>
      $localize`:@@settings.transcribersWords:mac parear token faixas`,
  },
  {
    id: 'terms',
    slug: 'termos',
    group: 'media',
    label: () => $localize`:@@settings.terms:Termos da transcrição`,
    keywords: () =>
      $localize`:@@settings.termsWords:nomes lista aprendido correções`,
  },
  {
    id: 'groq',
    slug: 'groq',
    group: 'media',
    label: () => $localize`:@@settings.groq:Groq de reserva`,
    keywords: () => $localize`:@@settings.groqWords:nuvem teto gasto`,
  },
  {
    id: 'web-search',
    slug: 'pesquisa-na-web',
    group: 'media',
    label: () => $localize`:@@settings.webSearch:Pesquisa na web (Firecrawl)`,
    keywords: () =>
      $localize`:@@settings.webSearchWords:firecrawl chave créditos saldo links vídeos`,
  },
  {
    id: 'voice-profiles',
    slug: 'perfis-de-voz',
    group: 'media',
    label: () => $localize`:@@settings.voiceProfiles:Perfis de voz`,
    keywords: () =>
      $localize`:@@settings.voiceProfilesWords:voz consentimento biometria`,
  },
  {
    id: 'about',
    slug: 'sobre',
    group: 'end',
    label: () => $localize`:@@settings.about:Sobre`,
    keywords: () =>
      $localize`:@@settings.aboutWords:privacidade assistente de início`,
  },
];

export const GROUP_LABELS: Record<SettingsGroup, () => string> = {
  you: () => $localize`:@@settings.groupYou:Você`,
  admin: () => $localize`:@@settings.groupAdmin:Administração`,
  media: () => $localize`:@@settings.groupMedia:Mídia`,
  end: () => '',
};

const MEDIA_ADMIN: ReadonlySet<SettingsSection> = new Set([
  'transcribers',
  'terms',
  'groq',
  // KBC-185: where documents are sent from the app, which needs the media library.
  'web-search',
]);

/** Only what the person may change (KBC-010): the v1 rules, section by section. */
export function mayOpen(id: SettingsSection, access: SectionAccess): boolean {
  const { me, master, ownAi } = access;
  const media = me?.media === true;
  if (id === 'ai') return ownAi;
  if (id === 'people' || id === 'house') return master;
  // KBC-036 BR-1: masters pair the Macs where the media library is on; Groq too (KBC-037).
  if (MEDIA_ADMIN.has(id)) return master && media;
  // KBC-071 (ADR 0032): with the voice-profiles feature, where the media library is on.
  if (id === 'voice-profiles')
    return media && me?.features.includes('media-voice-profiles') === true;
  if (id === 'audit') return me?.canActAs === true;
  return true;
}

export const sectionBySlug = (slug: string | null): SectionEntry | null =>
  SETTINGS_SECTIONS.find((entry) => entry.slug === slug) ?? null;

export const slugOf = (id: SettingsSection): string =>
  SETTINGS_SECTIONS.find((entry) => entry.id === id)?.slug ?? 'conta';

/** Lower case without accents, so "preferencias" finds "Preferências". */
export const folded = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

import { httpResource } from '@angular/common/http';
import { computed, type Signal } from '@angular/core';
import {
  accessRequestListSchema,
  actAsAuditListSchema,
  groqSettingsSchema,
  houseAiViewSchema,
  myAccessListSchema,
  termListSchema,
  transcriberListSchema,
  voiceProfileReportSchema,
  type HouseAiView,
} from '@kb-chat/contracts';
import { ACT_AS_AUDIT_URL, MY_ACCESSES_URL } from '@core/auth/act-as-api.js';
import { accessRequestsUrl } from '@core/auth/access-api.js';
import { houseAiUrl } from '@core/api/house-ai-api.js';
import { groqUrl } from '@core/media/groq-api.js';
import { termsUrl } from '@core/media/terms-api.js';
import { transcribersUrl } from '@core/media/transcribers-api.js';
import { voiceReportUrl } from '@core/media/voice-profiles-api.js';
import { GROQ_MODE_OPTIONS } from '@features/transcribers/groq-panel.js';
import type { SettingsSection } from './settings-store.js';

type Lines = Partial<Record<SettingsSection, string>>;

/** A count in words: none, one, many ("Nenhum pareado", "1 pareado", "3 pareados"). */
interface Counted {
  readonly none: () => string;
  readonly one: () => string;
  readonly many: (count: number) => string;
}

const say = (count: number, words: Counted): string =>
  count === 0 ? words.none() : count === 1 ? words.one() : words.many(count);

/** One section's line: where its data is, how to read it and how to say it. */
interface Summary {
  readonly id: SettingsSection;
  readonly url: () => string;
  readonly line: (body: unknown) => string;
}

const countOf =
  (items: (body: unknown) => readonly unknown[], words: Counted) =>
  (body: unknown): string =>
    say(items(body).length, words);

const houseLine = (view: HouseAiView): string => {
  const usage = view.freeUsage;
  if (!view.connection)
    return $localize`:@@settings.root.houseOff:Não conectada`;
  return usage
    ? $localize`:@@settings.root.houseUsage:Conectada · ${usage.used}:used: de ${usage.limit}:limit: pedidos hoje`
    : $localize`:@@settings.root.houseOn:Conectada`;
};

const groqLine = (mode: string): string =>
  GROQ_MODE_OPTIONS.find((one) => one.mode === mode)?.label() ?? '';

const SUMMARIES: readonly Summary[] = [
  {
    id: 'accesses',
    url: () => MY_ACCESSES_URL,
    line: countOf((body) => myAccessListSchema.parse(body).items, {
      none: () =>
        $localize`:@@settings.root.accessesNone:Nenhum acesso registrado`,
      one: () => $localize`:@@settings.root.accessesOne:1 acesso registrado`,
      many: (n) =>
        $localize`:@@settings.root.accesses:${n}:count: acessos registrados`,
    }),
  },
  {
    id: 'people',
    url: accessRequestsUrl,
    line: countOf((body) => accessRequestListSchema.parse(body).items, {
      none: () =>
        $localize`:@@settings.root.requestsNone:Nenhuma solicitação pendente`,
      one: () => $localize`:@@settings.root.requestsOne:1 solicitação pendente`,
      many: (n) =>
        $localize`:@@settings.root.requests:${n}:count: solicitações pendentes`,
    }),
  },
  {
    id: 'house',
    url: houseAiUrl,
    line: (body) => houseLine(houseAiViewSchema.parse(body)),
  },
  {
    id: 'audit',
    url: () => ACT_AS_AUDIT_URL,
    line: countOf((body) => actAsAuditListSchema.parse(body).items, {
      none: () => $localize`:@@settings.root.auditNone:Nenhum registro`,
      one: () => $localize`:@@settings.root.auditOne:1 registro`,
      many: (n) => $localize`:@@settings.root.audit:${n}:count: registros`,
    }),
  },
  {
    id: 'transcribers',
    url: transcribersUrl,
    line: countOf((body) => transcriberListSchema.parse(body).items, {
      none: () => $localize`:@@settings.root.transcribersNone:Nenhum pareado`,
      one: () => $localize`:@@settings.root.transcribersOne:1 pareado`,
      many: (n) =>
        $localize`:@@settings.root.transcribers:${n}:count: pareados`,
    }),
  },
  {
    id: 'terms',
    url: termsUrl,
    line: countOf((body) => termListSchema.parse(body).terms, {
      none: () => $localize`:@@settings.root.termsNone:Nenhum termo`,
      one: () => $localize`:@@settings.root.termsOne:1 termo`,
      many: (n) => $localize`:@@settings.root.terms:${n}:count: termos`,
    }),
  },
  {
    id: 'groq',
    url: groqUrl,
    line: (body) => groqLine(groqSettingsSchema.parse(body).mode),
  },
  {
    id: 'voice-profiles',
    url: voiceReportUrl,
    line: countOf((body) => voiceProfileReportSchema.parse(body).items, {
      none: () => $localize`:@@settings.root.voicesNone:Nenhum perfil`,
      one: () => $localize`:@@settings.root.voicesOne:1 perfil`,
      many: (n) => $localize`:@@settings.root.voices:${n}:count: perfis`,
    }),
  },
];

/**
 * The phone root's line under each section that has data of its own (v2 · Índice, celular):
 * "1 acesso registrado", "3 solicitações pendentes", "Conectada · 0 de 1000 pedidos hoje",
 * "9 registros", "1 pareado", "32 termos", "Nunca", "Nenhum perfil". Each is read only while
 * the root shows that section (`shown`); one that fails to load keeps just its name. Call in
 * an injection context.
 */
export function rootSummaries(
  shown: (id: SettingsSection) => boolean,
): Signal<Lines> {
  const loaded = SUMMARIES.map((summary) => ({
    id: summary.id,
    resource: httpResource(
      () => (shown(summary.id) ? summary.url() : undefined),
      { parse: summary.line },
    ),
  }));
  return computed(() => {
    const lines: Lines = {};
    for (const { id, resource } of loaded)
      if (resource.hasValue() && resource.value()) lines[id] = resource.value();
    return lines;
  });
}

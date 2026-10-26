import type { HttpTestingController } from '@angular/common/http/testing';
import type {
  AiStatus,
  HouseAiView,
  ProviderInfo,
  ProviderList,
  SettingsView,
} from '@kb-chat/contracts';

export const aSettingsView = (
  overrides: Partial<SettingsView> = {},
): SettingsView => ({
  exists: true,
  preferences: {
    searchMode: 'all',
    theme: 'auto',
    defaultView: 'research',
    researchProfile: 'fast',
    autoDeepen: true,
  },
  ai: { provider: null, models: {}, keys: {}, dailyCapUsd: 1 },
  ...overrides,
});

const info = (
  id: ProviderInfo['id'],
  overrides: Partial<ProviderInfo> = {},
): ProviderInfo => ({
  id,
  billing:
    id === 'none'
      ? 'none'
      : id.endsWith('subscription')
        ? 'subscription'
        : 'per-token',
  available: true,
  reason: null,
  keySource: null,
  defaultModels: { fast: null, deep: null },
  models: [],
  freeModel: !id.endsWith('subscription'),
  ...overrides,
});

type Overrides = Partial<Record<ProviderInfo['id'], Partial<ProviderInfo>>>;

const KEY_MISSING = { available: false, reason: 'key-missing' } as const;
const CLI_MISSING = { available: false, reason: 'cli-missing' } as const;

/** Claude Code missing (AC-3), no keys anywhere. */
export const aProviderList = (overrides: Overrides = {}): ProviderList => ({
  active: 'none',
  items: [
    info('openrouter', {
      ...KEY_MISSING,
      defaultModels: {
        fast: 'deepseek/deepseek-v4-flash',
        deep: 'deepseek/deepseek-v4-pro',
      },
      ...overrides.openrouter,
    }),
    info('anthropic', {
      ...KEY_MISSING,
      defaultModels: { fast: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
      ...overrides.anthropic,
    }),
    info('openai', { ...KEY_MISSING, ...overrides.openai }),
    info('claude-subscription', {
      ...CLI_MISSING,
      defaultModels: { fast: 'sonnet', deep: 'opus' },
      models: ['sonnet', 'opus', 'haiku'],
      ...overrides['claude-subscription'],
    }),
    info('chatgpt-subscription', {
      ...CLI_MISSING,
      ...overrides['chatgpt-subscription'],
    }),
    info('none', overrides.none),
  ],
});

/** GET /api/v1/ai/status (KBC-022): nothing serves the person by default. */
export const anAiStatus = (overrides: Partial<AiStatus> = {}): AiStatus => ({
  source: 'none',
  appAi: null,
  provider: null,
  remainingToday: null,
  dailyResearches: null,
  enforced: false,
  ...overrides,
});

/** Answers every pending "Quem atende você" request (Settings asks again after a save). */
export const flushAiStatus = (
  http: HttpTestingController,
  status: AiStatus = anAiStatus(),
): void => {
  for (const request of http.match('/api/v1/ai/status')) request.flush(status);
};

/** GET /api/v1/house-ai (KBC-022): not connected, the defaults. */
export const aHouseView = (
  overrides: Partial<HouseAiView> = {},
): HouseAiView => ({
  connection: null,
  freeModels: null,
  includeRouter: true,
  chain: ['openrouter/free'],
  paidModel: null,
  defaultAppAi: 'house',
  defaultDailyResearches: 5,
  managementKey: null,
  freeUsage: null,
  ...overrides,
});

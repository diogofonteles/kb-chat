import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

const expandHome = (path: string): string =>
  path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);

const csv = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()))
  .pipe(z.array(z.string().min(1)));

export const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:4200'),
  ALLOWED_HOSTS: csv.default(['localhost', '127.0.0.1']),
  KB_VAULT: z
    .string()
    .min(1)
    .default('~/dev/personal/hermetismo')
    .transform(expandHome),
  KB_BIN: z.string().min(1).default('kb'),
  QMD_BIN: z.string().min(1).default('qmd'),
  KB_CHAT_SEARCH: z.enum(['qmd', 'fixture']).default('qmd'),
  /** Topic opened by default; without it the web picks the largest topic. */
  KB_TOPIC: z.string().min(1).optional(),
  /** Searches per minute per client (local single user: generous, ND-22). */
  SEARCH_RATE_LIMIT: z.coerce.number().int().min(1).default(120),
  /** Obsidian vault name for "Abrir no Obsidian"; default: the vault folder's name. */
  OBSIDIAN_VAULT: z.string().min(1).optional(),
  /** Paid provider key for AI answers; without it answers are disabled (LLM_NOT_CONFIGURED). */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** Model for answers; default: the vault's kb.toml [generation] model. */
  KB_CHAT_MODEL: z.string().min(1).optional(),
  KB_CHAT_LLM: z.enum(['openrouter', 'stub']).default('openrouter'),
  KB_CHAT_DAILY_CAP_USD: z.coerce.number().min(0).default(1),
  /** Local state (spend ledger, usage log, settings). */
  KB_CHAT_STATE_DIR: z
    .string()
    .min(1)
    .default('~/.kb-chat')
    .transform(expandHome),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type AppConfig = z.infer<typeof configSchema>;

/** Validates the environment once at boot; an invalid value stops the process. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${JSON.stringify(z.treeifyError(parsed.error))}`,
    );
  }
  return parsed.data;
}

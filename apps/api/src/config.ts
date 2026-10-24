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

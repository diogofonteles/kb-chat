import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

const expandHome = (path: string): string =>
  path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);

/**
 * Compose passes `NAME=` (or `${NAME:-}`) as an empty string: for the optional email
 * settings, blank means unset, so a deploy .env may leave the unused provider empty.
 */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const csv = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()))
  .pipe(z.array(z.string().min(1)));

export const configSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * Interface the API listens on. Loopback by default (ADR 0005); the container sets
     * 0.0.0.0 so the reverse proxy on the private network reaches it (ADR 0010).
     */
    HOST: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
    WEB_ORIGIN: z.url().default('http://localhost:4200'),
    ALLOWED_HOSTS: csv.default(['localhost', '127.0.0.1']),
    /**
     * Proxies whose X-Forwarded-For is trusted for request.ip (rate limits, ND-21), in
     * Fastify's trustProxy syntax (e.g. "uniquelocal"); unset trusts none.
     */
    TRUST_PROXY: z.string().min(1).optional(),
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
    /** Paid provider key for the research agent; without it AI is disabled (LLM_NOT_CONFIGURED). */
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    /** Model of the research agent (needs tool calling); default deepseek/deepseek-v4-pro (ADR 0006). */
    KB_CHAT_MODEL: z.string().min(1).optional(),
    /** Model reasoning on each agent call; off by default (see OpenRouterAdapter). */
    KB_CHAT_REASONING: z
      .enum(['on', 'off'])
      .default('off')
      .transform((value) => value === 'on'),
    KB_CHAT_LLM: z.enum(['openrouter', 'stub']).default('openrouter'),
    /** Per-token provider keys used while Settings do not set one (KBC-007 BR-4). */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    /** Official CLIs for the subscriptions (KBC-007): a name looked up on PATH, or a path. */
    CLAUDE_BIN: z.string().min(1).default('claude'),
    CODEX_BIN: z.string().min(1).default('codex'),
    /**
     * The ChatGPT subscription through Codex stays off unless enabled: Codex cannot be
     * limited to the kb tools the way Claude Code is (ADR 0007).
     */
    KB_CHAT_CODEX: z
      .enum(['on', 'off'])
      .default('off')
      .transform((value) => value === 'on'),
    KB_CHAT_DAILY_CAP_USD: z.coerce.number().min(0).default(1),
    /** Local state (spend ledger, usage log, settings). */
    KB_CHAT_STATE_DIR: z
      .string()
      .min(1)
      .default('~/.kb-chat')
      .transform(expandHome),
    /**
     * Google OAuth client id (public) of the "Entrar com Google" button (ADR 0008). The API
     * checks every ID token's audience against it; required to start the API (main).
     */
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    /** The owner's Google account: the first master, and the only one using subscriptions. */
    KB_CHAT_OWNER_EMAIL: z
      .email()
      .transform((email) => email.toLowerCase())
      .optional(),
    /** Sign-in attempts per minute per client. */
    AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
    /** `production` makes the API refuse to start without a real email provider (ADR 0011). */
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    /** Resend API key (secret) for one-time codes and access notices; empty → the API log (dev). */
    RESEND_API_KEY: blankAsUnset(z.string().min(1).optional()),
    /**
     * The sender. Resend: an address on a verified domain, "kb-chat <nao-responda@example.com>".
     * SMTP: optional, default "Nova Alexandria <SMTP_USER>" (Gmail sends only as the account itself).
     */
    KB_CHAT_EMAIL_FROM: blankAsUnset(z.string().min(3).optional()),
    /** SMTP server of the free email path (KBC-015, ADR 0012): Gmail by default. */
    SMTP_HOST: blankAsUnset(z.string().min(1).default('smtp.gmail.com')),
    /** 465 speaks TLS from the start; any other port must offer STARTTLS. */
    SMTP_PORT: blankAsUnset(
      z.coerce.number().int().min(1).max(65535).default(465),
    ),
    /** The Gmail account that sends; set together with SMTP_PASSWORD. */
    SMTP_USER: blankAsUnset(z.string().min(1).optional()),
    /** Its app password (secret, myaccount.google.com/apppasswords); set with SMTP_USER. */
    SMTP_PASSWORD: blankAsUnset(z.string().min(1).optional()),
    /** SMS codes: off (default; no free provider for Brazil, ADR 0011) | log (development). */
    KB_CHAT_SMS: z.enum(['off', 'log']).default('off'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((config, context) => {
    // Half of the pair is a typo, not a choice: fail at boot in every environment.
    for (const [name, other] of [
      ['SMTP_USER', 'SMTP_PASSWORD'],
      ['SMTP_PASSWORD', 'SMTP_USER'],
    ] as const) {
      if (config[name] && !config[other])
        context.addIssue({
          code: 'custom',
          path: [other],
          message: `${name} is set without ${other}: set both or neither`,
        });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

interface SignInConfig {
  readonly GOOGLE_CLIENT_ID: string;
  readonly KB_CHAT_OWNER_EMAIL: string;
}

/** Sign-in is required (KBC-010): the API does not start without its two settings. */
export function assertSignInConfigured(
  config: AppConfig,
): asserts config is AppConfig & SignInConfig {
  const missing = (['GOOGLE_CLIENT_ID', 'KB_CHAT_OWNER_EMAIL'] as const).filter(
    (name) => !config[name],
  );
  if (missing.length > 0)
    throw new Error(
      `Sign-in is not configured: set ${missing.join(' and ')} in the repository's .env`,
    );
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

/** True when one email provider has everything it needs (ADR 0011, ADR 0012). */
export function hasEmailProvider(config: AppConfig): boolean {
  const smtp = Boolean(config.SMTP_USER && config.SMTP_PASSWORD);
  const resend = Boolean(config.RESEND_API_KEY && config.KB_CHAT_EMAIL_FROM);
  return smtp || resend;
}

/**
 * Production sends real email (ADR 0011, ADR 0012): without Gmail SMTP or Resend the codes
 * would only reach the log, so the API does not start; the SMS log adapter is refused there
 * too.
 */
export function assertDeliveryConfigured(config: AppConfig): void {
  // Listening beyond loopback is a deployment even when NODE_ENV was forgotten: fail closed.
  const exposed = !LOOPBACK.has(config.HOST);
  if (config.NODE_ENV !== 'production' && !exposed) return;
  if (!hasEmailProvider(config))
    throw new Error(
      'Email delivery is not configured for production: set SMTP_USER and SMTP_PASSWORD (Gmail), or RESEND_API_KEY and KB_CHAT_EMAIL_FROM',
    );
  if (config.KB_CHAT_SMS === 'log')
    throw new Error(
      'KB_CHAT_SMS=log writes codes to the log: not in production',
    );
}

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

import { z } from 'zod';

/** The runner's own settings (ADR 0020), read once at its start. */
const runnerConfigSchema = z.object({
  CODEX_HOME: z.string().min(1),
  CODEX_BIN: z.string().min(1).default('codex'),
  CODEX_RUNNER_HOST: z.string().min(1).default('0.0.0.0'),
  CODEX_RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  /** The API's MCP endpoint for turns (ADR 0020): the only one Codex is pointed at. */
  CODEX_MCP_URL: z.url(),
  /** Kill what a former turn left before each turn: only in the container (compose sets it). */
  CODEX_RUNNER_REAP: z
    .enum(['on', 'off'])
    .default('off')
    .transform((value) => value === 'on'),
  /** Who may send turns, by socket address (the API); empty: loopback only. */
  CODEX_RUNNER_CLIENTS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  PATH: z.string().default('/usr/local/bin:/usr/bin:/bin'),
  LANG: z.string().default('C.UTF-8'),
});
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export function loadRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
): RunnerConfig {
  const parsed = runnerConfigSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid Codex runner configuration: ${parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`,
    );
  return parsed.data;
}

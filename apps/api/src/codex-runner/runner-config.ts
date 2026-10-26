import { z } from 'zod';

/** The runner's own settings (ADR 0020), read once at its start. */
const runnerConfigSchema = z.object({
  CODEX_HOME: z.string().min(1),
  CODEX_BIN: z.string().min(1).default('codex'),
  CODEX_RUNNER_HOST: z.string().min(1).default('0.0.0.0'),
  CODEX_RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
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

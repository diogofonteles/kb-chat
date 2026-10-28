import { hostname } from 'node:os';
import { z } from 'zod';

/**
 * The media worker's settings (ADR 0022 §3), read once at its start: where the API is,
 * its token, the shared media folder and ffmpeg/ffprobe by absolute path.
 */
const workerConfigSchema = z.object({
  KB_CHAT_MEDIA_API_URL: z.url(),
  KB_CHAT_MEDIA_WORKER_TOKEN: z.string().min(32),
  KB_CHAT_MEDIA_DIR: z.string().min(1).default('/data/media'),
  KB_CHAT_MEDIA_WORKER_NAME: z.string().min(1).max(100).default(hostname()),
  FFMPEG_BIN: z.string().min(1).default('/usr/bin/ffmpeg'),
  FFPROBE_BIN: z.string().min(1).default('/usr/bin/ffprobe'),
  /** How long to wait before asking again when the queue is empty. */
  KB_CHAT_MEDIA_POLL_MS: z.coerce
    .number()
    .int()
    .min(200)
    .max(60_000)
    .default(3_000),
  /** Touched on every loop: the container healthcheck reads its age. */
  KB_CHAT_MEDIA_ALIVE_FILE: z
    .string()
    .min(1)
    .default('/tmp/media-worker.alive'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const parsed = workerConfigSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid media worker configuration: ${parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`,
    );
  return parsed.data;
}

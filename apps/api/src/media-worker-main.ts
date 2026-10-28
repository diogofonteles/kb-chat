import { HttpMediaJobsApi } from './media-worker/api-client.js';
import { MediaWorker } from './media-worker/media-worker.js';
import { loadWorkerConfig } from './media-worker/worker-config.js';
import { assertWorkerReady } from './media-worker/worker-readiness.js';
import { createLogger } from './logger.js';

// The media worker (KBC-034, ADR 0022 §3): the `media-worker` service's process, from the
// API image with another command, capped to 1 CPU and 2 GB, with the media volume only.
const config = loadWorkerConfig();
const log = createLogger(config.LOG_LEVEL);
const bins = { ffmpeg: config.FFMPEG_BIN, ffprobe: config.FFPROBE_BIN };
await assertWorkerReady({ bins, mediaDir: config.KB_CHAT_MEDIA_DIR }).catch(
  (err: unknown) => {
    log.fatal({ err }, 'media worker not ready');
    process.exit(1);
  },
);
const worker = new MediaWorker({
  api: new HttpMediaJobsApi({
    baseUrl: config.KB_CHAT_MEDIA_API_URL,
    token: config.KB_CHAT_MEDIA_WORKER_TOKEN,
    worker: config.KB_CHAT_MEDIA_WORKER_NAME,
  }),
  bins,
  mediaDir: config.KB_CHAT_MEDIA_DIR,
  log,
  pollMs: config.KB_CHAT_MEDIA_POLL_MS,
  aliveFile: config.KB_CHAT_MEDIA_ALIVE_FILE,
});
const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => shutdown.abort());
// A job running at shutdown is stopped; its lease expires and it goes back to the queue.
await worker.run(shutdown.signal);

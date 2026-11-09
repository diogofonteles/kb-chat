import type { LocalTranscriberStart } from '@kb-chat/contracts';

/** Starts the transcriber's service on this same Mac (KBC-114 BR-10; development only). */
export interface LocalTranscriberPort {
  /** "Ligar transcritor": starts it, or restarts it when it runs (`kickstart -k`). */
  start(): Promise<LocalTranscriberStart>;
  /** Starts it only when it does not run (`kickstart`): a job in hand is never killed. */
  wake(): Promise<LocalTranscriberStart>;
}

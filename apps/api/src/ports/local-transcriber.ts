import type { LocalTranscriberStart } from '@kb-chat/contracts';

/** Starts the transcriber's service on this same Mac (KBC-114 BR-10; development only). */
export interface LocalTranscriberPort {
  start(): Promise<LocalTranscriberStart>;
}

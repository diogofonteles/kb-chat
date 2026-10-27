import type { Lendable } from '@kb-chat/contracts';

/** Both of the owner's subscriptions ready to lend (KBC-024, KBC-027). */
export const LEND_ALL: Lendable = {
  'claude-subscription': true,
  'chatgpt-subscription': true,
};

/** Neither ready on the server. */
export const LEND_NONE: Lendable = {
  'claude-subscription': false,
  'chatgpt-subscription': false,
};

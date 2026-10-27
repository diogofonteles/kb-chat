import { invitePresetSchema, type InvitePreset } from '@kb-chat/contracts';

/** Today's plain invitation as a preset (KBC-028): a member with "Buscar documentos". */
export const plainPreset = (): InvitePreset => invitePresetSchema.parse({});

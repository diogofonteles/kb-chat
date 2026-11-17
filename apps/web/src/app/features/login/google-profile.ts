import { z } from 'zod';

const profileSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
  picture: z.string().optional(),
});
export type GoogleProfile = z.infer<typeof profileSchema>;

/**
 * Who the Google account is, read from the ID token's payload to show it on the
 * not-invited screen (v2 · Auth: the account row). Display only: the API verifies the
 * token; anything unreadable gives null and the row is not shown.
 */
export function googleProfileOf(credential: string): GoogleProfile | null {
  const payload = credential.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const parsed = profileSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

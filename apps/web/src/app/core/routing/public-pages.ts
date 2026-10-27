/** Route of the privacy policy (KBC-016): Google's consent screen links to it. */
export const PRIVACY_PATH = 'privacidade';
/** Route of the public "how to use" guide (KBC-032). */
export const TUTORIAL_PATH = 'tutorial';

/** The pages anyone may open without a session; the shell shows them instead of the login. */
export type PublicPage = 'privacy' | 'tutorial';

const PUBLIC_PAGES: Readonly<Record<string, PublicPage>> = {
  [`/${PRIVACY_PATH}`]: 'privacy',
  [`/${TUTORIAL_PATH}`]: 'tutorial',
};

/** The public page a router URL ("/tutorial?x#y") shows, or null for a protected one. */
export const publicPageOf = (url: string): PublicPage | null =>
  PUBLIC_PAGES[url.split(/[?#]/)[0] ?? ''] ?? null;

/** Whether a router URL is a public page. */
export const isPublicUrl = (url: string): boolean => publicPageOf(url) !== null;

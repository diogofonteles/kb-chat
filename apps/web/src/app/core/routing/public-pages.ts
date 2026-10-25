/** Route of the privacy policy (KBC-016): Google's consent screen links to it. */
export const PRIVACY_PATH = 'privacidade';

/** Pages anyone may open without a session; the shell shows them instead of the login. */
const PUBLIC_PATHS: readonly string[] = [`/${PRIVACY_PATH}`];

/** Whether a router URL ("/privacidade?x#y") is a public page. */
export const isPublicUrl = (url: string): boolean =>
  PUBLIC_PATHS.includes(url.split(/[?#]/)[0] ?? '');

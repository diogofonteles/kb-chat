import { isYoutubeUrl } from '@kb-chat/contracts';

/** Where videos are searched: the only sites whose videos the app transcribes from a link. */
export const VIDEO_DOMAINS: readonly string[] = ['youtube.com', 'vimeo.com'];

const YOUTUBE_ID = /^[\w-]{11}$/;
const VIMEO_PATH = /^\/(\d+)\/?$/;
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com']);

function parsed(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const isVimeo = (url: URL): boolean =>
  url.hostname === 'vimeo.com' || url.hostname.endsWith('.vimeo.com');

/** An address of YouTube or Vimeo, a video or not: never a web page to read. */
export function isVideoSite(url: string): boolean {
  const address = parsed(url);
  return isYoutubeUrl(url) || (address !== null && isVimeo(address));
}

/** The id in `watch?v=`, `/shorts/` or `youtu.be/`. */
function youtubeIdOf(url: URL): string | null {
  const [, first = '', second = ''] = url.pathname.split('/');
  if (url.hostname.toLowerCase() === 'youtu.be') return first;
  if (first === 'watch') return url.searchParams.get('v');
  return first === 'shorts' ? second : null;
}

/**
 * The one address of a video (a YouTube watch, shorts or youtu.be page, a numeric Vimeo one),
 * without the time, the playlist or the tracking a search result carries; null for a channel,
 * a playlist or anything else.
 */
export function videoPageOf(url: string): string | null {
  const address = parsed(url);
  if (!address) return null;
  if (isYoutubeUrl(url)) {
    const id = youtubeIdOf(address);
    return id && YOUTUBE_ID.test(id)
      ? `https://www.youtube.com/watch?v=${id}`
      : null;
  }
  const vimeo = VIMEO_HOSTS.has(address.hostname)
    ? VIMEO_PATH.exec(address.pathname)
    : null;
  return vimeo ? `https://vimeo.com/${vimeo[1]}` : null;
}

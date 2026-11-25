import { hasAcceptedMediaExtension } from './media.js';

/* ---------- Links whose sound is transcribed, and lists of them (KBC-186) ---------- */

/** What a link is: one recording, a list of them (channel, playlist), or a page (null). */
export type RecordingLinkKind = 'recording' | 'list';

interface Site {
  readonly hosts: readonly string[];
  readonly kindOf: (url: URL) => RecordingLinkKind | null;
}

const path = (url: URL): string => url.pathname.replace(/\/+$/, '');
const matches = (url: URL, pattern: RegExp): boolean => pattern.test(path(url));

const YOUTUBE: Site = {
  hosts: ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
  kindOf: (url) => {
    if (url.hostname.endsWith('youtu.be'))
      return matches(url, /^\/[\w-]+$/) ? 'recording' : null;
    // A video inside a playlist is that video; the playlist's own address is the list.
    if (path(url) === '/watch')
      return url.searchParams.get('v') ? 'recording' : null;
    if (matches(url, /^\/(shorts|live|embed)\/[\w-]+$/)) return 'recording';
    if (path(url) === '/playlist')
      return url.searchParams.get('list') ? 'list' : null;
    return matches(
      url,
      /^\/(@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)(\/(videos|shorts|streams|podcasts|playlists))?$/,
    )
      ? 'list'
      : null;
  },
};

const VIMEO: Site = {
  hosts: ['vimeo.com'],
  kindOf: (url) => {
    if (matches(url, /^\/\d+(\/\w+)?$/)) return 'recording';
    return matches(url, /^\/(showcase\/\d+|channels\/[^/]+)$/) ? 'list' : null;
  },
};

const INSTAGRAM: Site = {
  hosts: ['instagram.com'],
  kindOf: (url) =>
    matches(url, /^(\/[^/]+)?\/(reel|reels|p|tv)\/[\w-]+$/)
      ? 'recording'
      : null,
};

const FACEBOOK: Site = {
  hosts: [
    'facebook.com',
    'm.facebook.com',
    'web.facebook.com',
    'pt-br.facebook.com',
    'fb.watch',
  ],
  kindOf: (url) => {
    if (url.hostname.endsWith('fb.watch'))
      return matches(url, /^\/[\w-]+$/) ? 'recording' : null;
    if (path(url) === '/watch')
      return url.searchParams.get('v') ? 'recording' : null;
    return matches(url, /^(\/[^/]+\/videos(\/[^/]+)?\/\d+|\/reel\/\d+)$/)
      ? 'recording'
      : null;
  },
};

const SOUNDCLOUD: Site = {
  hosts: ['soundcloud.com', 'm.soundcloud.com'],
  kindOf: (url) => {
    if (matches(url, /^\/[^/]+\/sets\/[^/]+$/)) return 'list';
    return matches(url, /^\/[^/]+\/(?!sets$)[^/]+$/) ? 'recording' : null;
  },
};

const APPLE_PODCASTS: Site = {
  hosts: ['podcasts.apple.com'],
  kindOf: (url) =>
    /\/podcast\//.test(url.pathname) && url.searchParams.get('i')
      ? 'recording'
      : null,
};

const SITES = [YOUTUBE, VIMEO, INSTAGRAM, FACEBOOK, SOUNDCLOUD, APPLE_PODCASTS];

const bareHost = (url: URL): string =>
  url.hostname.toLowerCase().replace(/^www\./, '');

/** One recording, a list of them, or null: a page (or not a link). */
export function recordingLinkKind(link: string): RecordingLinkKind | null {
  if (!URL.canParse(link)) return null;
  const url = new URL(link);
  const site = SITES.find(({ hosts }) => hosts.includes(bareHost(url)));
  if (site) return site.kindOf(url);
  // A file of sound or video on any site: the address of a podcast's episode, for one.
  return hasAcceptedMediaExtension(url.pathname) ? 'recording' : null;
}

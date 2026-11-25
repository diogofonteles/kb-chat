/* ---------- Links of audio and video the app takes as recordings (KBC-009 R6) ---------- */

export type MediaLinkKind = 'audio' | 'video';

export interface MediaLink {
  readonly kind: MediaLinkKind;
  /** The one address of the item, without what a search or a share adds to it. */
  readonly url: string;
}

const YOUTUBE_ID = /^[\w-]{11}$/;
const VIMEO_PATH = /^\/(\d+)\/?$/;
const ARCHIVE_PATH = /^\/details\/([^/@][^/]*)/;
/** Pages of SoundCloud that are no user's, and pages of a user that are no track. */
const SOUNDCLOUD_PLACES = new Set(
  'charts discover feed pages people popular search settings stream tags upload you'.split(
    ' ',
  ),
);
const SOUNDCLOUD_LISTS = new Set(
  'albums comments followers following likes popular-tracks reposts sets spotlight toptracks tracks'.split(
    ' ',
  ),
);

function parsedLink(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The host without the `www.` or the `m.` of a phone. */
const hostOf = (url: URL): string => url.hostname.replace(/^(www|m)\./, '');

/** The id in `watch?v=`, `/shorts/`, `/live/` or `youtu.be/`. */
function youtubeItem(url: URL): string | null {
  const [, first = '', second = ''] = url.pathname.split('/');
  const inPath = first === 'shorts' || first === 'live' ? second : null;
  const inQuery = first === 'watch' ? url.searchParams.get('v') : null;
  const id = hostOf(url) === 'youtu.be' ? first : (inPath ?? inQuery);
  return id && YOUTUBE_ID.test(id)
    ? `https://www.youtube.com/watch?v=${id}`
    : null;
}

function vimeoItem(url: URL): string | null {
  const id = VIMEO_PATH.exec(url.pathname)?.[1];
  return id ? `https://vimeo.com/${id}` : null;
}

function soundcloudItem(url: URL): string | null {
  const [user = '', track = '', ...rest] = url.pathname
    .split('/')
    .filter((part) => part !== '');
  const isTrack =
    track !== '' &&
    rest.length === 0 &&
    !SOUNDCLOUD_PLACES.has(user) &&
    !SOUNDCLOUD_LISTS.has(track);
  return isTrack ? `https://soundcloud.com/${user}/${track}` : null;
}

function archiveItem(url: URL): string | null {
  const id = ARCHIVE_PATH.exec(url.pathname)?.[1];
  return id ? `https://archive.org/details/${id}` : null;
}

function podcastEpisode(url: URL): string | null {
  const episode = url.searchParams.get('i');
  if (!episode || !/^\d+$/.test(episode)) return null;
  // The same episode has an address per country: one of them is its address here.
  const path = url.pathname.replace(/^\/[a-z]{2}\//, '/');
  return `https://podcasts.apple.com/br${path}?i=${episode}`;
}

/** How each site's item is read from an address; anything else there is no item. */
const SITES = new Map<
  string,
  { kind: MediaLinkKind; item: (url: URL) => string | null }
>([
  ['youtube.com', { kind: 'video', item: youtubeItem }],
  ['music.youtube.com', { kind: 'video', item: youtubeItem }],
  ['youtu.be', { kind: 'video', item: youtubeItem }],
  ['vimeo.com', { kind: 'video', item: vimeoItem }],
  ['soundcloud.com', { kind: 'audio', item: soundcloudItem }],
  ['archive.org', { kind: 'audio', item: archiveItem }],
  ['podcasts.apple.com', { kind: 'audio', item: podcastEpisode }],
]);

/**
 * The audio or the video an address is the page of: a YouTube watch, shorts or youtu.be page,
 * a numeric Vimeo one, a SoundCloud track, an Internet Archive item, an Apple Podcasts
 * episode. Null for a channel, a playlist, a profile or any other page.
 */
export function mediaLinkOf(url: string): MediaLink | null {
  const parsed = parsedLink(url);
  const site = parsed && SITES.get(hostOf(parsed));
  if (!parsed || !site) return null;
  const item = site.item(parsed);
  return item ? { kind: site.kind, url: item } : null;
}

export const mediaLinkKind = (url: string): MediaLinkKind | null =>
  mediaLinkOf(url)?.kind ?? null;

/** An address of one of those sites, an item or not: never a text to read. */
export function isMediaHost(url: string): boolean {
  const parsed = parsedLink(url);
  if (!parsed) return false;
  const host = hostOf(parsed);
  // A subdomain is the same site but the Internet Archive's (web.archive.org keeps pages).
  return [...SITES.keys()].some(
    (site) =>
      host === site || (site !== 'archive.org' && host.endsWith(`.${site}`)),
  );
}

/** What a link carries about who shared it, not about what it is. */
const TRACKING = /^(utm_\w+|fbclid|gclid|igsh|igshid|mc_cid|mc_eid|ref_src)$/i;
/** Marks of one site only: elsewhere they may be the page itself. */
const TRACKING_OF: readonly {
  readonly hosts: RegExp;
  readonly names: RegExp;
}[] = [
  { hosts: /(^|\.)(youtube\.com|youtu\.be)$/, names: /^(si|feature|pp)$/i },
  { hosts: /(^|\.)(spotify|soundcloud)\.com$/, names: /^(si|in)$/i },
];

const isTracking = (host: string, name: string): boolean =>
  TRACKING.test(name) ||
  TRACKING_OF.some(({ hosts, names }) => hosts.test(host) && names.test(name));

/** A page drawn by its fragment (`#/aula-2`, `#!x`) is another page; a place in one is not. */
const routeOf = (hash: string): string => (/^#[!/]/.test(hash) ? hash : '');

/** The one address of a recording, but the Archive's: its items hold many, by their path. */
function canonicalOf(link: string): string {
  const media = mediaLinkOf(link);
  return media && !media.url.startsWith('https://archive.org/')
    ? media.url
    : link;
}

/**
 * The same page, recording or file, whatever the scheme, the `www.`, the place in it, the
 * form of its address or who shared it: one key. A link that is no address is its own key.
 */
export function sameLinkKey(link: string): string {
  const url = parsedLink(canonicalOf(link));
  if (!url) return link;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const names = new Set(
    [...url.searchParams.keys()].filter((name) => !isTracking(host, name)),
  );
  const kept = [...names]
    .sort()
    .flatMap((name) =>
      url.searchParams.getAll(name).map((value) => `${name}=${value}`),
    );
  const port = url.port === '' ? '' : `:${url.port}`;
  const query = kept.length > 0 ? `?${kept.join('&')}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${host}${port}${path}${query}${routeOf(url.hash)}`;
}

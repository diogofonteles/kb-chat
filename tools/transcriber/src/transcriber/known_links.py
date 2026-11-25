"""The only addresses yt-dlp is given (KBC-186): a recording or a list of a known site.

An extractor of one site still goes where that site sends it, and some pages of these sites
forward to any address, this Mac's network included. So an address is written again from what
tells the recording (its path, its number), always over https, and one that is not a recording's
or a list's is never yt-dlp's. The app's own reading of a link is `recording-links.ts`.
"""

import re
import urllib.parse
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Site:
    hosts: frozenset[str]
    # A path that tells the recording by itself.
    paths: tuple[str, ...] = ()
    # A path and what it needs in the query: nothing else of the query is kept.
    asked: dict[str, dict[str, str]] = field(default_factory=dict)
    # A path that is asked for at another address.
    moved: dict[str, str] = field(default_factory=dict)

    def address_of(self, host: str, path: str, query: dict[str, str]) -> str | None:
        for one, where in self.moved.items():
            found = re.fullmatch(one, path)
            if found:
                secret = query.get("h", "")
                kept = f"?h={secret}" if "?" not in where and re.fullmatch(r"\w+", secret) else ""
                return found.expand(where) + kept
        for one, names in self.asked.items():
            for name, value in names.items():
                if re.fullmatch(one, path) and re.fullmatch(value, query.get(name, "")):
                    return f"https://{host}{path}?{name}={query[name]}"
        if any(re.fullmatch(one, path) for one in self.paths):
            return f"https://{host}{path}"
        return None


PART = r"/[^/]+"
ID = r"[\w-]+"
PLAYER = r"https://player.vimeo.com/video/\1"
FACEBOOK = frozenset({"facebook.com", "m.facebook.com", "web.facebook.com", "pt-br.facebook.com"})

SITES = (
    Site(
        frozenset({"youtube.com", "m.youtube.com", "music.youtube.com"}),
        (
            rf"/(shorts|live|embed)/{ID}",
            rf"/(@[^/]+|channel/{ID}|c{PART}|user{PART})"
            r"(/(videos|shorts|streams|podcasts|playlists))?",
        ),
        {"/watch": {"v": ID}, "/playlist": {"list": ID}},
    ),
    Site(frozenset({"youtu.be"}), (rf"/{ID}",)),
    # Vimeo gives its own pages to who has an account only; its player, to anyone.
    Site(
        frozenset({"vimeo.com"}),
        (rf"/(channels|showcase|album|groups){PART}",),
        moved={
            rf"(?:/(?:channels|showcase|album|groups){PART}(?:/videos?)?)?/(\d+)": PLAYER,
            r"/(\d+)/(\w+)": rf"{PLAYER}?h=\2",
        },
    ),
    Site(frozenset({"player.vimeo.com"}), (r"/video/\d+",), {r"/video/\d+": {"h": r"\w+"}}),
    Site(frozenset({"instagram.com"}), (rf"((?!/share/){PART})?/(reel|reels|p|tv)/{ID}",)),
    Site(
        FACEBOOK,
        (rf"{PART}/videos({PART})?/\d+", r"/reel/\d+"),
        {"/(watch|watch/live|video.php)": {"v": r"\d+"}},
    ),
    Site(
        frozenset({"soundcloud.com", "m.soundcloud.com"}),
        (rf"{PART}/sets{PART}({PART})?", rf"{PART}/(?!sets$)[^/]+({PART})?"),
    ),
    Site(
        frozenset({"api.soundcloud.com", "api-v2.soundcloud.com"}),
        (r"/tracks/\d+",),
        # A private track of a set.
        {r"/tracks/\d+": {"secret_token": ID}},
    ),
    Site(
        frozenset({"podcasts.apple.com"}),
        (),
        {rf"(/[A-Za-z]{{2}})?/podcast({PART}){{1,2}}": {"i": r"\d+"}},
    ),
    Site(frozenset({"archive.org"}), (r"/(details|embed)/[^/@].*",)),
)
# What a share button gives: it only says where the recording is.
SHORT = (
    (frozenset({"fb.watch"}), rf"/{ID}"),
    (FACEBOOK, rf"/share/(v|r)/{ID}"),
    (frozenset({"instagram.com"}), rf"/share/(reel|p)/{ID}"),
)


def _read(url: str) -> tuple[str, str, dict[str, str]]:
    try:
        parts = urllib.parse.urlsplit(url)
    # A broken address (`http://[x`) is no one's.
    except ValueError:
        return "", "", {}
    if parts.scheme not in ("http", "https"):
        return "", "", {}
    # Said twice, the first is the one, as the app reads it.
    query = dict(reversed(urllib.parse.parse_qsl(parts.query)))
    return parts.hostname or "", parts.path.rstrip("/"), query


def _bare(host: str) -> str:
    return host.removeprefix("www.")


def known_address(url: str) -> str | None:
    """The recording or the list `url` is, as it is asked for; None for any other address."""
    host, path, query = _read(url)
    # `.` and `..` are no names: a path with them is read again by whoever gets it.
    if any(part in (".", "..") for part in urllib.parse.unquote(path).split("/")):
        return None
    for site in SITES:
        if _bare(host) in site.hosts:
            return site.address_of(host, path, query)
    return None


def is_short(url: str) -> bool:
    """A share button's address: where it leads is the recording's."""
    host, path, _query = _read(url)
    return any(_bare(host) in hosts and re.fullmatch(one, path) for hosts, one in SHORT)

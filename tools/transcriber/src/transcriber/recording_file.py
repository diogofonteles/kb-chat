"""A recording that is a file on any site (a podcast's episode): fetched by this Mac itself.

The address is a person's, and this Mac sits in the owner's home network: only a public address
is ever connected to, each redirect is checked again, and the name is resolved once, so what
was checked is what is connected to. Known sites are yt-dlp's (`is_known_site`).
"""

import contextlib
import http.client
import ipaddress
import socket
import ssl
import threading
import urllib.parse
from collections.abc import Callable
from pathlib import Path

# Where yt-dlp is let loose: each with its own extractor.
KNOWN_SITES = (
    "youtube.com",
    "youtu.be",
    "vimeo.com",
    "instagram.com",
    "soundcloud.com",
    "podcasts.apple.com",
    "archive.org",
    "facebook.com",
    "fb.watch",
)
EXTENSIONS = frozenset(
    ["mp3", "m4a", "wav", "flac", "ogg", "opus", "mp4", "mov", "m4v", "webm", "mkv", "avi"],
)
MAX_BYTES = 2 * 1024**3
# A podcast's episode goes through the counters of its publisher first.
MAX_REDIRECTS = 10
TIMEOUT_S = 60
# The whole of it: a server that drips must not hold this Mac.
DEADLINE_S = 60 * 60
CHUNK = 1024 * 1024
PORTS = frozenset({80, 443})

Resolve = Callable[[str], list[str]]


class NotARecording(Exception):
    """The address is not public, or what is there is not a sound or video this app takes."""


class TooLarge(NotARecording):
    """The file passes what the app takes back."""


def is_known_site(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return any(host == site or host.endswith(f".{site}") for site in KNOWN_SITES)


def resolve(host: str) -> list[str]:
    try:
        found = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError as err:
        raise NotARecording(f"{host} was not found") from err
    return [str(entry[4][0]) for entry in found]


# An IPv4 address inside an IPv6 one (NAT64): it is the IPv4 one that is reached.
NAT64 = ipaddress.ip_network("64:ff9b::/96")


def is_public(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", maxsplit=1)[0])
    if isinstance(ip, ipaddress.IPv6Address):
        inside = ip.ipv4_mapped or ip.sixtofour
        if ip in NAT64:
            inside = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        if ip.is_site_local or (inside is not None and not is_public(str(inside))):
            return False
    return ip.is_global and not ip.is_multicast


class Deadline:
    """Ends the connection under way when the time of the whole fetch is over: a server may
    drip its headers or the sizes of its parts too, where no read of ours looks at the clock."""

    def __init__(self, seconds: float) -> None:
        self.passed = False
        self._sock: socket.socket | None = None
        self._timer = threading.Timer(seconds, self._end)
        self._timer.daemon = True

    def __enter__(self) -> "Deadline":
        self._timer.start()
        return self

    def __exit__(self, *_error: object) -> None:
        self._timer.cancel()

    def watch(self, sock: socket.socket) -> None:
        self._sock = sock
        if self.passed:
            self._end()

    def _end(self) -> None:
        self.passed = True
        if self._sock is not None:
            # Closed already, or not connected: there is nothing to end.
            with contextlib.suppress(OSError):
                self._sock.shutdown(socket.SHUT_RDWR)


def public_address(host: str, resolving: Resolve = resolve) -> str:
    """An address of `host` on the internet; one that answers with a private one is refused."""
    addresses = resolving(host)
    for address in addresses:
        if not is_public(address):
            raise NotARecording(f"{host} is not a public address")
    if not addresses:
        raise NotARecording(f"{host} was not found")
    return addresses[0]


def _connection(parts: urllib.parse.SplitResult, address: str) -> http.client.HTTPConnection:
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    if port not in PORTS:
        raise NotARecording(f"port {port} is not the web's")
    if parts.scheme == "https":
        context = ssl.create_default_context()
        connection = http.client.HTTPSConnection(host, port, timeout=TIMEOUT_S, context=context)
    else:
        connection = http.client.HTTPConnection(host, port, timeout=TIMEOUT_S)
    # The address that was checked, whatever the name answers now.
    connection._create_connection = (  # type: ignore[attr-defined]
        lambda _where, timeout=TIMEOUT_S, source=None: socket.create_connection(
            (address, port), timeout, source
        )
    )
    return connection


def _as_sent(header: str) -> str:
    """http.client reads a header as Latin-1: what was UTF-8 is read again as it was."""
    try:
        return header.encode("latin-1").decode("utf-8")
    except UnicodeError:
        return header


def _open(url: str, resolving: Resolve, deadline: Deadline) -> tuple[http.client.HTTPResponse, str]:
    for _hop in range(MAX_REDIRECTS):
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise NotARecording("not a web address")
        connection = _connection(parts, public_address(parts.hostname, resolving))
        # As typed, an address may have accents and spaces: the wire has none.
        path = urllib.parse.quote(parts.path or "/", safe="/%:@!$&'()*+,;=~-._")
        query = urllib.parse.quote(parts.query, safe="/%:@!$&'()*+,;=~-._?")
        target = urllib.parse.urlunsplit(("", "", path, query, ""))
        connection.connect()
        deadline.watch(connection.sock)
        connection.request("GET", target, headers={"User-Agent": "Mozilla/5.0", "Accept": "*/*"})
        response = connection.getresponse()
        if response.status not in (301, 302, 303, 307, 308):
            return response, url
        where = response.getheader("Location")
        response.close()
        if not where:
            raise NotARecording("a redirect to nowhere")
        url = urllib.parse.urljoin(url, _as_sent(where))
    raise NotARecording("too many redirects")


# What a file served with no name of its own is called.
BY_KIND = {
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
}
ANY_FILE = frozenset({"application/octet-stream", "binary/octet-stream"})


def _printable(name: str) -> str:
    return "".join(one for one in name if one.isprintable() and one not in "/\\")


def _name_of(url: str, first: str, kind: str) -> str:
    last = ""
    for address in (first, url):
        name = Path(urllib.parse.unquote(urllib.parse.urlsplit(address).path)).name
        name = _printable(name)
        if Path(name).suffix.lower().lstrip(".") in EXTENSIONS:
            return name[-120:]
        last = name or last
    if kind in BY_KIND:
        return f"{Path(last).stem[-100:] or 'gravacao'}.{BY_KIND[kind]}"
    raise NotARecording("not a sound or video file")


def fetch_file(
    url: str, folder: Path, resolving: Resolve = resolve, title: str | None = None
) -> Path:
    """The file at `url`, in `folder` (named `title`, when it is known); refused when it is not
    one, or is too large."""
    deadline = Deadline(DEADLINE_S)
    try:
        with deadline:
            found = _fetch(url, folder, resolving, deadline)
            # What ended early for the clock may look whole, or be refused for something else.
            if deadline.passed:
                raise NotARecording("the site took too long")
    # ValueError: an address http.client cannot take (a port out of range, a broken host).
    except (OSError, http.client.HTTPException, ValueError) as err:
        late = deadline.passed
        why = "the site took too long" if late else f"it could not be fetched: {err}"
        raise NotARecording(why) from err
    if not title:
        return found
    named = found.with_name(f"{_printable(title)[:120]}{found.suffix}")
    return found.rename(named)


def _fetch(url: str, folder: Path, resolving: Resolve, deadline: Deadline) -> Path:
    response, final = _open(url, resolving, deadline)
    with response:
        if response.status != 200:
            raise NotARecording(f"the site answered HTTP {response.status}")
        kind = (response.getheader("Content-Type") or "").split(";")[0].strip().lower()
        if not kind.startswith(("audio/", "video/")) and kind not in ANY_FILE:
            raise NotARecording(f"the address is {kind or 'of no kind'}, not a sound or video")
        target = folder / _name_of(final, url, kind)
        size = int(response.getheader("Content-Length") or 0)
        if size > MAX_BYTES:
            raise TooLarge("the file is larger than 2 GB")
        _copy(response, target, size, deadline)
    return target


def _copy(response: http.client.HTTPResponse, target: Path, size: int, deadline: Deadline) -> None:
    written = 0
    with target.open("wb") as out:
        while chunk := response.read1(CHUNK):
            written += len(chunk)
            if written > MAX_BYTES:
                raise TooLarge("the file is larger than 2 GB")
            out.write(chunk)
    if deadline.passed:
        raise NotARecording("the site took too long")
    # Cut half-way it would play, and enter as if it were the whole.
    if size and written != size:
        raise NotARecording(f"only {written} of {size} bytes came")
    if written == 0:
        raise NotARecording("the file is empty")

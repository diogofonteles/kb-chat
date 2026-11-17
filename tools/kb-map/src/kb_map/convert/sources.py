"""What a given input is: a local file of a known kind, a web link or a YouTube video."""

import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

KINDS_BY_EXTENSION = {
    ".pdf": "pdf",
    ".docx": "office",
    ".doc": "office",
    ".pptx": "office",
    ".ppt": "office",
    ".xlsx": "office",
    ".xls": "office",
    ".odt": "office",
    ".rtf": "office",
    ".epub": "epub",
    ".html": "html",
    ".htm": "html",
    ".csv": "data",
    ".json": "data",
    ".jsonl": "data",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".tif": "image",
    ".tiff": "image",
    ".webp": "image",
    ".bmp": "image",
    ".txt": "text",
    ".md": "text",
    ".markdown": "text",
}
YOUTUBE_HOSTS = frozenset(
    {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"}
)
URL = re.compile(r"^https?://", re.IGNORECASE)


class UnsupportedSource(Exception):
    """A file of a kind no converter takes, or a link that is not http(s)."""


@dataclass(frozen=True)
class Source:
    """One input: `kind` picks the converter; `path` for a file, `url` for a link."""

    kind: str
    name: str
    path: Path | None = None
    url: str | None = None

    @property
    def extension(self) -> str:
        return Path(self.name).suffix.lower()

    @property
    def is_link(self) -> bool:
        return self.url is not None


def is_youtube(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host in YOUTUBE_HOSTS


def source_of(given: str, name: str | None = None) -> Source:
    """A file path or an http(s) URL; `name` overrides the file's own (an upload's name)."""
    if URL.match(given):
        parts = urllib.parse.urlsplit(given)
        if not parts.hostname:
            raise UnsupportedSource(f"{given} is not a link")
        if is_youtube(given):
            raise UnsupportedSource(
                "YouTube goes through the transcriber as a media item, not through convert"
            )
        return Source("url", name or parts.hostname, url=given)
    path = Path(given).expanduser()
    if not path.is_file():
        raise UnsupportedSource(f"{given} is not a file")
    shown = name or path.name
    kind = KINDS_BY_EXTENSION.get(Path(shown).suffix.lower())
    if kind is None:
        raise UnsupportedSource(f"{shown}: no converter takes {Path(shown).suffix or 'this'}")
    return Source(kind, shown, path=path)

"""Links to Markdown: Firecrawl (the key kb already uses), Jina Reader as the alternative.

Keys come from the environment or the Mac's Keychain item `nova-alexandria-transcriber-kb`
(the variable's name as the account, as `transcriber keys set` stores them), read through
`security`'s stdout: never in argv, never printed, logged or written. Jina works without a key
(lower rate); with `JINA_API_KEY` it sends one. The page as fetched (its HTML) is the
original a link keeps (BR-1).
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..providers.keys import read_keychain
from .converters import Conversion, ConversionFailed
from .sources import Source

FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape"
JINA_ENDPOINT = "https://r.jina.ai/"
TIMEOUT_S = 120
FIRECRAWL_KEY = "FIRECRAWL_API_KEY"
JINA_KEY = "JINA_API_KEY"
API_VERSION = "v1"

Opener = Callable[[urllib.request.Request, float], Any]


def _open(request: urllib.request.Request, timeout: float) -> Any:
    return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 (fixed https URLs)


def key_of(name: str) -> str | None:
    return os.environ.get(name) or read_keychain(name)


def _fetch(opener: Opener, request: urllib.request.Request, who: str) -> bytes:
    try:
        with opener(request, TIMEOUT_S) as response:
            return response.read()
    except urllib.error.HTTPError as err:
        raise ConversionFailed(f"{who} answered HTTP {err.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        raise ConversionFailed(f"{who} could not be reached: {err}") from None


@dataclass
class FirecrawlConverter:
    key: Callable[[], str | None] = lambda: key_of(FIRECRAWL_KEY)
    opener: Opener = _open
    name: str = "firecrawl"

    def version(self) -> str:
        return API_VERSION

    def convert(self, source: Source) -> Conversion:
        if not source.url:
            raise ConversionFailed("firecrawl converts links only")
        key = self.key()
        if not key:
            raise ConversionFailed(f"no {FIRECRAWL_KEY} in the environment or the Keychain")
        body = json.dumps(
            {"url": source.url, "formats": ["markdown", "rawHtml"], "onlyMainContent": True}
        ).encode("utf-8")
        request = urllib.request.Request(FIRECRAWL_ENDPOINT, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Authorization", f"Bearer {key}")
        try:
            answer = json.loads(_fetch(self.opener, request, "Firecrawl").decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ConversionFailed("Firecrawl answered something that is not JSON") from None
        data = answer.get("data") if isinstance(answer, dict) else None
        if not answer.get("success") or not isinstance(data, dict):
            raise ConversionFailed(f"Firecrawl could not scrape: {str(answer.get('error'))[:200]}")
        markdown = str(data.get("markdown") or "").strip()
        if not markdown:
            raise ConversionFailed("Firecrawl returned an empty page")
        title = (data.get("metadata") or {}).get("title")
        html = str(data.get("rawHtml") or "")
        return Conversion(
            markdown + "\n",
            self.name,
            self.version(),
            title=str(title).strip() if title else None,
            original=(html or markdown).encode("utf-8"),
            original_name="page.html" if html else "page.txt",
        )


@dataclass
class JinaConverter:
    key: Callable[[], str | None] = lambda: key_of(JINA_KEY)
    opener: Opener = _open
    name: str = "jina"

    def version(self) -> str:
        return API_VERSION

    def _request(self, url: str, return_format: str) -> urllib.request.Request:
        # The fixed https endpoint with the link as its path; a non-http link never gets here.
        request = urllib.request.Request(JINA_ENDPOINT + url, method="GET")  # noqa: S310
        request.add_header("X-Return-Format", return_format)
        request.add_header("Accept", "text/plain")
        key = self.key()
        if key:
            request.add_header("Authorization", f"Bearer {key}")
        return request

    def convert(self, source: Source) -> Conversion:
        if not source.url:
            raise ConversionFailed("jina converts links only")
        markdown = _fetch(self.opener, self._request(source.url, "markdown"), "Jina").decode(
            "utf-8", errors="replace"
        )
        if not markdown.strip():
            raise ConversionFailed("Jina returned an empty page")
        html = _fetch(self.opener, self._request(source.url, "html"), "Jina")
        return Conversion(
            markdown.strip() + "\n",
            self.name,
            self.version(),
            title=None,
            original=html or markdown.encode("utf-8"),
            original_name="page.html" if html else "page.txt",
        )


def origin_of(url: str) -> str:
    """The site a link is from, for the document's name (`<origem>-<título>-<ano>`)."""
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host.removeprefix("www.")

"""What is left in the OpenRouter account kb spends from (KBC-009 BR-3), for the masters.

Asked with kb's own key, of OpenRouter alone, now and then and beside the status that tells it:
a Mac that cannot tell says nothing, and nothing here is ever logged.
"""

import http.client
import json
import math
import threading
import time
import urllib.request
from collections.abc import Callable

API = "https://openrouter.ai/api/v1"
TIMEOUT_S = 5
TTL_S = 10 * 60

Ask = Callable[[str], dict]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """The key goes to the one address it is for, never to where that one sends."""

    def redirect_request(self, *_args: object) -> None:
        return None


def ask_with(key: str) -> Ask:
    opener = urllib.request.build_opener(_NoRedirect)

    def ask(path: str) -> dict:
        headers = {"Authorization": f"Bearer {key}"}
        # API is an https address of ours to say.
        request = urllib.request.Request(f"{API}{path}", headers=headers)  # noqa: S310
        with opener.open(request, timeout=TIMEOUT_S) as response:
            return json.load(response)

    return ask


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def account_left(answer: dict) -> float | None:
    """The account's; a key that may not read the account is answered 403."""
    data = answer.get("data") or {}
    total, used = _number(data.get("total_credits")), _number(data.get("total_usage"))
    return None if total is None or used is None else total - used


def key_left(answer: dict) -> float | None:
    """What the key itself may still spend; None when it has no limit of its own."""
    return _number((answer.get("data") or {}).get("limit_remaining"))


class KbBalance:
    """The lowest of what the account and the key still have, as last read."""

    def __init__(
        self,
        key: Callable[[], str | None],
        asking: Callable[[str], Ask] = ask_with,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._key = key
        self._asking = asking
        self._now = now
        self._read_at: float | None = None
        self._left: float | None = None
        self._reading: threading.Thread | None = None

    def last(self) -> float | None:
        """What is known now; read again beside whoever asks, when it is old."""
        old = self._read_at is None or self._now() - self._read_at >= TTL_S
        if old and self._reading is None:
            self._read_at = self._now()
            self._reading = threading.Thread(target=self._read, daemon=True)
            self._reading.start()
        return self._left

    def wait(self) -> None:
        """The reading under way, if any, to its end."""
        reading = self._reading
        if reading is not None:
            reading.join()

    def _read(self) -> None:
        try:
            key = self._key()
            self._left = lowest_of(self._asking(key)) if key else None
        finally:
            self._reading = None


def lowest_of(ask: Ask) -> float | None:
    found = [_one(ask, "/credits", account_left), _one(ask, "/key", key_left)]
    known = [one for one in found if one is not None]
    return round(min(known), 4) if known else None


def _one(ask: Ask, path: str, left: Callable[[dict], float | None]) -> float | None:
    try:
        return left(ask(path))
    except (OSError, ValueError, AttributeError, http.client.HTTPException):
        return None

"""What is left in the OpenRouter account kb spends from (KBC-009 BR-3), for the masters.

Asked with kb's own key, of OpenRouter alone, now and then: a Mac that cannot tell says nothing,
and nothing here is ever logged.
"""

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable

API = "https://openrouter.ai/api/v1"
TIMEOUT_S = 5
TTL_S = 10 * 60

Ask = Callable[[str], dict]


def ask_with(key: str) -> Ask:
    def ask(path: str) -> dict:
        headers = {"Authorization": f"Bearer {key}"}
        # API is an https address of ours to say.
        request = urllib.request.Request(f"{API}{path}", headers=headers)  # noqa: S310
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:  # noqa: S310
            return json.load(response)

    return ask


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def account_left(answer: dict) -> float | None:
    data = answer.get("data") or {}
    total, used = _number(data.get("total_credits")), _number(data.get("total_usage"))
    return None if total is None or used is None else total - used


def key_left(answer: dict) -> float | None:
    """What the key itself may still spend; None when it has no limit of its own."""
    return _number((answer.get("data") or {}).get("limit_remaining"))


class KbBalance:
    """The lowest of what the account and the key still have, kept for a while."""

    def __init__(
        self, key: str | None, ask: Ask | None = None, now: Callable[[], float] = time.monotonic
    ) -> None:
        self._ask = ask or (ask_with(key) if key else None)
        self._now = now
        self._known: tuple[float, float | None] | None = None

    def read(self) -> float | None:
        if self._ask is None:
            return None
        if self._known is None or self._now() - self._known[0] >= TTL_S:
            self._known = (self._now(), self._left())
        return self._known[1]

    def _left(self) -> float | None:
        # A key may not be allowed to read the account: the other answer is enough.
        found = [self._one("/credits", account_left), self._one("/key", key_left)]
        known = [one for one in found if one is not None]
        return round(min(known), 4) if known else None

    def _one(self, path: str, left: Callable[[dict], float | None]) -> float | None:
        if self._ask is None:
            return None
        try:
            return left(self._ask(path))
        except (OSError, ValueError, AttributeError):
            return None

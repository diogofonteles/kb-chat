"""OpenRouter, with the cheap model kb already uses (kb.toml `[generation]`), the default.

The fallback model goes in OpenRouter's `models` list, so the router itself tries it when the
first one fails. The cost comes from the answer's `usage.cost` (usage accounting on), the same
number kb's receipts record. The key is read when the first call is made and lives only in
the request header.
"""

import json
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from . import ProviderError, Reply, Request

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
TIMEOUT_S = 300

Opener = Callable[[urllib.request.Request, float], Any]


def _open(request: urllib.request.Request, timeout: float) -> Any:
    return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 (fixed https URL)


class OpenRouterProvider:
    name = "openrouter"

    def __init__(
        self,
        model: str,
        fallback_model: str | None,
        key: Callable[[], str],
        opener: Opener = _open,
    ) -> None:
        self.model = model
        self.fallback_model = fallback_model
        self._key = key
        self._opener = opener

    def body(self, request: Request) -> dict[str, Any]:
        models = [self.model] + ([self.fallback_model] if self.fallback_model else [])
        return {
            "model": self.model,
            "models": models,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.prompt()},
            ],
            "max_tokens": request.max_tokens,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "usage": {"include": True},
        }

    def ask(self, request: Request) -> Reply:
        data = json.dumps(self.body(request)).encode("utf-8")
        http = urllib.request.Request(ENDPOINT, data=data, method="POST")
        http.add_header("Content-Type", "application/json")
        http.add_header("Authorization", f"Bearer {self._key()}")
        http.add_header("X-Title", "kb-map")
        try:
            with self._opener(http, TIMEOUT_S) as response:
                answer = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raise ProviderError(f"OpenRouter answered HTTP {err.code}: {_reason(err)}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise ProviderError(f"OpenRouter could not be reached: {err}") from None
        except json.JSONDecodeError:
            raise ProviderError("OpenRouter answered something that is not JSON") from None
        if answer.get("error"):
            raise ProviderError(f"OpenRouter error: {_message(answer['error'])}")
        try:
            text = answer["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise ProviderError("OpenRouter answered without a message") from None
        usage = answer.get("usage") or {}
        return Reply(text=text, usd=float(usage.get("cost") or 0.0), model=answer.get("model", ""))


def _message(error: Any) -> str:
    if isinstance(error, dict):
        return str(error.get("message", "unknown"))[:200]
    return str(error)[:200]


def _reason(err: urllib.error.HTTPError) -> str:
    try:
        return _message(json.loads(err.read().decode("utf-8")).get("error"))
    except (ValueError, AttributeError, OSError):
        return err.reason if isinstance(err.reason, str) else "no detail"

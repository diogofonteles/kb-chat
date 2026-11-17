"""Pluggable model providers (ADR 0039 §5) and the hard budget every call goes through.

A provider answers one `Request` with text; the `Ledger` is the only caller: it refuses a call
the budget cannot afford, charges what the provider reports, and parses the JSON answer. Every
step asks for JSON and validates it itself, so a provider never has to understand the map.
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

PROVIDER_NAMES = ("openrouter", "claude", "codex")
DEFAULT_PROVIDER = "openrouter"


@dataclass(frozen=True)
class Request:
    """One model call: `task` names the step (`sections`, `assign`, ...), `payload` its data."""

    task: str
    system: str
    instructions: str
    payload: dict[str, Any]
    max_tokens: int = 8000

    def prompt(self) -> str:
        data = json.dumps(self.payload, ensure_ascii=False, indent=1)
        return f"{self.instructions}\n\nINPUT (JSON):\n{data}\n\nAnswer with one JSON object only."


@dataclass(frozen=True)
class Reply:
    text: str
    usd: float
    model: str


class Provider(Protocol):
    name: str

    def ask(self, request: Request) -> Reply: ...


class ProviderError(Exception):
    """A call failed or answered something that is not JSON: never carries a secret."""


class BudgetExceeded(Exception):
    """The run reached `--max-usd`: the step stops cleanly and keeps what it saved."""


@dataclass
class Ledger:
    """Hard budget for one run. `max_usd=None` means no ceiling.

    Before a call it projects the call's cost from the cost per prompt character seen so far
    (with a 50 % margin) and refuses when the projection would cross the ceiling; after a call
    that crossed it anyway, nothing else is called. The first call has no price to project
    from, so a run can pass the ceiling by at most that one call.
    """

    provider: Provider
    max_usd: float | None = None
    spent_usd: float = 0.0
    calls: int = 0
    prompt_chars: int = 0
    models: set[str] = field(default_factory=set)

    def _projected(self, chars: int) -> float:
        if self.prompt_chars == 0:
            return 0.0
        return self.spent_usd / self.prompt_chars * chars * 1.5

    def ask_json(self, request: Request) -> dict[str, Any]:
        prompt_chars = len(request.prompt())
        if self.max_usd is not None:
            if self.spent_usd >= self.max_usd:
                raise BudgetExceeded(self._message())
            if self.spent_usd + self._projected(prompt_chars) > self.max_usd:
                raise BudgetExceeded(self._message())
        reply = self.provider.ask(request)
        self.calls += 1
        self.prompt_chars += prompt_chars
        self.spent_usd += max(reply.usd, 0.0)
        if reply.model:
            self.models.add(reply.model)
        return parse_json_object(reply.text)

    def _message(self) -> str:
        return (
            f"budget reached: US$ {self.spent_usd:.4f} spent of US$ {self.max_usd:.4f} "
            f"in {self.calls} calls; what was saved stays, run again to resume"
        )

    def summary(self) -> str:
        models = ", ".join(sorted(self.models)) or "-"
        return f"{self.calls} calls, US$ {self.spent_usd:.4f} ({self.provider.name}: {models})"


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


def parse_json_object(text: str) -> dict[str, Any]:
    """The JSON object in a reply, tolerating a Markdown fence or prose around it."""
    stripped = _FENCE.sub("", text.strip())
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError:
        start, end = stripped.find("{"), stripped.rfind("}")
        if start < 0 or end <= start:
            raise ProviderError("the model did not answer JSON") from None
        try:
            value = json.loads(stripped[start : end + 1])
        except json.JSONDecodeError as err:
            raise ProviderError(f"the model answered invalid JSON ({err.msg})") from None
    if not isinstance(value, dict):
        raise ProviderError("the model answered JSON that is not an object")
    return value


ProviderFactory = Callable[[], Provider]


def build_provider(name: str, kb_config: dict[str, Any], model: str | None = None) -> Provider:
    """The provider `--provider` names, configured from kb.toml (OpenRouter) or the CLI's own."""
    if name == "openrouter":
        from .keys import openrouter_key
        from .openrouter import OpenRouterProvider

        generation = kb_config.get("generation", {}) if isinstance(kb_config, dict) else {}
        chosen = model or generation.get("model")
        if not chosen:
            raise ProviderError("kb.toml has no [generation] model: pass --model")
        fallback = None if model else generation.get("fallback_model")
        return OpenRouterProvider(model=chosen, fallback_model=fallback, key=openrouter_key)
    if name in ("claude", "codex"):
        from .cli_agents import ClaudeCliProvider, CodexCliProvider

        return ClaudeCliProvider(model=model) if name == "claude" else CodexCliProvider(model=model)
    raise ProviderError(f"unknown provider {name!r} (one of {', '.join(PROVIDER_NAMES)})")

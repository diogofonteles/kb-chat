"""A scripted provider for tests: a handler per task turns the request payload into an answer.

Not selectable from the CLI. Every call is recorded, so a test can say "no call was made".
"""

import json
from collections.abc import Callable
from typing import Any

from . import Reply, Request

Handler = Callable[[Request], dict[str, Any] | str]


class FakeProvider:
    name = "fake"

    def __init__(self, handlers: dict[str, Handler], usd_per_call: float = 0.0) -> None:
        self.handlers = handlers
        self.usd_per_call = usd_per_call
        self.calls: list[Request] = []

    def ask(self, request: Request) -> Reply:
        self.calls.append(request)
        handler = self.handlers.get(request.task)
        if handler is None:
            raise AssertionError(f"the fake provider has no handler for {request.task!r}")
        answer = handler(request)
        text = answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)
        return Reply(text=text, usd=self.usd_per_call, model="fake-model")

    def tasks(self) -> list[str]:
        return [call.task for call in self.calls]

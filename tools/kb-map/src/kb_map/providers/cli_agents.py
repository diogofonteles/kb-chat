"""The owner's subscriptions through their CLIs: Claude Code (`claude -p`) and Codex (`codex exec`).

The prompt goes on stdin, never in argv; each run happens in an empty temporary folder so the
agent has no vault files around to wander into. Claude reports a cost (notional on a
subscription), which the ledger counts; Codex reports none, so `--max-usd` cannot bound it.
"""

import json
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

from . import ProviderError, Reply, Request

TIMEOUT_S = 900

Runner = Callable[..., subprocess.CompletedProcess[str]]


def _prompt(request: Request) -> str:
    return (
        f"{request.system}\n\nDo not use any tool. Read the input and answer.\n\n{request.prompt()}"
    )


class ClaudeCliProvider:
    name = "claude"

    def __init__(self, model: str | None = None, runner: Runner = subprocess.run) -> None:
        self.model = model
        self._run = runner

    def ask(self, request: Request) -> Reply:
        command = ["claude", "-p", "--output-format", "json"]
        if self.model:
            command += ["--model", self.model]
        with tempfile.TemporaryDirectory(prefix="kb-map-claude-") as empty:
            try:
                done = self._run(
                    command,
                    input=_prompt(request),
                    capture_output=True,
                    text=True,
                    check=False,
                    cwd=empty,
                    timeout=TIMEOUT_S,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired) as err:
                raise ProviderError(f"claude could not run: {err}") from None
        if done.returncode != 0:
            raise ProviderError(f"claude exited {done.returncode}: {done.stderr.strip()[:200]}")
        try:
            answer = json.loads(done.stdout)
        except json.JSONDecodeError:
            raise ProviderError("claude did not answer its JSON envelope") from None
        if answer.get("is_error"):
            raise ProviderError(f"claude failed: {str(answer.get('result', ''))[:200]}")
        return Reply(
            text=str(answer.get("result", "")),
            usd=float(answer.get("total_cost_usd") or 0.0),
            model=self.model or "claude",
        )


class CodexCliProvider:
    name = "codex"

    def __init__(self, model: str | None = None, runner: Runner = subprocess.run) -> None:
        self.model = model
        self._run = runner

    def ask(self, request: Request) -> Reply:
        with tempfile.TemporaryDirectory(prefix="kb-map-codex-") as empty:
            last = Path(empty) / "last-message.txt"
            command = [
                "codex",
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--output-last-message",
                str(last),
            ]
            if self.model:
                command += ["--model", self.model]
            command.append("-")
            try:
                done = self._run(
                    command,
                    input=_prompt(request),
                    capture_output=True,
                    text=True,
                    check=False,
                    cwd=empty,
                    timeout=TIMEOUT_S,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired) as err:
                raise ProviderError(f"codex could not run: {err}") from None
            if done.returncode != 0:
                raise ProviderError(f"codex exited {done.returncode}: {done.stderr.strip()[:200]}")
            text = last.read_text(encoding="utf-8") if last.exists() else done.stdout
        return Reply(text=text, usd=0.0, model=self.model or "codex")

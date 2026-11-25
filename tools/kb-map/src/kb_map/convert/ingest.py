"""`kb ingest file`, behind a port: kb names the document, judges it and links it (FR-1).

kb takes a body-only Markdown (a frontmatter in it would be read as body: verified on kb
0.0.12), titles the document from its first line, writes it under `<topic>/raw/articles/`
with its own frontmatter, and prints one JSON object on stdout: `filePath` (vault-relative),
`triage` (`kept`, `review`, `quarantined`, `duplicate-skipped`) and `duplicate_of`. kb-map then
adds the provenance keys to that frontmatter. Tests use a fake kb; the binary never runs there.
"""

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

INGEST_TIMEOUT_S = 30 * 60
OUTPUT_CHARS = 2_000


# kb's receipt: "decisions: N calls, N cache hits, US$ 0.0004", and the same for
# "generation:". The "budget: US$ … limit reached" line is the cap, never a spend.
_RECEIPT = re.compile(r"^(?:decisions|generation):.*US\$ (\d+(?:\.\d+)?)", re.MULTILINE)


def spend_of(output: str) -> float:
    """What kb says it spent in this run (the inclusion's ceiling counts it, KBC-009 R3)."""
    return sum(float(value) for value in _RECEIPT.findall(output))


class IngestFailed(Exception):
    """kb ingest exited with an error or printed no result: the message is kb's output."""

    def __init__(self, message: str, usd: float = 0.0) -> None:
        super().__init__(message)
        self.usd = usd


@dataclass(frozen=True)
class IngestResult:
    file_path: str  # vault-relative; "" when nothing was written
    triage: str
    duplicate_of: str | None = None
    reason: str | None = None
    output: str = ""
    usd: float = 0.0


class KbIngestPort(Protocol):
    def ingest_file(self, topic: str, path: Path, budget_usd: float | None) -> IngestResult: ...


def parse_result(stdout: str) -> dict:
    """The first JSON object kb printed (it may print receipts around it)."""
    start = stdout.find("{")
    while start >= 0:
        depth = 0
        for index in range(start, len(stdout)):
            char = stdout[index]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        value = json.loads(stdout[start : index + 1])
                    except json.JSONDecodeError:
                        break
                    if isinstance(value, dict) and "triage" in value:
                        return value
                    break
        start = stdout.find("{", start + 1)
    raise IngestFailed(f"kb ingest printed no result: {stdout[-OUTPUT_CHARS:]}")


@dataclass
class KbIngestCli:
    vault: Path
    binary: str = "kb"
    env: dict[str, str] = field(default_factory=dict, repr=False)

    def command(self, topic: str, path: Path, budget_usd: float | None) -> list[str]:
        command = [self.binary, "ingest", "file", str(path), "--topic", topic]
        if budget_usd is not None:
            command += ["--budget", f"{budget_usd:.4f}"]
        return command

    def ingest_file(self, topic: str, path: Path, budget_usd: float | None) -> IngestResult:
        done = subprocess.run(
            self.command(topic, path, budget_usd),
            cwd=self.vault,
            env={**os.environ, **self.env},
            capture_output=True,
            text=True,
            timeout=INGEST_TIMEOUT_S,
            check=False,
        )
        output = (done.stdout + done.stderr).strip()
        try:
            data = parse_result(done.stdout)
        except IngestFailed as err:
            if done.returncode == 0:
                raise IngestFailed(str(err), spend_of(output)) from err
            message = f"kb ingest: {output[-OUTPUT_CHARS:]}"
            raise IngestFailed(message, spend_of(output)) from err
        # kb writes the document before it judges and links it: an error after that leaves the
        # document in the collection, so it goes on with its keys (the steps that follow judge
        # and link it again).
        if done.returncode != 0 and not data.get("filePath"):
            raise IngestFailed(f"kb ingest: {output[-OUTPUT_CHARS:]}", spend_of(output))
        return IngestResult(
            file_path=str(data.get("filePath") or ""),
            triage=str(data.get("triage") or ""),
            duplicate_of=data.get("duplicate_of") or None,
            reason=data.get("triage_reason") or None,
            output=output[-OUTPUT_CHARS:],
            usd=spend_of(output),
        )

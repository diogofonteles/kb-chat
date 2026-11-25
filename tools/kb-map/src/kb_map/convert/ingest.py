"""`kb ingest file`, behind a port: kb names the document, judges it and links it (FR-1).

kb takes a body-only Markdown (a frontmatter in it would be read as body: verified on kb
0.0.12), titles the document from its first line, writes it under `<topic>/raw/articles/`
with its own frontmatter, and prints one JSON object on stdout: `filePath` (vault-relative),
`triage` (`kept`, `review`, `quarantined`, `duplicate-skipped`) and `duplicate_of`. kb-map then
adds the provenance keys to that frontmatter. Tests use a fake kb; the binary never runs there.
"""

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

INGEST_TIMEOUT_S = 30 * 60
OUTPUT_CHARS = 2_000


class IngestFailed(Exception):
    """kb ingest exited with an error or printed no result: the message is kb's output."""


@dataclass(frozen=True)
class IngestResult:
    file_path: str  # vault-relative; "" when nothing was written
    triage: str
    duplicate_of: str | None = None
    reason: str | None = None
    output: str = ""


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
        if done.returncode != 0:
            raise IngestFailed(f"kb ingest: {output[-OUTPUT_CHARS:]}")
        data = parse_result(done.stdout)
        return IngestResult(
            file_path=str(data.get("filePath") or ""),
            triage=str(data.get("triage") or ""),
            duplicate_of=data.get("duplicate_of") or None,
            reason=data.get("triage_reason") or None,
            output=output[-OUTPUT_CHARS:],
        )

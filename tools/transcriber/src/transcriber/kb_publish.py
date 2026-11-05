"""Track documents into the vault, through kb (KBC-099, ADR 0035 §3).

A kb-publish job carries the rendered Markdown of a collection's tracks. On this Mac, under a
lock in the vault, each file is written where the API said (`<vault>/<topic>/raw/media/…`),
then kb runs the same steps a text gets: `classify`, `link` and `index` for that topic, each
within the job's budget. kb is reached through `KbPort`, so tests use a fake kb and no model
is ever called by them; `KbCli` is the real binary.

The real kb's flags and receipts are pending the owner's spike on kb 0.0.12 (it spends on the
owner's key): until then `KbCli` follows ADR 0035 §3 as written. If kb does not classify a
file it did not ingest, the fallback is ADR 0035 option 5 (`kb ingest file --force`).
"""

import fcntl
import os
import re
import shutil
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

STEPS = ("classify", "link", "index")
LOCK_FILE = ".kb-chat-publish.lock"
# The end of kb's output is what tells why it failed; the API keeps 2,000 characters.
OUTPUT_CHARS = 2_000
# A step that hangs must not hold the lock (and the queue) for ever.
STEP_TIMEOUT_S = 30 * 60
FACET_KEYS = ("genre", "depth", "relevance", "summary")


@dataclass(frozen=True)
class KbRun:
    """What one kb step did: whether it exited 0, its output and what its receipts spent."""

    ok: bool
    output: str
    spend_usd: float = 0.0


class KbPort(Protocol):
    def run(self, step: str, topic: str, budget_usd: float) -> KbRun: ...


class KbStepFailed(Exception):
    """A kb step exited with an error: the job fails with kb's output (AC-4)."""

    def __init__(self, step: str, output: str) -> None:
        self.step = step
        self.output = f"kb {step}: {output}"[-OUTPUT_CHARS:]
        super().__init__(self.output)


class VaultBusy(Exception):
    """Another publication holds the vault's lock: the job goes back to the queue."""


class UnsafePath(Exception):
    """A document path that would land outside its collection's folder."""


# kb's receipts print the spend as "$0.0005" (to be confirmed by the spike on kb 0.0.12).
SPEND = re.compile(r"\$\s*([0-9]+(?:\.[0-9]+)?)")


@dataclass
class KbCli:
    """The real kb binary, run in the vault (ADR 0035 §3); never called by the tests."""

    vault: Path
    binary: str = "kb"

    def command(self, step: str, topic: str, budget_usd: float) -> list[str]:
        budget = ["--budget", f"{budget_usd:.4f}"]
        if step == "index":
            return [self.binary, "index", "--topic", topic, *budget]
        return [self.binary, step, topic, *budget]

    def run(self, step: str, topic: str, budget_usd: float) -> KbRun:
        done = subprocess.run(
            self.command(step, topic, budget_usd),
            cwd=self.vault,
            capture_output=True,
            text=True,
            timeout=STEP_TIMEOUT_S,
            check=False,
        )
        output = (done.stdout + done.stderr).strip()
        spend = sum(float(found) for found in SPEND.findall(output))
        return KbRun(ok=done.returncode == 0, output=output, spend_usd=spend)


def kb_or_none(vault: str | None) -> KbCli | None:
    """kb on this Mac when a vault is configured and the binary is on PATH; else None."""
    if not vault or not Path(vault).is_dir():
        return None
    binary = shutil.which("kb")
    return KbCli(Path(vault), binary) if binary else None


def _scalar(value: str) -> str | int | float:
    text = value.strip().strip('"').strip("'")
    for kind in (int, float):
        try:
            return kind(text)
        except ValueError:
            pass
    return text


def facets_of(markdown: str) -> dict:
    """The kb facets a document has now, read from its frontmatter (no YAML library here)."""
    match = re.match(r"^---\n(.*?)\n---\n", markdown, re.DOTALL)
    if not match:
        return {}
    facets: dict = {}
    lines = match.group(1).splitlines()
    for index, line in enumerate(lines):
        key, _, value = line.partition(":")
        if key in FACET_KEYS and value.strip():
            facets[key] = _scalar(value)
        elif key == "concepts":
            items = []
            for item in lines[index + 1 :]:
                if not item.startswith("  - ") and not item.startswith("- "):
                    break
                items.append(str(_scalar(item.split("- ", 1)[1])).strip("[]"))
            facets["concepts"] = items
    return facets


@dataclass
class KbPublisher:
    """Writes a job's documents and runs kb over their collection (ADR 0035 §3)."""

    vault: Path
    kb: KbPort

    def file_of(self, topic: str, path: str) -> Path:
        folder = (self.vault / topic).resolve()
        target = (folder / path).resolve()
        if not path.startswith("raw/media/") or folder not in target.parents:
            raise UnsafePath(f"{topic}/{path}")
        return target

    @contextmanager
    def locked(self) -> Iterator[None]:
        with open(self.vault / LOCK_FILE, "a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as err:
                raise VaultBusy("another publication holds the vault") from err
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def write(self, topic: str, items: list[dict]) -> list[Path]:
        files = []
        for item in items:
            target = self.file_of(topic, item["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_suffix(".md.partial")
            partial.write_text(item["markdown"], encoding="utf-8")
            os.replace(partial, target)
            files.append(target)
        return files

    def run_kb(self, topic: str, budget_usd: float) -> float:
        """classify, link, index in that order, each within what is left of the budget."""
        spent = 0.0
        for step in STEPS:
            run = self.kb.run(step, topic, max(0.0, budget_usd - spent))
            spent += run.spend_usd
            if not run.ok:
                raise KbStepFailed(step, run.output)
        return spent

    def publish(self, job: dict) -> dict:
        """The kb-result body; raises KbStepFailed with kb's output (the files stay)."""
        topic = job["topic"]
        with self.locked():
            files = self.write(topic, job["items"])
            spent = self.run_kb(topic, float(job["budgetUsd"]))
        share = round(spent / len(files), 6) if files else 0.0
        return {
            "documents": [
                {
                    "path": item["path"],
                    "ok": True,
                    "facets": facets_of(file.read_text(encoding="utf-8")),
                    "spendUsd": min(share, float(job["budgetUsd"])),
                }
                for item, file in zip(job["items"], files, strict=True)
            ]
        }

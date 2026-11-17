"""Documents and links sent from the app (KBC-149, ADR 0040): the Mac's doc-ingest job.

A doc-ingest job carries a file the app kept (fetched from the API), a web link, or a
YouTube link. Under the same vault lock as kb-publish:
- a file or a link goes through `kb-map convert` (KBC-148: Docling, MarkItDown, Firecrawl or
  Jina, the original kept, `kb ingest file`), then kb's steps (`classify`, `index`, `link`,
  `index`), then the collection map (`kb-map sections --doc`) when the collection has one;
  the API is told each step and the result (or why it failed, AC-4);
- a YouTube link has its audio downloaded here (`yt-dlp`) and given back to the API, where it
  becomes the sender's recording and takes the media path (transcription, tracks, kb-publish:
  KBC-142 BR-5).
kb-map, kb and yt-dlp are reached through ports, so tests run none of them.
"""

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .kb_publish import KbPublisher, KbStepFailed

# kb-map's project, next to this one in the repository (tools/kb-map).
KB_MAP_PROJECT = Path(__file__).resolve().parents[3] / "kb-map"
CONVERT_TIMEOUT_S = 60 * 60
MAP_TIMEOUT_S = 30 * 60
YOUTUBE_TIMEOUT_S = 60 * 60
OUTPUT_CHARS = 2_000
log = logging.getLogger("transcriber")


class DocIngestFailed(Exception):
    """The document cannot enter: `failure` is the API's code, `detail` the tool's words."""

    def __init__(self, failure: str, detail: str) -> None:
        super().__init__(detail)
        self.failure = failure
        self.detail = detail[-OUTPUT_CHARS:]


class LeaseLost(Exception):
    """The API answered 409 to a step: the job is no longer this Mac's; nothing more is sent."""


@dataclass(frozen=True)
class Converted:
    state: str  # "converted" | "duplicate"
    document: str  # topic-relative id
    title: str


class KbMapPort(Protocol):
    def convert(
        self, topic: str, source: str, *, name: str | None, source_path: str, budget_usd: float
    ) -> dict: ...

    def map_document(self, topic: str, doc_id: str, budget_usd: float) -> str: ...


class YoutubePort(Protocol):
    def download(self, url: str, folder: Path) -> Path: ...


def failure_of(outcome: dict) -> DocIngestFailed:
    """kb-map's failed or review outcome as the API's reason (AC-4)."""
    detail = str(outcome.get("detail") or outcome.get("state") or "conversion failed")
    if outcome.get("state") == "review":
        return DocIngestFailed("not-accepted", detail)
    if "empty or unreadable" in detail:
        return DocIngestFailed("empty", detail)
    return DocIngestFailed("conversion-failed", detail)


@dataclass
class KbMapCli:
    """`uv run --project tools/kb-map kb-map …` in the vault; never run by the tests."""

    vault: Path
    project: Path = KB_MAP_PROJECT
    uv: str = "uv"
    # The kb's AI keys (KBC-117): kb-map's own environment only, never an argument.
    env: dict[str, str] = field(default_factory=dict, repr=False)

    def _command(self, *args: str) -> list[str]:
        return [
            self.uv,
            "run",
            "--quiet",
            "--project",
            str(self.project),
            # The converters (Docling, MarkItDown): installed on the first run, then kept.
            "--extra",
            "convert",
            "kb-map",
            "--vault",
            str(self.vault),
            *args,
        ]

    def _run(self, command: list[str], timeout: float) -> subprocess.CompletedProcess:
        return subprocess.run(
            command,
            cwd=self.vault,
            env={**os.environ, **self.env},
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def convert(
        self, topic: str, source: str, *, name: str | None, source_path: str, budget_usd: float
    ) -> dict:
        args = ["convert", topic, source, "--json", "--source-path", source_path]
        args += ["--budget", f"{budget_usd:.4f}", "--max-usd", f"{budget_usd:.4f}"]
        if name:
            args += ["--name", name]
        done = self._run(self._command(*args), CONVERT_TIMEOUT_S)
        lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
        if not lines:
            output = (done.stdout + done.stderr).strip()
            raise DocIngestFailed("conversion-failed", f"kb-map convert: {output}")
        return json.loads(lines[-1])

    def map_document(self, topic: str, doc_id: str, budget_usd: float) -> str:
        args = ["sections", topic, "--doc", doc_id, "--max-usd", f"{budget_usd:.4f}"]
        done = self._run(self._command(*args), MAP_TIMEOUT_S)
        output = (done.stdout + done.stderr).strip()
        if done.returncode != 0:
            raise KbStepFailed("kb-map sections", output)
        return output


@dataclass
class YtDlp:
    """The audio of a YouTube link, as m4a, with `yt-dlp` on PATH; never run by the tests."""

    binary: str = "yt-dlp"

    def download(self, url: str, folder: Path) -> Path:
        template = str(folder / "youtube.%(id)s.%(ext)s")
        command = [self.binary, "--no-playlist", "-x", "--audio-format", "m4a"]
        command += ["-o", template, "--", url]
        done = subprocess.run(
            command, capture_output=True, text=True, timeout=YOUTUBE_TIMEOUT_S, check=False
        )
        found = sorted(folder.glob("youtube.*.m4a"))
        if done.returncode != 0 or not found:
            output = (done.stdout + done.stderr).strip()
            raise DocIngestFailed("conversion-failed", f"yt-dlp: {output}")
        return found[0]


def kb_map_or_none(vault: Path, env: dict[str, str] | None = None) -> KbMapCli | None:
    """kb-map on this Mac when uv and its project are here; else None (no doc-ingest)."""
    uv = shutil.which("uv")
    if not uv or not (KB_MAP_PROJECT / "pyproject.toml").is_file():
        return None
    return KbMapCli(vault, uv=uv, env=dict(env or {}))


def title_of(vault: Path, topic: str, doc_id: str) -> str:
    """The document's title as kb wrote it (for the app's link), else its file name."""
    path = vault / topic / doc_id
    try:
        head = path.read_text(encoding="utf-8")[:4096]
    except OSError:
        return Path(doc_id).stem
    for line in head.splitlines()[1:]:
        if line == "---":
            break
        if line.startswith("title:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'") or Path(doc_id).stem
    return Path(doc_id).stem


@dataclass
class DocIngester:
    """Runs one doc-ingest job's steps; `say` tells the API the step it is on."""

    publisher: KbPublisher
    kb_map: KbMapPort
    youtube: YoutubePort | None = None

    def convert(self, job: dict, source: str, name: str | None) -> Converted:
        topic = job["topic"]
        kind = job["source"]["kind"]
        origin = job["source"]["url"] if kind == "url" else f"upload/{name}"
        outcome = self.kb_map.convert(
            topic, source, name=name, source_path=origin, budget_usd=float(job["budgetUsd"])
        )
        if outcome.get("state") not in ("converted", "duplicate") or not outcome.get("document"):
            raise failure_of(outcome)
        document = str(outcome["document"])
        title = title_of(self.publisher.vault, topic, document)
        return Converted(outcome["state"], document, title)

    def finish(self, job: dict, converted: Converted, say) -> float:
        """kb's steps and the map, for a new document; what kb spent."""
        if converted.state == "duplicate":
            return 0.0
        topic = job["topic"]
        say("classifying")
        spent, _undecided, _unnamed = self.publisher.run_kb(topic, float(job["budgetUsd"]))
        if (self.publisher.vault / topic / "map").is_dir():
            say("mapping")
            left = max(0.0, float(job["budgetUsd"]) - spent)
            self.kb_map.map_document(topic, converted.document, left)
        return spent

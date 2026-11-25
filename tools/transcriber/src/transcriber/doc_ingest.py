"""Documents and links sent from the app (KBC-149, ADR 0040): the Mac's doc-ingest job.

A doc-ingest job carries a file the app kept (fetched from the API), a web link, or a
recording link. Under the same vault lock as kb-publish:
- a file or a link goes through `kb-map convert` (KBC-148: Docling, MarkItDown, Firecrawl or
  Jina, the original kept, `kb ingest file`), then kb's steps (`classify`, `index`, `link`,
  `index`), then the collection map (`kb-map sections --doc`) when the collection has one;
  the API is told each step and the result (or why it failed, AC-4);
- a recording link has its audio downloaded here (`yt-dlp`) and given back to the API, where it
  becomes the sender's recording and takes the media path (transcription, tracks, kb-publish:
  KBC-142 BR-5).
kb-map, kb and yt-dlp are reached through ports, so tests run none of them.
"""

import contextlib
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .kb_publish import KbPublisher, KbStepFailed
from .recording_file import NotARecording, TooLarge, fetch_file, is_known_site

# kb-map's project, next to this one in the repository (tools/kb-map).
KB_MAP_PROJECT = Path(__file__).resolve().parents[3] / "kb-map"
CONVERT_TIMEOUT_S = 60 * 60
MAP_TIMEOUT_S = 30 * 60
RECORDING_TIMEOUT_S = 60 * 60
LIST_TIMEOUT_S = 5 * 60
# The most of a channel or playlist the app offers (RECORDING_LIST_MAX in the contracts).
LIST_MAX = 5_000
OUTPUT_CHARS = 2_000
# How kb-map ends when its budget does.
BUDGET_EXIT = 3
# The app's limit for a document's title (uploadedDocumentRefSchema).
TITLE_CHARS = 500
# And for an entry of a list (recordingEntrySchema).
ENTRY_TITLE_CHARS = 300
URL_CHARS = 2_000
log = logging.getLogger("transcriber")


class DocIngestFailed(Exception):
    """The document cannot enter: `failure` is the API's code, `detail` the tool's words."""

    def __init__(self, failure: str, detail: str, spent: float = 0.0) -> None:
        super().__init__(detail)
        self.failure = failure
        self.detail = detail[-OUTPUT_CHARS:]
        # What the conversion spent before it failed: booked all the same (KBC-009 R3).
        self.spent = spent


class LeaseLost(Exception):
    """The API answered 409 to a step: the job is no longer this Mac's; nothing more is sent."""


@dataclass(frozen=True)
class Converted:
    state: str  # "converted" | "duplicate"
    document: str  # topic-relative id
    title: str
    # What converting (a vision description) and `kb ingest` spent.
    usd: float = 0.0
    # kb wrote it and put it in its own review queue.
    review: bool = False


class KbMapPort(Protocol):
    def convert(
        self,
        topic: str,
        source: str,
        *,
        name: str | None,
        source_path: str,
        budget_usd: float,
        upload_id: str,
    ) -> dict: ...

    def map_document(self, topic: str, doc_id: str, budget_usd: float) -> float:
        """The document's sections in the collection's map; what that spent."""
        ...


class RecordingPort(Protocol):
    def download(self, url: str, folder: Path) -> Path: ...

    def entries(self, url: str) -> list[dict]: ...


def failure_of(outcome: dict) -> DocIngestFailed:
    """kb-map's failed or refused outcome as the API's reason (AC-4)."""
    detail = str(outcome.get("detail") or outcome.get("state") or "conversion failed")
    spent = usd_of(outcome)
    if outcome.get("state") == "refused":
        return DocIngestFailed("not-accepted", detail, spent)
    if "empty or unreadable" in detail:
        return DocIngestFailed("empty", detail, spent)
    return DocIngestFailed("conversion-failed", detail, spent)


def usd_of(outcome: dict) -> float:
    """kb-map's own count of what the conversion spent; 0 when it says nothing."""
    usd = outcome.get("usd")
    return float(usd) if isinstance(usd, int | float) else 0.0


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
        return run_whole(command, timeout, cwd=self.vault, env={**os.environ, **self.env})

    def convert(
        self,
        topic: str,
        source: str,
        *,
        name: str | None,
        source_path: str,
        budget_usd: float,
        upload_id: str,
    ) -> dict:
        args = ["convert", topic, source, "--json", f"--source-path={source_path}"]
        args += ["--budget", f"{budget_usd:.4f}", "--max-usd", f"{budget_usd:.4f}"]
        args += ["--upload-id", upload_id]
        if name:
            # With "=": a name that starts with "-" is a name, not an option.
            args.append(f"--name={name}")
        done = self._run(self._command(*args), CONVERT_TIMEOUT_S)
        lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
        if not lines:
            output = (done.stdout + done.stderr).strip()
            # kb-map's exit 3: the budget ended before anything was made. It waits for more.
            if done.returncode == BUDGET_EXIT:
                raise KbStepFailed("kb-map convert", output)
            raise DocIngestFailed("conversion-failed", f"kb-map convert: {output}")
        return json.loads(lines[-1])

    def map_document(self, topic: str, doc_id: str, budget_usd: float) -> float:
        args = ["sections", topic, "--doc", doc_id, "--max-usd", f"{budget_usd:.4f}"]
        done = self._run(self._command(*args), MAP_TIMEOUT_S)
        spent = spent_in(done.stdout)
        if done.returncode != 0:
            output = (done.stdout + done.stderr).strip()
            raise KbStepFailed("kb-map sections", output, spent)
        return spent


def spent_in(output: str) -> float:
    """What `kb-map sections` says it spent, in its last JSON line; 0 when it says nothing."""
    for line in reversed(output.splitlines()):
        if not line.startswith("{"):
            continue
        try:
            spent = json.loads(line).get("spentUsd")
        except json.JSONDecodeError:
            continue
        return float(spent) if isinstance(spent, int | float) else 0.0
    return 0.0


def run_whole(
    command: list[str],
    timeout: float,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Runs a command in a group of its own; past the time, the whole group ends (uv starts
    kb-map, which starts kb: ending uv alone would leave the others writing the vault)."""
    with subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    ) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as err:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            # Trying again would take as long: it ends here, with why.
            raise DocIngestFailed(
                "conversion-failed", f"{Path(command[0]).name}: took more than {timeout:.0f} s"
            ) from err
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


# What a site answers for a moment, and the waits before asking again.
PASSING = re.compile(r"HTTP Error (403|429|5\d\d)|timed out|Connection reset", re.IGNORECASE)
DOWNLOAD_WAITS_S = (10, 30)


# yt-dlp's words for what it was told not to take.
LIVE = re.compile(r"does not pass filter|is_live|live event|Premieres in", re.IGNORECASE)
LARGE = re.compile(r"larger than max-filesize", re.IGNORECASE)


def refusal_of(output: str) -> str:
    if LARGE.search(output):
        return "too-large"
    return "live" if LIVE.search(output) else "conversion-failed"


def node_or_none() -> str | None:
    """Node on this Mac: on PATH (a LaunchAgent's has none of nvm's), else nvm's newest."""
    found = shutil.which("node")
    if found:
        return found
    versions = [
        path
        for path in (Path.home() / ".nvm" / "versions" / "node").glob("v*/bin/node")
        if os.access(path, os.X_OK)
    ]
    newest = max(versions, key=_version_of, default=None)
    return str(newest) if newest else None


def _version_of(node: Path) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", node.parent.parent.name))


@dataclass
class YtDlp:
    """The audio of a recording link, as m4a, and what a list holds, with `yt-dlp` on PATH;
    never run by the tests."""

    binary: str = "yt-dlp"
    # YouTube's player is a program: without something to run it some videos answer 403.
    node: str | None = None

    def _command(self, *args: str) -> list[str]:
        runtime = ["--js-runtimes", f"node:{self.node}"] if self.node else []
        return [self.binary, "--ignore-config", *runtime, *args]

    def download(self, url: str, folder: Path) -> Path:
        # Any other site is fetched by this Mac itself, never by yt-dlp (recording_file.py).
        if not is_known_site(url):
            try:
                return fetch_file(url, folder)
            except TooLarge as err:
                raise DocIngestFailed("too-large", str(err)) from err
            except NotARecording as err:
                raise DocIngestFailed("conversion-failed", str(err)) from err
        # Named after the recording: the app takes its title from the file's name.
        template = str(folder / "%(title).120B [%(id)s].%(ext)s")
        command = self._command("--no-playlist", "--playlist-items", "1")
        # A live stream never ends; a file larger than the app takes back is not fetched.
        command += ["--match-filter", "!is_live", "--max-filesize", "2G"]
        command += ["-x", "--audio-format", "m4a", "-o", template, "--", url]
        # A site refuses now and then what it gives a moment later (403, 429, a timeout).
        for wait in (*DOWNLOAD_WAITS_S, None):
            done = self._run(command, RECORDING_TIMEOUT_S)
            found = sorted(folder.glob("*.m4a"))
            if done.returncode == 0 and found:
                return found[0]
            output = (done.stdout + done.stderr).strip()
            if wait is None or not PASSING.search(output):
                raise DocIngestFailed(refusal_of(output), f"yt-dlp: {output}")
            log.warning("yt-dlp was refused, again in %d s", wait)
            time.sleep(wait)
        raise AssertionError("unreachable")

    def entries(self, url: str) -> list[dict]:
        if not is_known_site(url):
            raise DocIngestFailed("conversion-failed", "not a list of a known site")
        command = self._command("--flat-playlist", "-J")
        command += ["--playlist-end", str(LIST_MAX), "--", url]
        done = self._run(command, LIST_TIMEOUT_S)
        if done.returncode != 0:
            output = (done.stdout + done.stderr).strip()
            raise DocIngestFailed("conversion-failed", f"yt-dlp: {output}")
        return entries_of(json.loads(done.stdout))

    @staticmethod
    def _run(command: list[str], timeout: float) -> subprocess.CompletedProcess:
        return run_whole(command, timeout)


def cut(text: str, units: int) -> str:
    """The first `units` UTF-16 units, as the app counts them, never half a character."""
    return text.encode("utf-16-le")[: units * 2].decode("utf-16-le", errors="ignore")


def entries_of(listing: dict) -> list[dict]:
    """yt-dlp's listing as the app's entries: addresses with a title; a channel's tabs (lists
    inside the list) are opened one level, and what has no address is left out."""
    found: list[dict] = []
    for entry in listing.get("entries") or []:
        if not entry:
            continue
        if entry.get("_type") == "playlist":
            found += entries_of(entry)
            continue
        url = entry.get("webpage_url") or entry.get("url")
        if not isinstance(url, str) or not url.startswith(("https://", "http://")):
            continue
        # The app's limits: one entry it refuses would take the whole list with it.
        if len(url) > URL_CHARS:
            continue
        duration = entry.get("duration")
        found.append(
            {
                "url": url,
                "title": cut(str(entry.get("title") or "").strip() or url, ENTRY_TITLE_CHARS),
                "durationS": int(duration) if isinstance(duration, int | float) else None,
            }
        )
    return found[:LIST_MAX]


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
            title = line.split(":", 1)[1].strip().strip('"').strip("'")
            return cut(title or Path(doc_id).stem, TITLE_CHARS)
    return Path(doc_id).stem


@dataclass
class DocIngester:
    """Runs one doc-ingest job's steps; `say` tells the API the step it is on."""

    publisher: KbPublisher
    kb_map: KbMapPort
    recordings: RecordingPort | None = None

    def convert(self, job: dict, source: str, name: str | None) -> Converted:
        topic = job["topic"]
        kind = job["source"]["kind"]
        origin = job["source"]["url"] if kind == "url" else f"upload/{name}"
        outcome = self.kb_map.convert(
            topic,
            source,
            name=name,
            source_path=origin,
            budget_usd=float(job["budgetUsd"]),
            upload_id=str(job["id"]),
        )
        state = outcome.get("state")
        if state not in ("converted", "review", "duplicate") or not outcome.get("document"):
            raise failure_of(outcome)
        document = str(outcome["document"])
        title = title_of(self.publisher.vault, topic, document)
        # What this same upload wrote before a crash is not "already there": its steps go on.
        repeated = state == "duplicate" and not outcome.get("own")
        return Converted(
            "duplicate" if repeated else "converted",
            document,
            title,
            usd_of(outcome),
            review=state == "review",
        )

    def finish(self, job: dict, converted: Converted, say) -> float:
        """kb's steps and the map, for a new document; what the whole job spent."""
        if converted.state == "duplicate":
            return converted.usd
        topic = job["topic"]
        budget = float(job["budgetUsd"])
        say("classifying")
        try:
            spent, _undecided, _unnamed = self.publisher.run_kb(
                topic, max(0.0, budget - converted.usd)
            )
        except KbStepFailed as err:
            err.spent += converted.usd
            raise
        spent += converted.usd
        # A collection has a map once its tree was built (the owner's step): `map/` alone does
        # not say so, and this step is paid.
        left = max(0.0, budget - spent)
        if left > 0 and (self.publisher.vault / topic / "map" / "tree.json").is_file():
            say("mapping")
            try:
                spent += self.kb_map.map_document(topic, converted.document, left)
            except KbStepFailed as err:
                err.spent += spent
                raise
        # The API refuses more than the job's budget: kb may pass it by the last call's cents.
        return min(spent, budget)

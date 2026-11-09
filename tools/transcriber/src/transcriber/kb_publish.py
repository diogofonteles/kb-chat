"""Track documents into the vault, through kb (KBC-099, ADR 0035 §3).

A kb-publish job carries the rendered Markdown of a collection's tracks, and the documents to
take out of it (KBC-100: archived, deleted or moved). On this Mac, under a
lock in the vault, each file is written where the API said (`<vault>/<topic>/raw/media/…`,
never anywhere else), keeping the keys kb already wrote into it, then kb runs the steps a
text gets, over the whole topic: `classify`, `index`, `link`, `index`. kb is reached through
`KbPort`, so tests use a fake kb and no model is ever called by them; `KbCli` is the binary.

The flags and receipts below are the ones the owner's spike verified on kb 0.0.12
(2026-11-06): `--budget` exists on `classify` and `link` only (`kb index --topic <t>` is
local and refuses it); the spend is the `decisions:` and `generation:` receipt lines; a
budget reached leaves documents "undecided" with exit 0, which is reported as incomplete.
"""

import fcntl
import os
import re
import shutil
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

# index before link gives link its vector neighbours; the last index makes link's keys
# searchable (spike, item 7).
STEPS = ("classify", "index", "link", "index")
# Only these steps call a model, so only they take `--budget`.
BUDGETED = ("classify", "link")
LOCK_FILE = ".kb-chat-publish.lock"
# The end of kb's output is what tells why it failed; the API keeps 2,000 characters.
OUTPUT_CHARS = 2_000
# A step that hangs must not hold the lock (and the queue) for ever.
STEP_TIMEOUT_S = 30 * 60
FACET_KEYS = ("genre", "depth", "relevance", "summary")
# The frontmatter keys the app's renderer writes (track-document.ts `headerOf`, plus every
# `kb_chat_*`): on a rewrite they come from the new render; every other key is kb's and stays.
APP_KEYS = frozenset(
    {
        "title",
        "type",
        "stage",
        "source_kind",
        "source_path",
        "author_group",
        "author",
        "domain",
        "scraped",
        "tags",
    }
)
# A collection's vault folder, as the contract's topic slug (`hermetismo`, `a/b`).
TOPIC = re.compile(r"^[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)*\Z")
UNDECIDED_ERROR = "kb left it undecided (budget reached): re-run"


@dataclass(frozen=True)
class KbRun:
    """What one kb step did: whether it exited 0, its output and what its receipts spent."""

    ok: bool
    output: str
    spend_usd: float = 0.0


class KbPort(Protocol):
    def run(self, step: str, topic: str, budget_usd: float) -> KbRun: ...

    def new_topic(self, slug: str, title: str, domain: str) -> KbRun:
        """`kb topic new`: the collection's folder in the vault (KBC-114)."""
        ...


class KbStepFailed(Exception):
    """A kb step exited with an error: the job fails with kb's output (AC-4) and what kb
    spent on the way, so it is booked on the media ledger (ADR 0035 §11)."""

    def __init__(self, step: str, output: str, spent: float = 0.0) -> None:
        self.step = step
        self.spent = spent
        self.output = f"kb {step}: {output}"[-OUTPUT_CHARS:]
        super().__init__(self.output)


class VaultBusy(Exception):
    """Another publication holds the vault's lock: the job goes back to the queue."""


class UnsafePath(Exception):
    """A document path that would land outside its collection's folder."""


# kb 0.0.12's receipts: "decisions: 6 calls, 0 cache hits, US$ 0.0014" and the same for
# "generation:". The "budget: US$ 0.0003 limit reached" line is the cap, never a spend.
SPEND = re.compile(r"^(?:decisions|generation):.*?US\$\s*([0-9]+(?:\.[0-9]+)?)", re.MULTILINE)
UNDECIDED_DOCUMENTS = re.compile(r"^undecided documents \(\d+[^)]*\):(.*)$", re.MULTILINE)
UNDECIDED_COUNT = re.compile(r"^undecided:\s*[1-9]", re.MULTILINE)


def spend_of(output: str) -> float:
    """What one kb step spent, from its receipt lines."""
    return sum(float(found) for found in SPEND.findall(output))


def undecided_in(output: str) -> tuple[set[str], bool]:
    """The documents a step left undecided by name, and whether it left some unnamed."""
    named = {path for line in UNDECIDED_DOCUMENTS.findall(output) for path in line.split()}
    named = {path.strip(",;") for path in named}
    unnamed = bool(UNDECIDED_COUNT.search(output)) and not named
    return named, unnamed


@dataclass
class KbCli:
    """The real kb binary, run in the vault (ADR 0035 §3); never called by the tests."""

    vault: Path
    binary: str = "kb"
    _version: str | None = field(default=None, init=False, repr=False, compare=False)

    def command(self, step: str, topic: str, budget_usd: float) -> list[str]:
        if step not in BUDGETED:
            return [self.binary, step, "--topic", topic]
        return [self.binary, step, topic, "--budget", f"{budget_usd:.4f}"]

    def run(self, step: str, topic: str, budget_usd: float) -> KbRun:
        return self._run(self.command(step, topic, budget_usd))

    def topic_command(self, slug: str, title: str, domain: str) -> list[str]:
        """Each value its own argument: a title with spaces or a colon is never split."""
        # `--` ends kb's flags: a title that starts with "-" is still a title.
        return [self.binary, "topic", "new", "--", slug, title, domain]

    def new_topic(self, slug: str, title: str, domain: str) -> KbRun:
        """Scaffolds the folder (kb 0.0.12: local, spends nothing; refuses an existing one)."""
        return self._run(self.topic_command(slug, title, domain))

    def version(self) -> str | None:
        """`kb version`'s first line ("0.0.12 (commit=…)"), for the status; None if it fails."""
        if self._version is None:
            try:
                done = subprocess.run(
                    [self.binary, "version"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                return None
            lines = done.stdout.strip().splitlines()
            if done.returncode != 0 or not lines:
                return None
            self._version = lines[0][:100]
        return self._version

    def _run(self, command: list[str]) -> KbRun:
        done = subprocess.run(
            command,
            cwd=self.vault,
            capture_output=True,
            text=True,
            timeout=STEP_TIMEOUT_S,
            check=False,
        )
        output = (done.stdout + done.stderr).strip()
        spend = spend_of(output)
        return KbRun(ok=done.returncode == 0, output=output, spend_usd=spend)


def kb_or_none(vault: str | None) -> KbCli | None:
    """kb on this Mac when a vault is configured and the binary is on PATH; else None."""
    if not vault or not Path(vault).is_dir():
        return None
    binary = shutil.which("kb")
    return KbCli(Path(vault), binary) if binary else None


def _scalar(value: str) -> str | int | float:
    text = value.strip().strip('"').strip("'").strip()
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
                # kb indents its list items by 4 spaces; the app's YAML by 2.
                if not item.lstrip().startswith("- "):
                    break
                items.append(str(_scalar(item.lstrip()[2:])).strip("[]"))
            facets["concepts"] = items
    return facets


FRONTMATTER = re.compile(r"^---\n(.*?\n)---\n", re.DOTALL)
TOP_KEY = re.compile(r"^([A-Za-z_][\w-]*):")


def _blocks(header: str) -> list[tuple[str, str]]:
    """The top-level keys of a frontmatter, each with its lines verbatim (lists included)."""
    blocks: list[tuple[str, str]] = []
    for line in header.splitlines(keepends=True):
        key = TOP_KEY.match(line)
        if key:
            blocks.append((key.group(1), line))
        elif blocks:
            blocks[-1] = (blocks[-1][0], blocks[-1][1] + line)
    return blocks


def _is_apps(key: str) -> bool:
    return key in APP_KEYS or key.startswith("kb_chat_")


def keep_kb_keys(old: str, new: str) -> str:
    """The new render with the keys kb wrote into the old file (spike, item 5).

    kb classify and link skip a document whose body did not change, so a rewrite that only
    drops their keys would lose them for good; when the body changed, kb replaces them.
    """
    old_header, new_header = FRONTMATTER.match(old), FRONTMATTER.match(new)
    if not old_header or not new_header:
        return new
    present = {key for key, _ in _blocks(new_header.group(1))}
    kept = [
        text
        for key, text in _blocks(old_header.group(1))
        if key not in present and not _is_apps(key)
    ]
    if not kept:
        return new
    merged = new_header.group(1) + "".join(
        line if line.endswith("\n") else line + "\n" for line in kept
    )
    return f"---\n{merged}---\n{new[new_header.end() :]}"


@dataclass
class KbPublisher:
    """Writes a job's documents and runs kb over their collection (ADR 0035 §3)."""

    vault: Path
    kb: KbPort

    def file_of(self, topic: str, path: str) -> Path:
        """Where a document goes: inside `<vault>/<topic>/raw/media`, or nowhere."""
        if not TOPIC.match(topic):
            raise UnsafePath(f"{topic}/{path}")
        vault = self.vault.resolve()
        media = (vault / topic / "raw" / "media").resolve()
        target = (media.parent.parent / path).resolve()
        if vault not in media.parents or media not in target.parents:
            raise UnsafePath(f"{topic}/{path}")
        return target

    def busy(self) -> bool:
        """Whether another publication holds the vault now (the lock is let go at once)."""
        with open(self.vault / LOCK_FILE, "a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(lock, fcntl.LOCK_UN)
            return False

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
            if item.get("op", "write") != "write":
                continue
            target = self.file_of(topic, item["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            markdown = item["markdown"]
            if target.exists():
                markdown = keep_kb_keys(target.read_text(encoding="utf-8"), markdown)
            partial = target.with_suffix(".md.partial")
            partial.write_text(markdown, encoding="utf-8")
            os.replace(partial, target)
            files.append(target)
        return files

    def remove(self, topic: str, items: list[dict]) -> None:
        """Takes out the documents the API no longer wants (KBC-100 BR-2): an archived, deleted
        or moved track. A file already gone is fine; the recording's folder goes when empty."""
        for item in items:
            if item.get("op") != "remove":
                continue
            target = self.file_of(topic, item["path"])
            target.unlink(missing_ok=True)
            folder = target.parent
            if folder.is_dir() and not any(folder.iterdir()):
                folder.rmdir()

    def run_kb(self, topic: str, budget_usd: float) -> tuple[float, set[str], bool]:
        """The steps in order, classify and link within what is left of the budget.

        Returns the spend, the documents left undecided by name, and whether some were left
        undecided without a name (then every document of the job is incomplete).
        """
        spent = 0.0
        named: set[str] = set()
        unnamed = False
        for step in STEPS:
            run = self.kb.run(step, topic, max(0.0, budget_usd - spent))
            spent += run.spend_usd
            if not run.ok:
                raise KbStepFailed(step, run.output, spent)
            undecided, anonymous = undecided_in(run.output)
            named |= undecided
            unnamed = unnamed or anonymous
        return spent, named, unnamed

    def publish(self, job: dict) -> dict:
        """The kb-result body; raises KbStepFailed with kb's output (the files stay)."""
        topic = job["topic"]
        items = job["items"]
        writes = [item for item in items if item.get("op", "write") == "write"]
        # Checked before anything changes: one unsafe path refuses the whole job.
        for item in items:
            self.file_of(topic, item["path"])
        from .topic import ensure_topic

        with self.locked():
            # A collection created on the screen gets its folder first (KBC-114).
            ensure_topic(self.vault, topic, job.get("collection"), self.kb)
            written = self.write(topic, writes)
            files = dict(zip((item["path"] for item in writes), written, strict=True))
            self.remove(topic, items)
            # kb runs after a removal too: its index drops the file (spike, "Remoção").
            spent, undecided, unnamed = self.run_kb(topic, float(job["budgetUsd"]))
        # kb's spend goes to what it judged: the written documents (all, when none is).
        payers = len(files) or len(items)
        share = min(round(spent / payers, 6) if payers else 0.0, float(job["budgetUsd"]))
        documents = []
        for item in items:
            file = files.get(item["path"])
            if file is None:
                documents.append(
                    {"path": item["path"], "ok": True, "spendUsd": 0.0 if files else share}
                )
                continue
            document = {
                "path": item["path"],
                "ok": True,
                "facets": facets_of(file.read_text(encoding="utf-8")),
                "spendUsd": share,
            }
            if unnamed or item["path"] in undecided:
                document.update(ok=False, error=UNDECIDED_ERROR)
            documents.append(document)
        return {"documents": documents}

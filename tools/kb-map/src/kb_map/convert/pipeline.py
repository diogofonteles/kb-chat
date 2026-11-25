"""Convert one source into the topic (FR-1) and reconvert one existing document (FR-2).

Both share the rules: the original is stored first and never touched again (BR-1); a
conversion that is empty, unreadable or below 80 % of the current text replaces nothing and
goes to the review queue (BR-3); a reconversion changes only the body and the provenance keys
(BR-2); a description by a model is marked (BR-4).
"""

import shutil
import tempfile
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from ..layout import ReviewQueue, now
from ..textutil import fold, sha256_text
from ..vault import Topic, Vault, split_frontmatter, write_atomic
from .converters import Conversion, ConversionFailed, ConverterSet
from .ingest import IngestFailed, KbIngestPort
from .naming import heading_of, title_from_name
from .originals import ORIGINALS_DIR, sha256_file, store_bytes, store_file
from .provenance import replace_body, set_keys
from .quality import verdict
from .sources import KINDS_BY_EXTENSION, Source
from .web import origin_of

STAGE_DIR = ".kb-map/stage"
# Kinds a reconversion gains structure from; a plain .txt original stays as it is.
RECONVERTIBLE = frozenset({"pdf", "office", "epub", "html", "image"})
# The pipeline folders the vault's .txt conversions sit in (`_convert/ready/<origin>/…`).
CONVERT_PREFIXES = ("_convert/ready/", "_convert/ocr/", "_convert/")


@dataclass(frozen=True)
class Outcome:
    state: str
    source: str
    doc: str | None = None
    title: str | None = None
    detail: str = ""
    original: str | None = None
    usd: float = 0.0

    def as_json(self) -> dict:
        return {
            key: value
            for key, value in {
                "state": self.state,
                "source": self.source,
                "document": self.doc,
                "title": self.title,
                "detail": self.detail or None,
                "original": self.original,
                "usd": round(self.usd, 6),
            }.items()
            if value is not None
        }


@dataclass(frozen=True)
class Naming:
    title: str | None = None
    origin: str | None = None
    year: str | None = None
    source_path: str | None = None


def provenance(
    conversion: Conversion, sha256: str, name: str, source_path: str | None
) -> dict[str, object]:
    keys: dict[str, object] = {
        "original_sha256": sha256,
        "original_name": name,
        "converter": conversion.converter,
        "converter_version": conversion.version,
        "converted_at": now(),
    }
    if source_path is not None:
        keys["source_path"] = source_path
    if conversion.generated_description:
        keys["generated_description"] = True
    return keys


def _frontmatter_of(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        head = handle.read(8192)
    return split_frontmatter(head).data


def find_duplicate(topic: Topic, sha256: str | None, url: str | None) -> str | None:
    """A document of the topic made from the same original (or the same link): BR-3 of KBC-149."""
    for doc_id in topic.documents():
        data = _frontmatter_of(topic.dir / doc_id)
        if sha256 and data.get("original_sha256") == sha256:
            return doc_id
        if url and data.get("source_path") == url:
            return doc_id
    return None


def _vault_relative(vault: Vault, path: Path) -> str | None:
    try:
        return path.resolve().relative_to(vault.root).as_posix()
    except ValueError:
        return None


@dataclass
class Converting:
    vault: Vault
    topic: Topic
    converters: ConverterSet
    ingest: KbIngestPort
    queue: ReviewQueue
    budget_usd: float | None = None

    def convert(self, source: Source, naming: Naming) -> Outcome:
        shown = source.url or source.name
        sha = sha256_file(source.path) if source.path else None
        duplicate = find_duplicate(self.topic, sha, source.url)
        if duplicate:
            return Outcome("duplicate", shown, doc=duplicate, detail="already in the collection")
        try:
            conversion = self.converters.convert(source)
        except ConversionFailed as err:
            self.queue.put("convert", shown, source=shown, reason=str(err))
            return Outcome("failed", shown, detail=str(err))
        problem = verdict(conversion.markdown, None)
        if problem:
            self.queue.put("convert", shown, source=shown, reason=problem)
            return Outcome("failed", shown, detail=problem, usd=conversion.usd)
        if source.path is not None:
            sha, original = store_file(self.topic, source.path, source.name, sha)
            original_name = source.name
        else:
            data = conversion.original or conversion.markdown.encode("utf-8")
            original_name = conversion.original_name or "page.html"
            sha, original = store_bytes(self.topic, data, original_name)
        title = naming.title or conversion.title or title_from_name(source.name)
        origin = naming.origin or (origin_of(source.url) if source.url else None)
        heading = heading_of(title, origin, naming.year)
        source_path = naming.source_path or source.url
        if source_path is None and source.path is not None:
            source_path = _vault_relative(self.vault, source.path) or source.name
        keys = provenance(conversion, sha, original_name, source_path)
        return self._ingest(
            heading,
            conversion,
            keys,
            Outcome("converted", shown, title=heading, original=original, usd=conversion.usd),
        )

    def _ingest(
        self, heading: str, conversion: Conversion, keys: dict[str, object], outcome: Outcome
    ) -> Outcome:
        stage_root = self.vault.root / STAGE_DIR
        stage_root.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix="convert-", dir=stage_root))
        staged = stage / "document.md"
        staged.write_text(f"# {heading}\n\n{conversion.markdown}", encoding="utf-8")
        try:
            result = self.ingest.ingest_file(self.topic.slug, staged, self.budget_usd)
        except IngestFailed as err:
            self.queue.put("convert", outcome.source, source=outcome.source, reason=str(err))
            return _with(outcome, state="failed", detail=str(err), usd=outcome.usd + err.usd)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        outcome = _with(outcome, usd=outcome.usd + result.usd)
        if result.triage == "duplicate-skipped":
            return _with(
                outcome,
                state="duplicate",
                doc=result.duplicate_of,
                detail=result.reason or "kb found the same text",
            )
        if not result.file_path:
            self.queue.put("convert", outcome.source, source=outcome.source, reason=result.output)
            return _with(outcome, state="failed", detail=f"kb wrote nothing ({result.triage})")
        written = self.vault.root / result.file_path
        write_atomic(written, set_keys(written.read_text(encoding="utf-8"), keys))
        doc = written.resolve().relative_to(self.topic.dir.resolve()).as_posix()
        state = "converted" if result.triage == "kept" else "review"
        detail = "" if state == "converted" else f"kb triage: {result.triage}"
        self.queue.drop("convert", outcome.source)
        return _with(outcome, state=state, doc=doc, detail=detail)


def _with(outcome: Outcome, **changes) -> Outcome:
    return Outcome(**{**outcome.__dict__, **changes})


# ---- reconversion --------------------------------------------------------------------------


def original_names(source_path: str) -> tuple[str | None, list[str]]:
    """From a `.txt` conversion's `source_path`, the original's relative path and names to try.

    `_convert/ready/dropbox/Livros/O Dom Supremo.pdf.pdf.txt` → `Livros/O Dom Supremo.pdf.pdf`
    and the names `O Dom Supremo.pdf.pdf`, `O Dom Supremo.pdf`.
    """
    path = source_path.strip()
    if path.lower().endswith(".txt") and Path(path[:-4]).suffix.lower() in KINDS_BY_EXTENSION:
        path = path[:-4]
    relative = None
    for prefix in CONVERT_PREFIXES:
        if path.startswith(prefix):
            rest = path[len(prefix) :]
            # ready/<origin>/<path>: the origin folder is the pipeline's, not the original's.
            relative = rest.split("/", 1)[1] if "/" in rest and prefix != "_convert/" else rest
            break
    name = Path(path).name
    names = [name]
    stem = Path(name).stem
    if Path(stem).suffix.lower() == Path(name).suffix.lower() and Path(stem).suffix:
        names.append(stem)
    return relative, names


@dataclass
class OriginalFinder:
    """Finds a document's original in the folders it came from, by path, then by name."""

    vault: Vault
    dirs: list[Path]
    _by_name: dict[str, list[Path]] | None = field(default=None, init=False, repr=False)

    def _index(self) -> dict[str, list[Path]]:
        if self._by_name is None:
            index: dict[str, list[Path]] = {}
            for folder in self.dirs:
                if not folder.is_dir():
                    continue
                for path in folder.rglob("*"):
                    if path.is_file() and not path.name.startswith("."):
                        index.setdefault(_key(path.name), []).append(path)
            self._by_name = index
        return self._by_name

    def find(self, topic: Topic, data: dict) -> tuple[Path | None, str]:
        """The original's path, or None with why ("no-original", "ambiguous: …")."""
        kept = _kept_original(topic, str(data.get("original_sha256") or ""))
        if kept:
            return kept, ""
        source_path = str(data.get("source_path") or "")
        if not source_path:
            return None, "no source_path"
        direct = self.vault.root / source_path
        if not source_path.lower().endswith(".txt") and direct.is_file():
            return direct, ""
        relative, names = original_names(source_path)
        for folder in self.dirs:
            for candidate in _relatives(relative, names):
                if (folder / candidate).is_file():
                    return folder / candidate, ""
        return self._by_names(relative, names)

    def _by_names(self, relative: str | None, names: list[str]) -> tuple[Path | None, str]:
        matches: list[Path] = []
        for name in names:
            matches = self._index().get(_key(name), [])
            if matches:
                break
        if len(matches) == 1:
            return matches[0], ""
        if not matches:
            return None, "no-original"
        parent = Path(relative).parent.name if relative else ""
        near = [path for path in matches if parent and path.parent.name == parent]
        if len(near) == 1:
            return near[0], ""
        return None, f"ambiguous: {len(matches)} files named {names[0]}"


def _kept_original(topic: Topic, sha: str) -> Path | None:
    if len(sha) != 64:
        return None
    kept = sorted((topic.dir / "raw" / ORIGINALS_DIR).glob(f"{sha}.*"))
    return kept[0] if kept else None


def _key(name: str) -> str:
    return fold(unicodedata.normalize("NFC", name))


def _relatives(relative: str | None, names: list[str]) -> Iterable[str]:
    if not relative:
        return []
    parent = Path(relative).parent
    return [(parent / name).as_posix() for name in names]


@dataclass
class Reconverting:
    vault: Vault
    topic: Topic
    converters: ConverterSet
    finder: OriginalFinder
    queue: ReviewQueue
    retry: bool = False

    def candidate(self, doc_id: str) -> bool:
        """A source converted from a file outside `raw/media` (tracks are the transcriber's)."""
        return not doc_id.startswith("raw/media/")

    def plan(self, doc_id: str) -> tuple[str, Path | None, str]:
        """What a run would do with the document: (state, original, detail)."""
        data = _frontmatter_of(self.topic.dir / doc_id)
        original, why = self.finder.find(self.topic, data)
        if original is None:
            return ("no-original", None, why) if why != "no source_path" else ("skip", None, why)
        kind = KINDS_BY_EXTENSION.get(original.suffix.lower())
        if kind not in RECONVERTIBLE:
            return "skip", original, f"{original.suffix or 'no extension'}: nothing to gain"
        converter = self.converters.for_kind(kind)
        if data.get("converter") == converter.name and str(data.get("converter_version")) == str(
            converter.version()
        ):
            return "current", original, f"{converter.name} {converter.version()}"
        pending = next(
            (item for item in self.queue.items("reconvert") if item.get("doc") == doc_id), None
        )
        body_sha = sha256_text(self.topic.read(doc_id).body)
        if pending and pending.get("body_sha256") == body_sha and not self.retry:
            return "review", original, str(pending.get("reason") or "waiting for review")
        return "convert", original, converter.name

    def reconvert(self, doc_id: str, original: Path) -> Outcome:
        path = self.topic.dir / doc_id
        text = path.read_text(encoding="utf-8")
        current = self.topic.read(doc_id).body
        kind = KINDS_BY_EXTENSION[original.suffix.lower()]
        source = Source(kind, original.name, path=original)
        try:
            conversion = self.converters.convert(source)
        except ConversionFailed as err:
            return self._review(doc_id, current, str(err), 0.0)
        problem = verdict(conversion.markdown, current)
        if problem:
            return self._review(doc_id, current, problem, conversion.usd)
        sha, stored = store_file(self.topic, original, original.name)
        keys = provenance(conversion, sha, original.name, None)
        new_text = set_keys(replace_body(text, conversion.markdown), keys)
        write_atomic(path, new_text)
        self.queue.drop("reconvert", doc_id)
        return Outcome(
            "replaced",
            doc_id,
            doc=doc_id,
            original=stored,
            detail=conversion.converter,
            usd=conversion.usd,
        )

    def _review(self, doc_id: str, current: str, reason: str, usd: float) -> Outcome:
        self.queue.put(
            "reconvert", doc_id, doc=doc_id, reason=reason, body_sha256=sha256_text(current)
        )
        return Outcome("review", doc_id, doc=doc_id, detail=reason, usd=usd)


ConverterFactory = Callable[..., ConverterSet]

"""Where the map lives in a topic (ADR 0039) and the JSON store every step shares.

<topic>/map/                      machine layer, written only by kb-map, read-only for kb
  sections/<doc id>.json          sections of one source (KBC-139)
  tree.json                       subject tree and section assignments (KBC-140)
  owner-edits.json                the owner's fixed corrections (KBC-140 BR-3)
  tree-review.md                  the owner's readable review of the tree
  review-queue.json               documents and nodes waiting for a person
  dossiers/<node id>.json         exact section set and aspects per node (KBC-141)
  entities.json                   exact section set per entity page
  affects.json                    source -> wiki pages it supports
<topic>/index.md                  generated catalog of the compiled wiki
<topic>/log.md                    kb's append-only log (kb-map only appends entries)
<topic>/wiki/concepts/*.md        kb's stubs, filled by kb-map (only stubs or its own)
<topic>/wiki/subjects/*.md        subject articles (non-root nodes)
<topic>/wiki/entities/*.md        entity pages
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .vault import Topic, split_frontmatter, write_atomic

# Frontmatter key that marks a page kb-map wrote and may rewrite.
MARKER_KEY = "kb_map"
FORMAT_VERSION = 1


@dataclass(frozen=True)
class MapLayout:
    topic: Topic

    @property
    def root(self) -> Path:
        return self.topic.dir / "map"

    @property
    def sections_dir(self) -> Path:
        return self.root / "sections"

    def sections_file(self, doc_id: str) -> Path:
        return self.sections_dir / f"{doc_id}.json"

    @property
    def tree_file(self) -> Path:
        return self.root / "tree.json"

    @property
    def owner_edits_file(self) -> Path:
        return self.root / "owner-edits.json"

    @property
    def tree_review_file(self) -> Path:
        return self.root / "tree-review.md"

    @property
    def review_queue_file(self) -> Path:
        return self.root / "review-queue.json"

    @property
    def dossiers_dir(self) -> Path:
        return self.root / "dossiers"

    def dossier_file(self, node_id: str) -> Path:
        return self.dossiers_dir / f"{node_id}.json"

    @property
    def entities_file(self) -> Path:
        return self.root / "entities.json"

    @property
    def affects_file(self) -> Path:
        return self.root / "affects.json"

    @property
    def index_file(self) -> Path:
        return self.topic.dir / "index.md"

    @property
    def log_file(self) -> Path:
        return self.topic.dir / "log.md"

    @property
    def concepts_dir(self) -> Path:
        return self.topic.dir / "wiki" / "concepts"

    @property
    def subjects_dir(self) -> Path:
        return self.topic.dir / "wiki" / "subjects"

    @property
    def entities_dir(self) -> Path:
        return self.topic.dir / "wiki" / "entities"

    def has_map(self) -> bool:
        return self.root.is_dir()

    def section_docs(self) -> list[str]:
        """Doc ids that have a sections file."""
        if not self.sections_dir.is_dir():
            return []
        return sorted(
            path.relative_to(self.sections_dir).as_posix()[: -len(".json")]
            for path in self.sections_dir.rglob("*.md.json")
        )

    def owned_paths(self) -> list[str]:
        """Topic-relative paths kb-map owns: the sync holds them back when `check` fails."""
        owned = ["map/"]
        if is_generated(self.index_file):
            owned.append("index.md")
        wiki = self.topic.dir / "wiki"
        if wiki.is_dir():
            for page in sorted(wiki.rglob("*.md")):
                if is_generated(page):
                    owned.append(page.relative_to(self.topic.dir).as_posix())
        return owned


def is_generated(path: Path) -> bool:
    if not path.is_file():
        return False
    return MARKER_KEY in split_frontmatter(path.read_text(encoding="utf-8")).data


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, value: Any) -> None:
    write_atomic(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n")


def today() -> str:
    """The owner's local date, as kb writes it in log.md and frontmatter."""
    return datetime.now().astimezone().date().isoformat()


def now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def convert_queue_file(root: Path, slug: str) -> Path:
    """What `kb-map convert` could not place, per topic, in kb's work area of the vault."""
    return root / "_convert" / "review" / f"{slug.replace('/', '__')}.json"


class ReviewQueue:
    """Items waiting for a person, keyed so the same problem is listed once."""

    def __init__(self, layout: MapLayout, path: Path | None = None) -> None:
        self._path = path or layout.review_queue_file
        self._items: dict[str, dict[str, Any]] = {
            item["key"]: item for item in read_json(self._path, default=[])
        }

    def put(self, kind: str, key: str, **details: Any) -> None:
        self._items[f"{kind}:{key}"] = {"key": f"{kind}:{key}", "kind": kind, "at": now()} | details

    def drop(self, kind: str, key: str) -> None:
        self._items.pop(f"{kind}:{key}", None)

    def items(self, kind: str | None = None) -> list[dict[str, Any]]:
        return [item for item in self._items.values() if kind is None or item["kind"] == kind]

    def save(self) -> None:
        if self._items or self._path.exists():
            write_json(self._path, sorted(self._items.values(), key=lambda item: item["key"]))

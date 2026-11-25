"""Reading the kb vault the way the API does (ADR 0003, ADR 0035), and writing only map files.

A document is a Markdown file under `<topic>/raw/` (never under `_quarantine`), keyed by its
topic-relative path, exactly like `FsVaultAdapter.listDocuments`. Its body is what follows the
YAML frontmatter, NFC-normalised, as `read_document` reads it, so a section's position is the
same number the research agent sees.
"""

import os
import re
import tempfile
import tomllib
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .textutil import sha256_text

FRONTMATTER = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?")
EXCLUDED_SEGMENT = "_quarantine"
# Kept originals (KBC-148) are never sources, whatever their extension.
ORIGINALS_SEGMENT = "_originals"


class VaultError(Exception):
    """The vault or the topic is not what the command needs: the message says what."""


@dataclass(frozen=True)
class Split:
    data: dict[str, Any]
    frontmatter: str
    body: str


def split_frontmatter(text: str) -> Split:
    match = FRONTMATTER.match(text)
    if not match:
        return Split({}, "", text)
    try:
        parsed = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        parsed = None
    data = parsed if isinstance(parsed, dict) else {}
    return Split(data, match.group(1), text[match.end() :])


@dataclass(frozen=True)
class Document:
    """One source of the topic: its id (topic-relative path), frontmatter and body."""

    id: str
    path: Path
    data: dict[str, Any]
    body: str

    @property
    def body_sha256(self) -> str:
        return sha256_text(self.body)

    @property
    def title(self) -> str:
        title = self.data.get("title")
        return str(title).strip() if title else Path(self.id).stem

    @property
    def author(self) -> str | None:
        author = self.data.get("author")
        return str(author).strip() if author else None

    @property
    def author_group(self) -> str | None:
        group = self.data.get("author_group")
        return str(group).strip() if group else None


@dataclass(frozen=True)
class Topic:
    vault: Path
    slug: str
    dir: Path
    title: str
    domain: str | None

    def documents(self) -> list[str]:
        """Every source id of the topic, sorted (the catalog's own order)."""
        raw = self.dir / "raw"
        if not raw.is_dir():
            return []
        ids = []
        for path in raw.rglob("*.md"):
            relative = path.relative_to(self.dir)
            if (
                EXCLUDED_SEGMENT in relative.parts
                or ORIGINALS_SEGMENT in relative.parts
                or path.is_symlink()
            ):
                continue
            ids.append(relative.as_posix())
        return sorted(ids)

    def read(self, doc_id: str) -> Document:
        path = self.resolve(doc_id)
        text = path.read_text(encoding="utf-8")
        split = split_frontmatter(text)
        return Document(doc_id, path, split.data, unicodedata.normalize("NFC", split.body))

    def resolve(self, relative: str) -> Path:
        """A topic-relative path that cannot step outside the topic folder."""
        path = (self.dir / relative).resolve()
        if not path.is_relative_to(self.dir.resolve()):
            raise VaultError(f"{relative} is outside the topic {self.slug}")
        return path

    def doc_id_of(self, given: str) -> str:
        """`--doc` accepts a topic-relative id, a vault-relative path or an absolute path."""
        candidate = Path(given)
        if not candidate.is_absolute():
            for base in (self.dir, self.vault, Path.cwd()):
                if (base / candidate).is_file():
                    candidate = base / candidate
                    break
        resolved = candidate.resolve()
        if not resolved.is_relative_to(self.dir.resolve()) or not resolved.is_file():
            raise VaultError(f"{given} is not a document of the topic {self.slug}")
        doc_id = resolved.relative_to(self.dir.resolve()).as_posix()
        if doc_id not in self.documents():
            raise VaultError(f"{given} is not a source under {self.slug}/raw/")
        return doc_id


@dataclass(frozen=True)
class Vault:
    root: Path

    @staticmethod
    def locate(given: str | None) -> "Vault":
        """`--vault`, else KB_VAULT, else the nearest folder with kb.toml above the cwd."""
        start = given or os.environ.get("KB_VAULT")
        if start:
            root = Path(start).expanduser().resolve()
            if not (root / "kb.toml").is_file():
                raise VaultError(f"{root} is not a kb vault (no kb.toml)")
            return Vault(root)
        for folder in (Path.cwd(), *Path.cwd().parents):
            if (folder / "kb.toml").is_file():
                return Vault(folder.resolve())
        raise VaultError("no kb vault found: pass --vault <dir> or set KB_VAULT")

    def topic(self, slug: str) -> Topic:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", slug):
            raise VaultError(f"{slug!r} is not a topic slug")
        folder = self.root / slug
        if not (folder / "topic.yaml").is_file():
            raise VaultError(f"{folder} is not a kb topic (no topic.yaml)")
        try:
            data = yaml.safe_load((folder / "topic.yaml").read_text(encoding="utf-8")) or {}
        except yaml.YAMLError:
            data = {}
        data = data if isinstance(data, dict) else {}
        domain = data.get("domain")
        return Topic(
            vault=self.root,
            slug=slug,
            dir=folder,
            title=str(data.get("title") or slug),
            domain=str(domain) if domain else None,
        )

    def kb_config(self) -> dict[str, Any]:
        try:
            return tomllib.loads((self.root / "kb.toml").read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as err:
            raise VaultError(f"kb.toml is not valid TOML: {err}") from err


def write_atomic(path: Path, text: str) -> None:
    """Writes through a temp file in the same folder, so a reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(text)
        Path(temp).replace(path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise

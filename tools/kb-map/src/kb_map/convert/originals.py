"""The kept originals (BR-1): `<topic>/raw/_originals/<sha256>.<ext>`, written once, never changed.

The Markdown points at its original by the hash. An original is never `.md`: everything under
`raw/` that ends in `.md` is a document for the catalog and kb, so a Markdown original is kept
as `.markdown`.
"""

import hashlib
import os
import shutil
import tempfile
from pathlib import Path

from ..vault import Topic

ORIGINALS_DIR = "_originals"
SAFE_EXTENSION = frozenset("abcdefghijklmnopqrstuvwxyz0123456789")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stored_extension(name: str) -> str:
    """The extension an original is kept with: lower case, letters and digits only."""
    ext = Path(name).suffix.lower().lstrip(".")
    ext = "".join(char for char in ext if char in SAFE_EXTENSION)[:10] or "bin"
    return "markdown" if ext == "md" else ext


def originals_dir(topic: Topic) -> Path:
    return topic.dir / "raw" / ORIGINALS_DIR


def original_relpath(sha256: str, name: str) -> str:
    """Topic-relative path of an original, as the API serves it ("Ver original")."""
    return f"raw/{ORIGINALS_DIR}/{sha256}.{stored_extension(name)}"


def store_file(topic: Topic, path: Path, name: str, sha256: str | None = None) -> tuple[str, str]:
    """Keeps a copy of `path` (once); returns its hash and topic-relative path."""
    digest = sha256 or sha256_file(path)
    relative = original_relpath(digest, name)
    target = topic.dir / relative
    if not target.exists():

        def copy(out) -> None:
            with path.open("rb") as source:
                shutil.copyfileobj(source, out, length=1024 * 1024)

        _copy_atomic(target, copy)
    return digest, relative


def store_bytes(topic: Topic, data: bytes, name: str) -> tuple[str, str]:
    digest = sha256_bytes(data)
    relative = original_relpath(digest, name)
    target = topic.dir / relative
    if not target.exists():
        _copy_atomic(target, lambda out: out.write(data))
    return digest, relative


def _copy_atomic(target: Path, write) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(handle, "wb") as out:
            write(out)
        # Read-only: an original is evidence, never edited in place.
        Path(temp).chmod(0o444)
        Path(temp).replace(target)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise

"""Writing compiled wiki pages without taking anything from kb or the owner (ADR 0039 §3).

- A new page (subject, entity, index) is created with kb's article keys (`title`, `type`,
  `stage`, `domain`, `tags`, `created`, `updated`, `sources`) plus `kb_map` keys.
- An existing page is rewritten only when it is kb's untouched stub (`stage: stub`) or a page
  kb-map wrote (`kb_map` key). Only the keys kb-map owns are replaced, line by line; every other
  frontmatter line (kb's `criterion`, `aliases`, relations, the owner's keys) stays as it is.
- Any other page is never touched: the write is refused and reported.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .layout import FORMAT_VERSION, MARKER_KEY, MapLayout, today
from .sectionsdb import SectionRef
from .vault import split_frontmatter, write_atomic

OWNED_KEYS = ("stage", "updated", "sources", MARKER_KEY, "kb_map_node", "kb_map_entity")
COMPILED_STAGE = "compiled"
GENERATED_NOTE = (
    "<!-- kb-map: compiled from the collection map (ADR 0039). Edits here are overwritten; "
    "correct the tree with `kb-map tree apply` instead. -->"
)
_UNSAFE = re.compile(r'[/\\:*?"<>|#^\[\]]')
_TOP_KEY = re.compile(r"^([A-Za-z_][\w-]*):")


def page_file_name(title: str) -> str:
    return (_UNSAFE.sub(" ", title).strip() or "sem título")[:120] + ".md"


def link(title: str) -> str:
    return f"[[{_UNSAFE.sub(' ', title).strip()}]]"


def cite(ref: SectionRef) -> str:
    """A section as a wikilink to its source plus its place: `[[raw/x|Title]] §3 (12:04)`."""
    target = ref.doc[: -len(".md")] if ref.doc.endswith(".md") else ref.doc
    title = _UNSAFE.sub(" ", ref.doc_title).strip()
    return f"[[{target}|{title}]] {ref.label()}"


def source_link(doc: str) -> str:
    return f"[[{doc[: -len('.md')] if doc.endswith('.md') else doc}]]"


@dataclass(frozen=True)
class PageWrite:
    path: Path
    state: str  # "created" | "updated" | "unchanged" | "refused"
    reason: str = ""


def _dump(data: dict[str, Any]) -> str:
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=10_000)


def upsert_keys(frontmatter: str, values: dict[str, Any]) -> str:
    """Replaces (or appends) top-level keys, keeping every other line byte for byte."""
    lines = frontmatter.split("\n")
    blocks: list[tuple[str | None, list[str]]] = []
    for line in lines:
        match = _TOP_KEY.match(line)
        if match or not blocks:
            blocks.append((match.group(1) if match else None, [line]))
        else:
            blocks[-1][1].append(line)
    done = set()
    out: list[str] = []
    for key, block in blocks:
        if key in values:
            if key not in done:
                out.extend(_dump({key: values[key]}).rstrip("\n").split("\n"))
                done.add(key)
            continue
        out.extend(block)
    for key, value in values.items():
        if key not in done:
            out.extend(_dump({key: value}).rstrip("\n").split("\n"))
    return "\n".join(out).strip("\n")


def write_page(
    layout: MapLayout,
    path: Path,
    title: str,
    body: str,
    *,
    owned: dict[str, Any],
    new_keys: dict[str, Any] | None = None,
) -> PageWrite:
    owned = {"stage": COMPILED_STAGE, "updated": today(), **owned, MARKER_KEY: FORMAT_VERSION}
    full_body = f"# {title}\n\n{GENERATED_NOTE}\n\n{body.strip()}\n"
    if path.exists():
        text = path.read_text(encoding="utf-8")
        split = split_frontmatter(text)
        if MARKER_KEY not in split.data and split.data.get("stage") != "stub":
            return PageWrite(path, "refused", "not a kb stub nor a kb-map page")
        if split.data.get("locked") is True:
            return PageWrite(path, "refused", "locked: true")
        if split.body.strip() == full_body.strip() and _same(split.data, owned):
            return PageWrite(path, "unchanged")
        frontmatter = upsert_keys(split.frontmatter, owned)
        write_atomic(path, f"---\n{frontmatter}\n---\n{full_body}")
        return PageWrite(path, "updated")
    domain = layout.topic.domain
    data: dict[str, Any] = {
        "title": title,
        "type": "wiki",
        **({"domain": domain} if domain else {}),
        "tags": [t for t in (domain, "wiki", "kb-map") if t],
        "created": today(),
        **(new_keys or {}),
        **owned,
    }
    write_atomic(path, f"---\n{_dump(data)}---\n{full_body}")
    return PageWrite(path, "created")


def _same(current: dict[str, Any], owned: dict[str, Any]) -> bool:
    return all(current.get(k) == v for k, v in owned.items() if k != "updated")

"""Frontmatter keys set line by line: every key kb or the owner wrote stays byte for byte.

A document's frontmatter belongs to kb and the owner (`author_group`, `author`, relations,
facets). Conversion owns only the provenance keys below and the body (BR-2). Values are written
as YAML double-quoted scalars, so a name with a colon or a quote never breaks the header.
"""

import json
import re

PROVENANCE_KEYS = (
    "original_sha256",
    "original_name",
    "converter",
    "converter_version",
    "converted_at",
    "source_path",
    "generated_description",
)
FRONTMATTER = re.compile(r"^---\r?\n([\s\S]*?\r?\n)?---\r?\n?")
TOP_KEY = re.compile(r"^([A-Za-z_][\w-]*):")


def _scalar(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return json.dumps(str(value), ensure_ascii=False)


def _blocks(header: str) -> list[tuple[str | None, str]]:
    """Top-level keys of a frontmatter, each with its lines verbatim (lists included)."""
    blocks: list[tuple[str | None, str]] = []
    for line in header.splitlines(keepends=True):
        key = TOP_KEY.match(line)
        if key:
            blocks.append((key.group(1), line))
        elif blocks:
            blocks[-1] = (blocks[-1][0], blocks[-1][1] + line)
        else:
            blocks.append((None, line))
    return blocks


def set_keys(text: str, keys: dict[str, object]) -> str:
    """`text` with `keys` set in its frontmatter (replaced in place, or appended)."""
    match = FRONTMATTER.match(text)
    header = (match.group(1) or "") if match else ""
    body = text[match.end() :] if match else text
    pending = dict(keys)
    out: list[str] = []
    for key, lines in _blocks(header):
        if key in pending:
            value = pending.pop(key)
            if value is not None:
                out.append(f"{key}: {_scalar(value)}\n")
            continue
        out.append(lines if lines.endswith("\n") else lines + "\n")
    out.extend(f"{key}: {_scalar(value)}\n" for key, value in pending.items() if value is not None)
    return f"---\n{''.join(out)}---\n{body}"


def replace_body(text: str, body: str) -> str:
    """The same frontmatter, verbatim, over a new body."""
    match = FRONTMATTER.match(text)
    head = text[: match.end()] if match else ""
    if head and not head.endswith("\n"):
        head += "\n"
    return head + body

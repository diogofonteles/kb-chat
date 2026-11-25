"""The topic's `log.md`, kb's append-only record (LLM Wiki pattern): kb-map only appends.

Entries follow kb's own format, `## [YYYY-MM-DD] <op> | <short description>` and an optional
paragraph, so `grep "^## \\[" log.md` lists them with kb's. Ops: `map` (sections, tree,
corrections) and `compile` (dossiers and wiki pages), as the log's header lists.
"""

from .layout import MapLayout, today


def append_log(layout: MapLayout, op: str, description: str, details: str = "") -> None:
    path = layout.log_file
    entry = f"## [{today()}] {op} | {' '.join(description.split())}\n"
    if details.strip():
        entry += f"\n{details.strip()}\n"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# {layout.topic.title} — Log\n\n", encoding="utf-8")
    with path.open("rb") as existing:
        existing.seek(0, 2)
        size = existing.tell()
        ends_clean = True
        if size:
            existing.seek(-1, 2)
            ends_clean = existing.read(1) == b"\n"
    with path.open("a", encoding="utf-8") as out:
        out.write(("\n" if not ends_clean else "") + "\n" + entry)

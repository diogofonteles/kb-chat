"""The topic's `index.md` (LLM Wiki pattern): the catalog read first by the agent and the student.

Generated from the tree: one category per root (kb concept), one line per page with its
one-line description and how many sections and sources back it, children indented under
their parent; then the entity pages and what waits in the review queue. Written only when the
file does not exist or carries the `kb_map` key, like every page kb-map writes.
"""

from .layout import MapLayout, ReviewQueue, read_json
from .sectionsdb import SectionRef
from .tree import Tree
from .wiki import PageWrite, link, write_page


def render_index(
    layout: MapLayout,
    tree: Tree,
    titles: dict[str, tuple[str, str]],
    refs: dict[str, SectionRef],
    queue: ReviewQueue,
) -> str:
    entities = (read_json(layout.entities_file, default={}) or {}).get("entities", {})
    placed = len(tree.assignments)
    lines = [
        f"Catálogo do wiki compilado de {layout.topic.title}: {len(tree.nodes)} assuntos, "
        f"{placed} trechos no mapa, {len(entities)} páginas de entidades. "
        "Leia este índice primeiro; cada linha leva à página do assunto.",
        "",
    ]
    for root in tree.ordered():
        if root.parent is not None:
            continue
        lines += [f"## {titles[root.id][0]}", ""]
        for node_id in tree.descendants(root.id):
            node = tree.nodes[node_id]
            indent = "  " * (tree.depth(node_id))
            keys = tree.total(node_id)
            docs = {refs[k].doc for k in keys if k in refs}
            description = f" — {node.description}" if node.description else ""
            lines.append(
                f"{indent}- {link(titles[node_id][0])}{description} "
                f"({len(keys)} trechos, {len(docs)} fontes)"
            )
        lines.append("")
    if entities:
        lines += ["## Entidades", ""]
        for entity in sorted(entities.values(), key=lambda e: e["name"].casefold()):
            docs = {refs[k].doc for k in entity["sections"] if k in refs}
            lines.append(
                f"- {link(entity['name'])} ({len(entity['sections'])} trechos, {len(docs)} fontes)"
            )
        lines.append("")
    waiting = queue.items()
    if waiting:
        kinds: dict[str, int] = {}
        for item in waiting:
            kinds[item["kind"]] = kinds.get(item["kind"], 0) + 1
        summary = ", ".join(f"{count} {kind}" for kind, count in sorted(kinds.items()))
        lines += ["## Fila de revisão", "", f"{summary} (em `map/review-queue.json`).", ""]
    return "\n".join(lines)


def write_index(
    layout: MapLayout,
    tree: Tree,
    titles: dict[str, tuple[str, str]],
    refs: dict[str, SectionRef],
    queue: ReviewQueue,
) -> PageWrite:
    return write_page(
        layout,
        layout.index_file,
        f"{layout.topic.title} — Índice",
        render_index(layout, tree, titles, refs, queue),
        owned={},
        new_keys={"type": "index"},
    )

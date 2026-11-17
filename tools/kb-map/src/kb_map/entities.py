"""Entity pages (LLM Wiki pattern): Mestre Laércio, the other authors, works, figures, places.

Built from the sections alone, with no model call: an entity gets a page when it is a speaker
or appears in at least `min_mentions` sections. The page says what the collection says about
it, with each proposition cited, Mestre Laércio's apart from the other authors'. The exact
section set of each page goes to `map/entities.json`. `map/affects.json` then records, per
source, every page it supports, which is what a later `update` (KBC-142) recompiles.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .authorship import GROUP_LABELS, MAIN_GROUP, OTHERS_GROUP
from .layout import FORMAT_VERSION, MapLayout, now, read_json, write_json
from .sectionsdb import SectionRef
from .textutil import contains_folded, fold
from .tree import Tree
from .wiki import PageWrite, cite, link, page_file_name, source_link, write_page

MIN_MENTIONS = 3
MAX_LINES_PER_GROUP = 40


@dataclass
class Entity:
    key: str
    names: Counter = field(default_factory=Counter)
    sections: set[str] = field(default_factory=set)
    spoken: set[str] = field(default_factory=set)

    @property
    def name(self) -> str:
        return sorted(self.names.items(), key=lambda item: (-item[1], item[0]))[0][0]


def collect_entities(
    refs: dict[str, SectionRef], min_mentions: int, taken: set[str]
) -> list[Entity]:
    found: dict[str, Entity] = {}
    for ref in refs.values():
        for name in ref.entities:
            entity = found.setdefault(fold(name), Entity(fold(name)))
            entity.names[name] += 1
            entity.sections.add(ref.key)
        if ref.speaker:
            entity = found.setdefault(fold(ref.speaker), Entity(fold(ref.speaker)))
            entity.names[ref.speaker] += 1
            entity.spoken.add(ref.key)
            entity.sections.add(ref.key)
    return sorted(
        (
            e
            for e in found.values()
            if e.key not in taken and (e.spoken or len(e.sections) >= min_mentions)
        ),
        key=lambda e: fold(e.name),
    )


def render_entity(
    entity: Entity,
    refs: dict[str, SectionRef],
    tree: Tree,
    titles: dict[str, tuple[str, str]],
) -> str:
    keys = sorted(entity.sections)
    docs = sorted({refs[k].doc for k in keys})
    facts = [f"**Aparece em:** {len(keys)} trechos de {len(docs)} fontes"]
    if entity.spoken:
        facts.append(f"**Como autor da fala:** {len(entity.spoken)} trechos")
    subjects: Counter = Counter()
    for key in keys:
        assignment = tree.assignments.get(key)
        for node_id in assignment.nodes if assignment else []:
            subjects[node_id] += 1
    if subjects:
        facts.append(
            "**Assuntos:** "
            + " · ".join(
                f"{link(titles[n][0])} ({c})" for n, c in subjects.most_common() if n in titles
            )
        )
    lines = [f"{fact}  " for fact in facts] + ["", "## O que o acervo diz", ""]
    by_group: dict[str, list[str]] = defaultdict(list)
    for key in keys:
        ref = refs[key]
        for proposition in ref.propositions:
            about = contains_folded(fold(proposition["text"]), entity.name)
            said = fold(proposition.get("speaker", "")) == entity.key
            if about or said:
                group = proposition.get("group") or ref.group
                by_group[group].append(f"- {proposition['text']} — {cite(ref)}")
    for group in (MAIN_GROUP, OTHERS_GROUP):
        items = by_group.get(group) or []
        if items:
            lines += [f"### {GROUP_LABELS[group]}", "", *items[:MAX_LINES_PER_GROUP]]
            if len(items) > MAX_LINES_PER_GROUP:
                lines.append(f"- … e mais {len(items) - MAX_LINES_PER_GROUP} (ver os trechos)")
            lines.append("")
    lines += ["## Trechos", ""]
    lines += [f"- {cite(refs[k])} — {refs[k].context}" for k in keys]
    return "\n".join(lines)


def compile_entities(
    layout: MapLayout,
    refs: dict[str, SectionRef],
    tree: Tree,
    titles: dict[str, tuple[str, str]],
    min_mentions: int = MIN_MENTIONS,
) -> tuple[list[PageWrite], dict[str, dict]]:
    taken = {fold(title) for title, _ in titles.values()}
    pages: list[PageWrite] = []
    sidecar: dict[str, dict] = {}
    folder = layout.entities_dir.relative_to(layout.topic.dir).as_posix()
    for entity in collect_entities(refs, min_mentions, taken):
        page = f"{folder}/{page_file_name(entity.name)}"
        docs = sorted({refs[k].doc for k in entity.sections})
        write = write_page(
            layout,
            layout.topic.dir / page,
            entity.name,
            render_entity(entity, refs, tree, titles),
            owned={"sources": [source_link(d) for d in docs], "kb_map_entity": entity.key},
        )
        pages.append(write)
        if write.state != "refused":
            sidecar[entity.key] = {
                "name": entity.name,
                "page": page,
                "sections": sorted(entity.sections),
            }
    write_json(
        layout.entities_file, {"format": FORMAT_VERSION, "generated_at": now(), "entities": sidecar}
    )
    return pages, sidecar


def write_affects(
    layout: MapLayout,
    refs: dict[str, SectionRef],
    titles: dict[str, tuple[str, str]],
    entities: dict[str, dict],
) -> dict[str, list[str]]:
    """Per source, every wiki page it supports (the dossiers and entity pages citing it)."""
    affects: dict[str, set[str]] = defaultdict(set)
    for node_id, (_title, page) in titles.items():
        dossier = read_json(layout.dossier_file(node_id))
        for key in (dossier or {}).get("sections", []):
            if key in refs:
                affects[refs[key].doc].add(page)
    for entity in entities.values():
        for key in entity["sections"]:
            if key in refs:
                affects[refs[key].doc].add(entity["page"])
    result = {doc: sorted(pages) for doc, pages in sorted(affects.items())}
    write_json(
        layout.affects_file, {"format": FORMAT_VERSION, "generated_at": now(), "affects": result}
    )
    return result

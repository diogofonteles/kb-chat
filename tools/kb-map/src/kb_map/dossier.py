"""KBC-141: one dossier per node, written as a wiki article, with its exact set of sections.

The machine sidecar `map/dossiers/<node>.json` holds the node's exact section set and the
aspects; the article is its readable version. The rule (BR-1): the aspects cite exactly the
node's sections, not one less and not one more. The tool enforces it: citations of sections
outside the node are dropped, statements left without a citation are dropped (BR-2), and the
sections the model forgot are sent back once to be placed in an aspect before anything is
written (FR-1). Mestre Laércio's teaching and other authors' are kept apart (BR-3): a
statement is filed under the group of the sections it cites, and one that mixes both groups
is dropped (comparisons go to agreements and divergences).
"""

from dataclasses import dataclass, field
from typing import Any

from .authorship import GROUP_LABELS, MAIN_GROUP, OTHERS_GROUP
from .layout import FORMAT_VERSION, MapLayout, ReviewQueue, now, read_json, write_json
from .providers import Ledger, ProviderError, Request
from .sectionsdb import SectionRef, load_document_sections, load_sections
from .titles import page_titles
from .tree import Tree
from .wiki import PageWrite, cite, link, source_link, write_page

SYSTEM = (
    "You compile a study wiki from a collection of Hermetic and esoteric teachings in Brazilian "
    "Portuguese. Every sentence you write says only what the cited sections say."
)

DOSSIER_INSTRUCTIONS = """Write the dossier of one subject from ALL of its sections.

- Find the aspects of the subject (for example: definition, how it manifests, how to work with
  it, relation to other principles). Every section goes to at least one aspect: list its key in
  the aspect's `sections`, and mark the most important ones in `central`.
- For each aspect write short `statements`; each one cites the keys of the sections that say it
  (`cites`). Never cite a section that does not say it; never write without a citation.
- Keep the groups apart: a statement cites sections of one group only (`group` of each
  section: "mestre-laercio" or "outros-autores").
- `agreements` and `divergences`: where the authors agree or differ, each citing the sections.
- Write in Portuguese (pt-BR).

Answer: {"aspects": [{"name": str, "sections": [str], "central": [str],
"statements": [{"text": str, "cites": [str]}]}], "agreements": [{"text": str, "cites": [str]}],
"divergences": [{"text": str, "cites": [str]}]}"""

FILL_INSTRUCTIONS = """These sections of the subject were left out of its dossier. Place each
one in an aspect (one of `aspects`, or a new aspect name) and write the statements they add,
each citing the sections that say it. Write in Portuguese (pt-BR).

Answer: {"placements": [{"key": str, "aspect": str}],
"statements": [{"aspect": str, "text": str, "cites": [str]}]}"""


class DossierIncomplete(Exception):
    """The model left sections out twice: nothing is written for the node."""


@dataclass
class Aspect:
    name: str
    sections: set[str] = field(default_factory=set)
    central: set[str] = field(default_factory=set)
    statements: list[dict[str, Any]] = field(default_factory=list)


def _keys(value: Any, allowed: set[str]) -> list[str]:
    return [str(k) for k in value or [] if str(k) in allowed] if isinstance(value, list) else []


def _statement(raw: Any, allowed: set[str]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    text = " ".join(str(raw.get("text") or "").split())
    cites = sorted(set(_keys(raw.get("cites"), allowed)))
    return {"text": text, "cites": cites} if text and cites else None


def _statements(raw: Any, allowed: set[str]) -> list[dict[str, Any]]:
    items = raw if isinstance(raw, list) else []
    return [s for s in (_statement(item, allowed) for item in items) if s]


class DossierBuilder:
    def __init__(self, topic_layout: MapLayout, ledger: Ledger, refs: dict[str, SectionRef]):
        self.layout = topic_layout
        self.ledger = ledger
        self.refs = refs

    def build(self, tree: Tree, node_id: str) -> dict[str, Any]:
        node = tree.nodes[node_id]
        members = tree.confirmed(node_id)
        allowed = set(members)
        aspects: dict[str, Aspect] = {}
        agreements: list[dict[str, Any]] = []
        divergences: list[dict[str, Any]] = []
        if members:
            subject = {
                "name": node.name,
                "path": tree.path(node_id),
                "description": node.description,
                "criterion": node.criterion,
            }
            answer = self._ask(
                "dossier",
                DOSSIER_INSTRUCTIONS,
                {"subject": subject, "sections": [self.refs[k].brief() for k in members]},
            )
            for raw in answer.get("aspects") or []:
                if not isinstance(raw, dict) or not str(raw.get("name") or "").strip():
                    continue
                aspect = aspects.setdefault(
                    str(raw["name"]).strip(), Aspect(str(raw["name"]).strip())
                )
                aspect.sections.update(_keys(raw.get("sections"), allowed))
                aspect.central.update(_keys(raw.get("central"), allowed))
                for item in raw.get("statements") or []:
                    statement = _statement(item, allowed)
                    if statement:
                        aspect.statements.append(statement)
            agreements = _statements(answer.get("agreements"), allowed)
            divergences = _statements(answer.get("divergences"), allowed)
            missing = allowed - self._covered(aspects)
            if missing:
                self._fill(subject, aspects, sorted(missing), allowed)
            missing = allowed - self._covered(aspects)
            if missing:
                raise DossierIncomplete(
                    f"{len(missing)} sections left out twice: {', '.join(sorted(missing)[:5])}"
                )
        return self._assemble(
            tree,
            node_id=node_id,
            members=members,
            aspects=aspects,
            agreements=agreements,
            divergences=divergences,
        )

    def _ask(self, task: str, instructions: str, payload: dict[str, Any]) -> dict[str, Any]:
        problem = ""
        for _attempt in range(2):
            try:
                return self.ledger.ask_json(Request(task, SYSTEM, instructions, payload, 16000))
            except ProviderError as err:
                problem = str(err)
        raise DossierIncomplete(f"the model failed twice: {problem}")

    def _covered(self, aspects: dict[str, Aspect]) -> set[str]:
        """What the aspects will cite once mixed-group statements are dropped (BR-3)."""
        covered: set[str] = set()
        for aspect in aspects.values():
            covered |= aspect.sections
            for statement in aspect.statements:
                if self._group_of(statement["cites"]) is not None:
                    covered.update(statement["cites"])
        return covered

    def _fill(
        self,
        subject: dict[str, Any],
        aspects: dict[str, Aspect],
        missing: list[str],
        allowed: set[str],
    ) -> None:
        answer = self._ask(
            "dossier-fill",
            FILL_INSTRUCTIONS,
            {
                "subject": subject,
                "aspects": list(aspects),
                "sections": [self.refs[k].brief() for k in missing],
            },
        )
        for placement in answer.get("placements") or []:
            if not isinstance(placement, dict):
                continue
            key, name = str(placement.get("key")), str(placement.get("aspect") or "").strip()
            if key in allowed and name:
                aspects.setdefault(name, Aspect(name)).sections.add(key)
        for item in answer.get("statements") or []:
            statement = _statement(item, allowed)
            name = str(item.get("aspect") or "").strip() if isinstance(item, dict) else ""
            if statement and name:
                aspects.setdefault(name, Aspect(name)).statements.append(statement)

    def _group_of(self, cites: list[str]) -> str | None:
        groups = {self.refs[k].group for k in cites}
        return groups.pop() if len(groups) == 1 else None

    def _assemble(
        self,
        tree: Tree,
        *,
        node_id: str,
        members: list[str],
        aspects: dict[str, Aspect],
        agreements: list[dict[str, Any]],
        divergences: list[dict[str, Any]],
    ) -> dict[str, Any]:
        out_aspects = []
        dropped = 0
        for aspect in aspects.values():
            sections = set(aspect.sections)
            views: dict[str, list[dict[str, Any]]] = {MAIN_GROUP: [], OTHERS_GROUP: []}
            for statement in aspect.statements:
                group = self._group_of(statement["cites"])
                if group not in views:
                    dropped += 1
                    continue
                views[group].append(statement)
                sections.update(statement["cites"])
            if not sections:
                continue
            out_aspects.append(
                {
                    "name": aspect.name,
                    "sections": sorted(sections),
                    "central": sorted(aspect.central & sections),
                    "views": views,
                }
            )
        node = tree.nodes[node_id]
        docs = sorted({self.refs[k].doc for k in members})
        hashes = {}
        for doc in docs:
            data = load_document_sections(self.layout, doc) or {}
            hashes[doc] = data.get("body_sha256")
        return {
            "format": FORMAT_VERSION,
            "node": node_id,
            "name": node.name,
            "description": node.description,
            "generated_at": now(),
            "provider": self.ledger.provider.name,
            "sections": members,
            "source_hashes": hashes,
            "aspects": out_aspects,
            "agreements": agreements,
            "divergences": divergences,
            "dropped_mixed_statements": dropped,
        }


# ---- pages ---------------------------------------------------------------------------------


def _statement_line(statement: dict[str, Any], refs: dict[str, SectionRef]) -> str:
    cites = ", ".join(cite(refs[k]) for k in statement["cites"] if k in refs)
    return f"- {statement['text']} — {cites}"


def _facts(
    tree: Tree, node_id: str, dossier: dict[str, Any], refs: dict[str, SectionRef], titles: dict
) -> list[str]:
    node = tree.nodes[node_id]
    facts = []
    if node.synonyms:
        facts.append(f"**Sinônimos:** {', '.join(node.synonyms)}")
    if node.criterion:
        facts.append(f"**Critério:** {node.criterion}")
    if node.parent:
        facts.append(f"**Parte de:** {link(titles[node.parent][0])}")
    children = tree.children(node_id)
    if children:
        facts.append("**Subassuntos:** " + " · ".join(link(titles[c.id][0]) for c in children))
    members = dossier["sections"]
    docs = {refs[k].doc for k in members if k in refs}
    central = {k for aspect in dossier["aspects"] for k in aspect["central"]}
    facts.append(
        f"**Cobertura:** {len(members)} trechos de {len(docs)} fontes ({len(central)} centrais)"
    )
    waiting = tree.review_count(node_id)
    if waiting:
        facts.append(
            f"**A revisar:** {waiting} trechos ainda fora deste artigo (`map/tree-review.md`)"
        )
    return [f"{fact}  " for fact in facts]


def render_article(
    tree: Tree,
    node_id: str,
    dossier: dict[str, Any],
    refs: dict[str, SectionRef],
    titles: dict[str, tuple[str, str]],
) -> str:
    node = tree.nodes[node_id]
    lines: list[str] = []
    if node.description:
        lines += [f"> {node.description}", ""]
    members = dossier["sections"]
    docs = sorted({refs[k].doc for k in members if k in refs})
    lines += [*_facts(tree, node_id, dossier, refs, titles), ""]
    for aspect in dossier["aspects"]:
        lines += [f"## {aspect['name']}", ""]
        for group in (MAIN_GROUP, OTHERS_GROUP):
            statements = aspect["views"].get(group) or []
            if statements:
                lines += [f"### {GROUP_LABELS[group]}", ""]
                lines += [_statement_line(s, refs) for s in statements] + [""]
        lines += ["**Trechos** (★ central):", ""]
        for key in aspect["sections"]:
            ref = refs.get(key)
            if ref:
                star = "★ " if key in aspect["central"] else ""
                lines.append(f"- {star}{cite(ref)} — {ref.context} _({ref.speaker})_")
        lines.append("")
    for heading, items in (
        ("Onde os autores concordam", dossier.get("agreements") or []),
        ("Onde os autores divergem", dossier.get("divergences") or []),
    ):
        if items:
            lines += [f"## {heading}", ""] + [_statement_line(s, refs) for s in items] + [""]
    if docs:
        lines += ["## Fontes", ""]
        for doc in docs:
            count = sum(1 for k in members if k in refs and refs[k].doc == doc)
            lines.append(f"- {source_link(doc)} ({count} trechos)")
    return "\n".join(lines)


@dataclass
class DossierReport:
    written: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    review: list[str] = field(default_factory=list)
    pages: list[PageWrite] = field(default_factory=list)


def _is_current(
    previous: dict[str, Any] | None, tree: Tree, node_id: str, layout: MapLayout
) -> bool:
    if not previous:
        return False
    node = tree.nodes[node_id]
    if previous.get("sections") != tree.confirmed(node_id) or previous.get("name") != node.name:
        return False
    for doc, digest in (previous.get("source_hashes") or {}).items():
        data = load_document_sections(layout, doc) or {}
        if data.get("body_sha256") != digest:
            return False
    return True


def compile_dossiers(
    layout: MapLayout,
    ledger: Ledger,
    queue: ReviewQueue,
    only: str | None = None,
    force: bool = False,
) -> DossierReport:
    tree = Tree.load(layout)
    refs = load_sections(layout)
    titles = page_titles(layout, tree)
    builder = DossierBuilder(layout, ledger, refs)
    report = DossierReport()
    targets = [only] if only else [node.id for node in tree.ordered()]
    for node_id in targets:
        if node_id not in tree.nodes:
            raise KeyError(node_id)
        target = layout.dossier_file(node_id)
        previous = read_json(target)
        if not force and _is_current(previous, tree, node_id, layout):
            dossier = previous
            report.unchanged.append(node_id)
        else:
            try:
                dossier = builder.build(tree, node_id)
            except DossierIncomplete as err:
                queue.put("dossier", node_id, node=node_id, reason=str(err))
                report.review.append(node_id)
                continue
            queue.drop("dossier", node_id)
            write_json(target, dossier)
            report.written.append(node_id)
        title, page = titles[node_id]
        docs = sorted({refs[k].doc for k in dossier["sections"] if k in refs})
        report.pages.append(
            write_page(
                layout,
                layout.topic.dir / page,
                title,
                render_article(tree, node_id, dossier, refs, titles),
                owned={"sources": [source_link(d) for d in docs], "kb_map_node": node_id},
                new_keys={"synonyms": tree.nodes[node_id].synonyms}
                if tree.nodes[node_id].parent
                else None,
            )
        )
    _remove_stale_dossiers(layout, tree)
    return report


def _remove_stale_dossiers(layout: MapLayout, tree: Tree) -> None:
    """A node that no longer exists (merged, deleted) has no dossier: the check would fail."""
    if not layout.dossiers_dir.is_dir():
        return
    for path in layout.dossiers_dir.glob("*.json"):
        if path.stem not in tree.nodes:
            path.unlink()

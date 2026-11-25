"""KBC-141 BR-4: the map is complete and current, proved by code, with no model call.

Fails when:
- a source has no sections, or sections of another content (body hash), or sections that do
  not cover its body from the first to the last character;
- an `ok` section is in no node of the tree (or the tree places a section that does not exist);
- a node has no dossier, or its dossier does not cite exactly the node's sections (not one
  less, not one more), or an aspect cites a section outside the dossier;
- a dossier was compiled from another content of a source.
"""

from dataclasses import dataclass

from .extract import STATUS_OK, STATUSES
from .layout import MapLayout, read_json
from .sectionsdb import section_key
from .tree import Tree
from .vault import Topic


@dataclass(frozen=True)
class Problem:
    kind: str
    subject: str
    detail: str

    def __str__(self) -> str:
        return f"{self.kind}: {self.subject}: {self.detail}"


def _sections_problems(
    topic: Topic, layout: MapLayout, allow_pending: bool
) -> tuple[list[Problem], set[str], set[str], dict[str, str]]:
    problems: list[Problem] = []
    ok_keys: set[str] = set()
    all_keys: set[str] = set()
    hashes: dict[str, str] = {}
    documents = topic.documents()
    for doc in documents:
        data = read_json(layout.sections_file(doc))
        if data is None:
            if not allow_pending:
                problems.append(Problem("pending", doc, "the source has no sections yet"))
            continue
        current = topic.read(doc).body_sha256
        hashes[doc] = data.get("body_sha256", "")
        if data.get("body_sha256") != current:
            problems.append(Problem("stale", doc, "the sections are of another content (hash)"))
        expected = 0
        for section in data.get("sections", []):
            key = section_key(doc, section.get("id", "?"))
            if section.get("status") not in STATUSES:
                problems.append(
                    Problem("sections", key, f"unknown status {section.get('status')!r}")
                )
            if section.get("start") != expected:
                problems.append(Problem("sections", key, f"coverage broken at {expected}"))
            expected = section.get("end", expected)
            all_keys.add(key)
            if section.get("status") == STATUS_OK:
                ok_keys.add(key)
        if expected != data.get("length"):
            problems.append(
                Problem("sections", doc, f"coverage ends at {expected} of {data.get('length')}")
            )
    for doc in sorted(set(layout.section_docs()) - set(documents)):
        # What a person took out keeps its place in the map: it may come back (KBC-187).
        data = read_json(layout.sections_file(doc)) if topic.was_taken_out(doc) else None
        if data is None:
            problems.append(Problem("orphan", doc, "sections of a source that no longer exists"))
            continue
        hashes[doc] = data.get("body_sha256", "")
        all_keys |= {section_key(doc, one.get("id", "?")) for one in data.get("sections", [])}
    return problems, ok_keys, all_keys, hashes


def run_check(topic: Topic, allow_pending: bool = False) -> list[Problem]:
    layout = MapLayout(topic)
    if not layout.has_map():
        return []
    problems, ok_keys, all_keys, hashes = _sections_problems(topic, layout, allow_pending)
    tree = Tree.load(layout)
    placed: set[str] = set()
    for key, assignment in tree.assignments.items():
        nodes = [n for n in assignment.nodes if n in tree.nodes]
        if key not in all_keys:
            problems.append(Problem("tree", key, "the tree places a section that does not exist"))
        elif len(nodes) != len(assignment.nodes) or not nodes:
            problems.append(Problem("tree", key, "placed in a node that does not exist"))
        if nodes:
            placed.add(key)
    for key in sorted(ok_keys - placed):
        problems.append(Problem("unplaced", key, "an ok section is in no node of the tree"))
    for node in tree.ordered():
        problems.extend(_dossier_problems(layout, tree, node.id, hashes))
    if layout.dossiers_dir.is_dir():
        for path in sorted(layout.dossiers_dir.glob("*.json")):
            if path.stem not in tree.nodes:
                problems.append(
                    Problem("dossier", path.stem, "dossier of a node that does not exist")
                )
    return problems


def _dossier_problems(
    layout: MapLayout, tree: Tree, node_id: str, hashes: dict[str, str]
) -> list[Problem]:
    dossier = read_json(layout.dossier_file(node_id))
    members = set(tree.confirmed(node_id))
    if dossier is None:
        return [Problem("dossier", node_id, f"no dossier for a node with {len(members)} sections")]
    problems = []
    cited = set(dossier.get("sections", []))
    for key in sorted(members - cited):
        problems.append(Problem("dossier", node_id, f"leaves out {key}"))
    for key in sorted(cited - members):
        problems.append(Problem("dossier", node_id, f"cites {key}, which is not in the node"))
    in_aspects: set[str] = set()
    for aspect in dossier.get("aspects", []):
        sections = set(aspect.get("sections", []))
        in_aspects |= sections
        for statements in (aspect.get("views") or {}).values():
            for statement in statements:
                outside = set(statement.get("cites", [])) - sections
                if outside:
                    problems.append(
                        Problem(
                            "dossier",
                            node_id,
                            f"aspect {aspect.get('name')!r} cites {sorted(outside)[0]} outside it",
                        )
                    )
    for key in sorted(cited - in_aspects):
        problems.append(Problem("dossier", node_id, f"{key} is in no aspect"))
    for doc, digest in (dossier.get("source_hashes") or {}).items():
        if hashes.get(doc) != digest:
            problems.append(Problem("dossier", node_id, f"compiled from another content of {doc}"))
    return problems

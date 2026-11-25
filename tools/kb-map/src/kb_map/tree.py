"""KBC-140: the subject tree of a topic, with synonyms, and every section placed in it.

- The roots are kb's concepts (`wiki/concepts/*.md`); subjects below them come from grouping
  the sections' propositions (the model names each group and gives its description,
  synonyms and criterion).
- A node holds 3 to 300 sections (BR-2): a larger node is split, a smaller one merged into its
  largest sibling, unless the owner pinned it.
- Every `ok` section is in at least one leaf, or `review` (a-revisar) on the nearest node, with
  a new-node proposal in the review queue (BR-1).
- Ids are stable: a group the model proposes again is matched to the node it became (by every
  name that node ever had), so a rebuild never renames ids (NFR-1) and the owner's edits,
  kept in `owner-edits.json`, are re-applied on every build (BR-3).
- Synonyms are only expressions found in the node's own sections (BR-4).
"""

import random
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from typing import Any

from .layout import FORMAT_VERSION, MapLayout, ReviewQueue, now, read_json, write_json
from .providers import Ledger, ProviderError, Request
from .sectionsdb import SectionRef, load_sections
from .textutil import contains_folded, fold, slugify
from .vault import Topic, split_frontmatter

MIN_SIZE = 3
MAX_SIZE = 300
ASSIGN_BATCH = 40
REFINE_SAMPLE = 600
MAX_DEPTH = 5

SYSTEM = (
    "You organise the subjects of a study collection of Hermetic and esoteric teachings in "
    "Brazilian Portuguese. You only use what the given sections say."
)

ASSIGN_INSTRUCTIONS = """Place each section in the subjects it treats.

- `subjects` lists the candidate subjects (id, path, description, criterion, synonyms).
- For each section give the ids of every subject it really treats (prefer the most specific).
- When none fits, give `subjects: []`, the id of the `closest` subject, and a `proposal` for a
  new subject (name, description, criterion, synonyms found in the section, in pt-BR).

Answer: {"assignments": [{"key": str, "subjects": [str], "closest": str|null,
"proposal": {"name": str, "description": str, "criterion": str, "synonyms": [str]}|null}]}"""

REFINE_INSTRUCTIONS = """Split a subject into finer subjects from its sections' propositions.

- Group the sections by what they teach. Each group becomes a child subject with a short
  `name`, a one-line `description`, a `criterion` (what belongs to it) and `synonyms`:
  expressions that occur in the sections and mean the subject (never free translations).
- Aim for groups of at least `min` and at most `max` sections; reuse the names of
  `existing_children` when a group is the same subject.
- Every section goes to at least one group; a section may go to more than one.
- Write in Portuguese (pt-BR).

Answer: {"children": [{"name": str, "description": str, "criterion": str,
"synonyms": [str], "sections": [str]}]}"""


@dataclass
class Node:
    id: str
    name: str
    description: str = ""
    criterion: str = ""
    synonyms: list[str] = field(default_factory=list)
    parent: str | None = None
    concept: str | None = None  # wiki/concepts/<file> for a root
    match_names: list[str] = field(default_factory=list)


@dataclass
class Assignment:
    nodes: list[str]
    review: bool = False


class Tree:
    def __init__(self) -> None:
        self.nodes: dict[str, Node] = {}
        self.assignments: dict[str, Assignment] = {}

    @staticmethod
    def load(layout: MapLayout) -> "Tree":
        tree = Tree()
        data = read_json(layout.tree_file, default={}) or {}
        for raw in data.get("nodes", []):
            node = Node(**raw)
            tree.nodes[node.id] = node
        for key, raw in (data.get("assignments") or {}).items():
            tree.assignments[key] = Assignment(list(raw["nodes"]), bool(raw.get("review")))
        return tree

    def save(self, layout: MapLayout) -> None:
        write_json(
            layout.tree_file,
            {
                "format": FORMAT_VERSION,
                "updated": now(),
                "nodes": [asdict(node) for node in self.ordered()],
                "assignments": {
                    key: {"nodes": a.nodes, **({"review": True} if a.review else {})}
                    for key, a in sorted(self.assignments.items())
                },
            },
        )

    def roots(self) -> list[Node]:
        return [node for node in self.nodes.values() if node.parent is None]

    def children(self, node_id: str) -> list[Node]:
        return [node for node in self.nodes.values() if node.parent == node_id]

    def ordered(self) -> list[Node]:
        """Depth-first, children by name: the order of the review file and the index."""
        out: list[Node] = []

        def walk(nodes: Iterable[Node]) -> None:
            for node in sorted(nodes, key=lambda n: fold(n.name)):
                out.append(node)
                walk(self.children(node.id))

        walk(self.roots())
        return out

    def depth(self, node_id: str) -> int:
        depth, node = 0, self.nodes[node_id]
        while node.parent:
            depth, node = depth + 1, self.nodes[node.parent]
        return depth

    def path(self, node_id: str) -> str:
        names, node = [], self.nodes.get(node_id)
        while node:
            names.append(node.name)
            node = self.nodes.get(node.parent) if node.parent else None
        return " → ".join(reversed(names))

    def descendants(self, node_id: str) -> list[str]:
        out, stack = [], [node_id]
        while stack:
            current = stack.pop()
            out.append(current)
            stack.extend(child.id for child in self.children(current))
        return out

    def members(self, node_id: str) -> list[str]:
        """Sections placed directly on the node, confirmed or to review."""
        return sorted(k for k, a in self.assignments.items() if node_id in a.nodes)

    def confirmed(self, node_id: str) -> list[str]:
        """Sections placed on the node and not waiting for review: its dossier's exact set.
        A section to review counts as placed (the check), but no article is compiled from it
        until a person confirms where it belongs."""
        return [k for k in self.members(node_id) if not self.assignments[k].review]

    def total(self, node_id: str) -> set[str]:
        ids = set(self.descendants(node_id))
        return {k for k, a in self.assignments.items() if ids.intersection(a.nodes)}

    def review_count(self, node_id: str) -> int:
        return sum(1 for a in self.assignments.values() if a.review and node_id in a.nodes)

    def new_id(self, name: str, parent: str | None) -> str:
        base = slugify(name)
        candidates = [base, f"{parent}--{base}" if parent else base]
        for candidate in candidates:
            if candidate not in self.nodes:
                return candidate
        number = 2
        while f"{base}-{number}" in self.nodes:
            number += 1
        return f"{base}-{number}"

    def place(self, key: str, node_ids: list[str], review: bool = False) -> None:
        self.assignments[key] = Assignment(sorted(dict.fromkeys(node_ids)), review)

    def move_members(self, source: str, target: str) -> None:
        for assignment in self.assignments.values():
            if source in assignment.nodes:
                assignment.nodes = sorted(
                    {target if node == source else node for node in assignment.nodes}
                )

    def merge(self, absorbed: str, survivor: str) -> None:
        if absorbed == survivor or absorbed not in self.nodes or survivor not in self.nodes:
            return
        gone, kept = self.nodes[absorbed], self.nodes[survivor]
        self.move_members(absorbed, survivor)
        for child in self.children(absorbed):
            child.parent = survivor
        kept.match_names = sorted({*kept.match_names, *gone.match_names, gone.name})
        kept.synonyms = list(dict.fromkeys([*kept.synonyms, gone.name, *gone.synonyms]))
        del self.nodes[absorbed]

    def remove(self, node_id: str) -> None:
        """Deletes a node: its children and sections go up to its parent, marked for review."""
        node = self.nodes.pop(node_id)
        for child in self.children(node_id):
            child.parent = node.parent
        for key, assignment in list(self.assignments.items()):
            if node_id in assignment.nodes:
                rest = [n for n in assignment.nodes if n != node_id]
                if node.parent:
                    self.place(key, [*rest, node.parent], review=not rest or assignment.review)
                elif rest:
                    self.place(key, rest, assignment.review)
                else:
                    del self.assignments[key]


@dataclass
class OwnerEdits:
    """The owner's corrections: fixed, re-applied on every rebuild (BR-3)."""

    renamed: dict[str, str] = field(default_factory=dict)
    merged: dict[str, dict[str, str]] = field(default_factory=dict)  # id -> {into, name}
    deleted: dict[str, str] = field(default_factory=dict)  # id -> name
    moved: dict[str, str] = field(default_factory=dict)  # id -> parent id
    pinned: list[str] = field(default_factory=list)

    @staticmethod
    def load(layout: MapLayout) -> "OwnerEdits":
        data = read_json(layout.owner_edits_file, default={}) or {}
        return OwnerEdits(**{k: v for k, v in data.items() if k in OwnerEdits.__annotations__})

    def save(self, layout: MapLayout) -> None:
        write_json(layout.owner_edits_file, asdict(self))

    def resolve(self, node_id: str) -> str | None:
        """Where a node id lives now: through merges, None once deleted."""
        seen = set()
        while node_id in self.merged and node_id not in seen:
            seen.add(node_id)
            node_id = self.merged[node_id]["into"]
        return None if node_id in self.deleted else node_id

    def target_of_name(self, name: str) -> tuple[str, str | None] | None:
        """A proposed name the owner already decided on: ("deleted", None) or ("merged", id)."""
        folded = fold(name)
        for node_id, old in self.deleted.items():
            if fold(old) == folded:
                return ("deleted", node_id)
        for node_id, merge in self.merged.items():
            if fold(merge["name"]) == folded:
                return ("merged", self.resolve(node_id))
        return None


def apply_owner_edits(tree: Tree, edits: OwnerEdits) -> None:
    for absorbed in edits.merged:
        survivor = edits.resolve(absorbed)
        if survivor and absorbed in tree.nodes and survivor in tree.nodes:
            tree.merge(absorbed, survivor)
    for node_id in edits.deleted:
        if node_id in tree.nodes and tree.nodes[node_id].parent is not None:
            tree.remove(node_id)
    for node_id, parent in edits.moved.items():
        if (
            node_id in tree.nodes
            and parent in tree.nodes
            and node_id not in _ancestry(tree, parent)
        ):
            tree.nodes[node_id].parent = parent
    for node_id, name in edits.renamed.items():
        if node_id in tree.nodes:
            node = tree.nodes[node_id]
            if node.name != name:
                node.match_names = sorted({*node.match_names, node.name})
                node.name = name


def _ancestry(tree: Tree, node_id: str) -> set[str]:
    out, current = set(), tree.nodes.get(node_id)
    while current:
        out.add(current.id)
        current = tree.nodes.get(current.parent) if current.parent else None
    return out


def concept_roots(topic: Topic) -> list[Node]:
    folder = topic.dir / "wiki" / "concepts"
    roots = []
    for page in sorted(folder.glob("*.md")) if folder.is_dir() else []:
        data = split_frontmatter(page.read_text(encoding="utf-8")).data
        title = str(data.get("title") or page.stem)
        aliases = [str(alias) for alias in data.get("aliases") or [] if alias]
        roots.append(
            Node(
                id=slugify(title),
                name=title,
                criterion=str(data.get("criterion") or ""),
                synonyms=aliases,
                concept=page.relative_to(topic.dir).as_posix(),
                match_names=[title],
            )
        )
    return roots


@dataclass
class BuildReport:
    sections: int = 0
    assigned_now: int = 0
    review: int = 0
    unplaced: list[str] = field(default_factory=list)
    splits: int = 0
    merges: int = 0
    nodes: int = 0


class TreeBuilder:
    def __init__(
        self,
        topic: Topic,
        ledger: Ledger,
        queue: ReviewQueue,
        *,
        min_size: int = MIN_SIZE,
        max_size: int = MAX_SIZE,
        seed: int = 0,
    ) -> None:
        self.topic = topic
        self.layout = MapLayout(topic)
        self.ledger = ledger
        self.queue = queue
        self.min_size = min_size
        self.max_size = max_size
        self.rng = random.Random(seed)  # noqa: S311 (reproducible sampling, not security)
        self.tree = Tree.load(self.layout)
        self.edits = OwnerEdits.load(self.layout)
        self.sections: dict[str, SectionRef] = {}
        self.report = BuildReport()
        self._folded: dict[str, str] = {}
        self._bodies: dict[str, bytes] = {}

    # ---- the build -------------------------------------------------------------------------

    def build(self) -> BuildReport:
        self.sections = load_sections(self.layout)
        self.report.sections = len(self.sections)
        self._sync_roots()
        apply_owner_edits(self.tree, self.edits)
        self._clean_assignments()
        pending = [key for key in self.sections if key not in self.tree.assignments]
        self.report.assigned_now = len(pending)
        self._assign(pending, [node.id for node in self.tree.nodes.values()], fallback=None)
        self._refine_all()
        self._enforce_min_size()
        apply_owner_edits(self.tree, self.edits)
        self._filter_synonyms()
        self.report.review = sum(1 for a in self.tree.assignments.values() if a.review)
        self.report.nodes = len(self.tree.nodes)
        self.tree.save(self.layout)
        return self.report

    def _sync_roots(self) -> None:
        for root in concept_roots(self.topic):
            existing = self.tree.nodes.get(root.id)
            if existing is None:
                self.tree.nodes[root.id] = root
            else:
                existing.concept = root.concept
                existing.criterion = existing.criterion or root.criterion
                existing.synonyms = list(dict.fromkeys([*existing.synonyms, *root.synonyms]))

    def _clean_assignments(self) -> None:
        for key in list(self.tree.assignments):
            assignment = self.tree.assignments[key]
            if key not in self.sections:
                del self.tree.assignments[key]
                continue
            nodes = [self.edits.resolve(n) for n in assignment.nodes]
            nodes = [n for n in nodes if n and n in self.tree.nodes]
            if nodes:
                self.tree.place(key, nodes, assignment.review)
            else:
                del self.tree.assignments[key]

    # ---- placing sections ------------------------------------------------------------------

    def _catalog(self, node_ids: Iterable[str]) -> list[dict[str, Any]]:
        return [
            {
                "id": node.id,
                "path": self.tree.path(node.id),
                "description": node.description,
                "criterion": node.criterion,
                "synonyms": node.synonyms[:12],
            }
            for node in (self.tree.nodes[i] for i in node_ids)
        ]

    def _assign(self, keys: list[str], candidates: list[str], fallback: str | None) -> None:
        """Places sections among `candidates`; what fits none goes to review on the closest
        candidate (or `fallback`), with a proposal in the queue."""
        if not keys or not candidates:
            for key in keys:
                self._unplaced(key, fallback, None)
            return
        allowed = set(candidates)
        for start in range(0, len(keys), ASSIGN_BATCH):
            batch = keys[start : start + ASSIGN_BATCH]
            answers = self._ask_assign(batch, candidates)
            for key in batch:
                answer = answers.get(key) or {}
                chosen = [self.edits.resolve(str(i)) for i in answer.get("subjects") or []]
                chosen = [i for i in chosen if i in allowed]
                if chosen:
                    self.tree.place(key, chosen)
                    continue
                closest = self.edits.resolve(str(answer.get("closest") or ""))
                proposal = (
                    answer.get("proposal") if isinstance(answer.get("proposal"), dict) else None
                )
                self._unplaced(key, closest if closest in allowed else fallback, proposal)

    def _ask_assign(self, batch: list[str], candidates: list[str]) -> dict[str, dict[str, Any]]:
        answers: dict[str, dict[str, Any]] = {}
        missing = list(batch)
        for _attempt in range(2):
            payload = {
                "subjects": self._catalog(candidates),
                "sections": [self.sections[key].brief() for key in missing],
            }
            try:
                reply = self.ledger.ask_json(
                    Request("assign", SYSTEM, ASSIGN_INSTRUCTIONS, payload, max_tokens=6000)
                )
            except ProviderError:
                continue
            for item in reply.get("assignments") or []:
                if isinstance(item, dict) and item.get("key") in missing:
                    answers[item["key"]] = item
            missing = [key for key in missing if key not in answers]
            if not missing:
                break
        return answers

    def _unplaced(self, key: str, closest: str | None, proposal: dict[str, Any] | None) -> None:
        name = str((proposal or {}).get("name") or "").strip()
        if closest:
            self.tree.place(key, [closest], review=True)
        else:
            self.tree.assignments.pop(key, None)
            self.report.unplaced.append(key)
        queue_key = f"{slugify(name) if name else 'sem-nome'}@{closest or '-'}"
        current = next(
            (item for item in self.queue.items("node") if item["key"] == f"node:{queue_key}"), None
        )
        sections = sorted({*(current or {}).get("sections", []), key})
        self.queue.put(
            "node",
            queue_key,
            name=name or None,
            parent=closest,
            description=str((proposal or {}).get("description") or ""),
            criterion=str((proposal or {}).get("criterion") or ""),
            synonyms=[str(s) for s in (proposal or {}).get("synonyms") or []],
            sections=sections,
        )

    # ---- splitting and merging -------------------------------------------------------------

    def _refine_all(self) -> None:
        work = [node.id for node in self.tree.roots()]
        while work:
            node_id = work.pop(0)
            if node_id not in self.tree.nodes:
                continue
            members = self.tree.confirmed(node_id)
            kids = self.tree.children(node_id)
            is_root = self.tree.nodes[node_id].parent is None
            first_split = not kids and is_root and len(members) >= 2 * self.min_size
            if self.tree.depth(node_id) < MAX_DEPTH and (
                len(members) > self.max_size or first_split
            ):
                self._split(node_id, members)
            elif kids and members:
                # New sections that landed on a parent go down to its children.
                self._assign(members, [k.id for k in kids], fallback=node_id)
            work.extend(child.id for child in self.tree.children(node_id))

    def _split(self, node_id: str, members: list[str]) -> None:
        node = self.tree.nodes[node_id]
        sample = members
        if len(members) > REFINE_SAMPLE:
            sample = sorted(self.rng.sample(members, REFINE_SAMPLE))
        payload = {
            "subject": {
                "name": node.name,
                "description": node.description,
                "criterion": node.criterion,
            },
            "existing_children": [child.name for child in self.tree.children(node_id)],
            "min": self.min_size,
            "max": self.max_size,
            "sections": [self.sections[key].brief() for key in sample],
        }
        try:
            reply = self.ledger.ask_json(
                Request("refine", SYSTEM, REFINE_INSTRUCTIONS, payload, max_tokens=12000)
            )
        except ProviderError:
            return
        groups = [g for g in reply.get("children") or [] if isinstance(g, dict) and g.get("name")]
        if len(groups) < 2:
            return
        member_set = set(members)
        created: list[str] = []
        given: dict[str, set[str]] = {}
        for group in groups:
            child_id = self._child_for(node_id, group)
            if child_id is None:
                continue
            if child_id not in created:
                created.append(child_id)
            keys = {str(k) for k in group.get("sections") or []} & member_set
            for key in keys:
                given.setdefault(key, set()).add(child_id)
        if len(created) < 2:
            for child_id in created:
                if not self.tree.members(child_id) and not self.tree.children(child_id):
                    del self.tree.nodes[child_id]
            return
        self.report.splits += 1
        for key, child_ids in given.items():
            others = [n for n in self.tree.assignments[key].nodes if n != node_id]
            self.tree.place(key, [*others, *child_ids])
        rest = [key for key in members if key not in given]
        self._assign(rest, created, fallback=node_id)
        self._merge_small(node_id)

    def _child_for(self, parent: str, group: dict[str, Any]) -> str | None:
        name = str(group["name"]).strip()
        decided = self.edits.target_of_name(name)
        if decided and decided[0] == "deleted":
            return None
        if decided and decided[0] == "merged" and decided[1] in self.tree.nodes:
            return decided[1]
        folded = fold(name)
        for child in self.tree.children(parent):
            if folded in {fold(n) for n in [child.name, *child.match_names]}:
                return child.id
        node = Node(
            id=self.tree.new_id(name, parent),
            name=name,
            description=str(group.get("description") or ""),
            criterion=str(group.get("criterion") or ""),
            synonyms=[str(s) for s in group.get("synonyms") or [] if str(s).strip()],
            parent=parent,
            match_names=[name],
        )
        self.tree.nodes[node.id] = node
        return node.id

    def _merge_small(self, parent: str) -> None:
        while True:
            kids = [k for k in self.tree.children(parent) if k.id not in self.edits.pinned]
            small = [k for k in kids if len(self.tree.total(k.id)) < self.min_size]
            siblings = self.tree.children(parent)
            if not small or len(siblings) < 2:
                break
            victim = min(small, key=lambda k: (len(self.tree.total(k.id)), k.id))
            others = [s for s in siblings if s.id != victim.id]
            survivor = max(others, key=lambda s: (len(self.tree.total(s.id)), s.id))
            self.tree.merge(victim.id, survivor.id)
            self.report.merges += 1
        kids = self.tree.children(parent)
        if len(kids) == 1 and kids[0].id not in self.edits.pinned:
            only = kids[0]
            for child in self.tree.children(only.id):
                child.parent = parent
            self.tree.move_members(only.id, parent)
            del self.tree.nodes[only.id]

    def _enforce_min_size(self) -> None:
        for node in list(self.tree.nodes.values()):
            if node.id in self.tree.nodes and node.parent is None:
                self._merge_small(node.id)
        for node in list(self.tree.nodes.values()):
            if node.id in self.tree.nodes and node.parent is not None:
                self._merge_small(node.id)

    # ---- synonyms --------------------------------------------------------------------------

    def _folded_text(self, key: str) -> str:
        if key not in self._folded:
            ref = self.sections[key]
            self._folded[key] = fold(ref.text() + "\n" + self._body_slice(ref))
        return self._folded[key]

    def _body_slice(self, ref: SectionRef) -> str:
        if ref.doc not in self._bodies:
            try:
                self._bodies[ref.doc] = self.topic.read(ref.doc).body.encode("utf-16-le")
            except OSError:
                self._bodies[ref.doc] = b""
        encoded = self._bodies[ref.doc]
        return encoded[ref.start * 2 : ref.end * 2].decode("utf-16-le", errors="ignore")

    def _filter_synonyms(self) -> None:
        for node in self.tree.nodes.values():
            keys = sorted(self.tree.total(node.id))
            kept = []
            for synonym in dict.fromkeys(s.strip() for s in node.synonyms if s.strip()):
                if fold(synonym) == fold(node.name):
                    continue
                if any(contains_folded(self._folded_text(key), synonym) for key in keys):
                    kept.append(synonym)
            node.synonyms = kept


def apply_corrections(
    topic: Topic, corrections: list[dict[str, Any]]
) -> tuple[list[str], list[str]]:
    """Applies the owner's corrections to the tree and fixes them for every rebuild (FR-2).

    Returns (done, refused): each a list of human-readable lines.
    """
    layout = MapLayout(topic)
    tree = Tree.load(layout)
    edits = OwnerEdits.load(layout)
    done: list[str] = []
    refused: list[str] = []
    for index, raw in enumerate(corrections, start=1):
        if not isinstance(raw, dict) or len(raw) != 1:
            refused.append(f"#{index}: each correction is one of rename/merge/move/delete/pin")
            continue
        ((op, args),) = raw.items()
        args = args if isinstance(args, dict) else {"node": args}
        try:
            done.append(_correct(tree, edits, op, args))
        except ValueError as err:
            refused.append(f"#{index} {op}: {err}")
    tree.save(layout)
    edits.save(layout)
    return done, refused


def _need(tree: Tree, node_id: Any) -> str:
    if not isinstance(node_id, str) or node_id not in tree.nodes:
        raise ValueError(f"no node {node_id!r}")
    return node_id


def _correct(tree: Tree, edits: OwnerEdits, op: str, args: dict[str, Any]) -> str:
    if op == "rename":
        node_id = _need(tree, args.get("node"))
        name = str(args.get("name") or "").strip()
        if not name:
            raise ValueError("a new name is required")
        edits.renamed[node_id] = name
        apply_owner_edits(tree, OwnerEdits(renamed={node_id: name}))
        return f"renamed {node_id} to {name!r}"
    if op == "merge":
        nodes = [_need(tree, n) for n in args.get("nodes") or []]
        into = _need(tree, args.get("into") or (nodes[0] if nodes else None))
        absorbed = [n for n in nodes if n != into]
        if not absorbed:
            raise ValueError("name at least two nodes")
        for node_id in absorbed:
            edits.merged[node_id] = {"into": into, "name": tree.nodes[node_id].name}
            tree.merge(node_id, into)
        return f"merged {', '.join(absorbed)} into {into}"
    if op == "move":
        node_id = _need(tree, args.get("node"))
        parent = _need(tree, args.get("parent"))
        if node_id in _ancestry(tree, parent):
            raise ValueError(f"{parent} is inside {node_id}")
        edits.moved[node_id] = parent
        tree.nodes[node_id].parent = parent
        return f"moved {node_id} under {parent}"
    if op == "delete":
        node_id = _need(tree, args.get("node"))
        if tree.nodes[node_id].parent is None:
            raise ValueError("a root is a kb concept: change it with kb, not here")
        edits.deleted[node_id] = tree.nodes[node_id].name
        tree.remove(node_id)
        return f"deleted {node_id} (its sections went up for review)"
    if op == "pin":
        node_id = _need(tree, args.get("node"))
        if node_id not in edits.pinned:
            edits.pinned.append(node_id)
        return f"pinned {node_id}"
    raise ValueError("unknown correction (rename, merge, move, delete, pin)")

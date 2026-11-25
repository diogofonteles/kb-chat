"""The owner's review of the tree (KBC-140 FR-1): a readable file and the corrections format."""

from .layout import MapLayout, ReviewQueue, today
from .tree import OwnerEdits, Tree
from .vault import write_atomic

HOW_TO = """## Como corrigir

Escreva um arquivo YAML (por exemplo `correcoes.yaml`) com uma lista de correções e rode
`kb-map tree apply <acervo> correcoes.yaml`. As correções ficam fixas: uma reconstrução não as
desfaz. Use os ids entre crases abaixo.

```yaml
- rename: {node: ritmo, name: "Lei do Ritmo"}
- merge: {nodes: [pendulo, ritmo], into: ritmo}
- move: {node: polaridade, parent: sete-principios}
- delete: {node: assunto-errado}
- pin: {node: no-pequeno-mas-certo}   # não funde mesmo com menos de 3 trechos
```
"""


def render_review(layout: MapLayout, tree: Tree, queue: ReviewQueue) -> str:
    edits = OwnerEdits.load(layout)
    review_total = sum(1 for a in tree.assignments.values() if a.review)
    proposals = queue.items("node")
    lines = [
        f"# Árvore de assuntos — {layout.topic.title}",
        "",
        f"Gerado por kb-map em {today()}: {len(tree.assignments)} trechos em "
        f"{len(tree.nodes)} nós, "
        f"{review_total} a revisar, {len(proposals)} propostas de nó novo.",
        "",
        HOW_TO,
        "## Árvore",
        "",
    ]
    for node in tree.ordered():
        indent = "  " * tree.depth(node.id)
        total = len(tree.total(node.id))
        direct = len(tree.members(node.id))
        flags = []
        if node.id in edits.pinned:
            flags.append("fixo")
        if node.id in edits.renamed:
            flags.append("nome do dono")
        review = tree.review_count(node.id)
        extra = f", {review} a revisar" if review else ""
        flag = f" [{', '.join(flags)}]" if flags else ""
        lines.append(
            f"{indent}- **{node.name}** `{node.id}` — {total} trechos "
            f"({direct} diretos{extra}){flag}"
        )
        if node.description:
            lines.append(f"{indent}  - Descrição: {node.description}")
        if node.criterion:
            lines.append(f"{indent}  - Critério: {node.criterion}")
        if node.synonyms:
            lines.append(f"{indent}  - Sinônimos: {', '.join(node.synonyms)}")
    lines.append("")
    if proposals:
        lines += ["## Propostas de nós novos", ""]
        for item in proposals:
            name = item.get("name") or "(sem nome)"
            parent = item.get("parent") or "-"
            lines.append(f"- **{name}** sob `{parent}` — {len(item.get('sections', []))} trechos")
            if item.get("description"):
                lines.append(f"  - {item['description']}")
        lines.append("")
    if review_total:
        lines += ["## Trechos a revisar", ""]
        for key, assignment in sorted(tree.assignments.items()):
            if assignment.review:
                lines.append(f"- `{key}` em {', '.join(f'`{n}`' for n in assignment.nodes)}")
        lines.append("")
    return "\n".join(lines)


def write_review(layout: MapLayout, tree: Tree, queue: ReviewQueue) -> None:
    write_atomic(layout.tree_review_file, render_review(layout, tree, queue))

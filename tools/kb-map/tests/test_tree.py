"""KBC-140: the subject tree with synonyms, the owner's review and its fixed corrections."""

from conftest import write_concept, write_doc
from corpus import ML, build_corpus, build_tree, extract_all
from fakes import Model
from kb_map.index_md import write_index
from kb_map.layout import MapLayout, ReviewQueue
from kb_map.sectionsdb import load_sections
from kb_map.titles import page_titles
from kb_map.tree import Tree, apply_corrections
from kb_map.tree_review import render_review
from kb_map.vault import Vault


def _tree(topic):
    return Tree.load(MapLayout(topic))


def test_ac1_three_principles_under_sete_principios_and_every_section_placed(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    report, _ = build_tree(topic, model)

    tree = _tree(topic)
    children = {node.id: node for node in tree.children("sete-principios")}
    assert set(children) == {"ritmo", "polaridade", "vibracao"}
    assert {n.name for n in children.values()} == {"Ritmo", "Polaridade", "Vibração"}
    sections = load_sections(MapLayout(topic))
    for key in sections:
        assert tree.assignments[key].nodes, key
    for node_id in ("ritmo", "polaridade", "vibracao"):
        assert len(tree.members(node_id)) == 3
        assert all(not tree.assignments[k].review for k in tree.members(node_id))
    assert report.unplaced == []
    # FR-3: id, name, description, synonyms, criterion, parent.
    ritmo = children["ritmo"]
    assert ritmo.parent == "sete-principios"
    assert ritmo.description and ritmo.criterion


def test_ac2_synonyms_are_expressions_found_in_the_sections(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    build_tree(topic, model)

    ritmo = _tree(topic).nodes["ritmo"]
    assert "fluxo e refluxo" in ritmo.synonyms
    assert "lei do ritmo" in ritmo.synonyms
    assert "pêndulo" in ritmo.synonyms
    assert "maré cósmica" not in ritmo.synonyms  # proposed by the model, absent from the corpus
    # The concept's English aliases (kb's) are not expressions of the collection either.
    assert "Seven Principles" not in _tree(topic).nodes["sete-principios"].synonyms


def test_ac3_the_owners_rename_and_merge_survive_a_rebuild(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    build_tree(topic, model)
    vibracao_sections = _tree(topic).members("vibracao")

    done, refused = apply_corrections(
        topic,
        [
            {"rename": {"node": "ritmo", "name": "Lei do Ritmo"}},
            {"merge": {"nodes": ["polaridade", "vibracao"], "into": "polaridade"}},
        ],
    )
    assert refused == []
    assert len(done) == 2
    tree = _tree(topic)
    assert tree.nodes["ritmo"].name == "Lei do Ritmo"
    assert "vibracao" not in tree.nodes
    assert set(vibracao_sections) <= set(tree.members("polaridade"))

    # A rebuild from nothing: the model proposes "Ritmo" and "Vibração" again.
    MapLayout(topic).tree_file.unlink()
    build_tree(topic, model)
    tree = _tree(topic)
    assert tree.nodes["ritmo"].name == "Lei do Ritmo"
    assert "vibracao" not in tree.nodes
    assert set(vibracao_sections) <= set(tree.members("polaridade"))


def test_corrections_that_make_no_sense_are_refused_and_change_nothing(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    build_tree(topic, model)

    _done, refused = apply_corrections(
        topic,
        [
            {"rename": {"node": "nao-existe", "name": "X"}},
            {"delete": {"node": "sete-principios"}},
            {"move": {"node": "sete-principios", "parent": "ritmo"}},
            {"explode": {"node": "ritmo"}},
        ],
    )
    assert len(refused) == 4
    assert {n.id for n in _tree(topic).children("sete-principios")} == {
        "ritmo",
        "polaridade",
        "vibracao",
    }


def test_a_deleted_node_stays_deleted_and_its_sections_go_up_for_review(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    build_tree(topic, model)
    sections = _tree(topic).members("vibracao")

    apply_corrections(topic, [{"delete": {"node": "vibracao"}}])
    tree = _tree(topic)
    assert all(tree.assignments[k].review for k in sections)
    assert all("sete-principios" in tree.assignments[k].nodes for k in sections)

    MapLayout(topic).tree_file.unlink()
    build_tree(topic, model)
    assert "vibracao" not in _tree(topic).nodes


def test_ac4_a_node_over_300_sections_is_split(vault):
    write_concept(vault, "Ritmo", "O princípio do ritmo.")
    chapters = []
    for n in range(400):
        teaching = "o pêndulo do ritmo oscila" if n % 2 else "o fluxo e refluxo do ritmo"
        chapters.append(f"# Parte {n}\n\nNesta parte, {teaching}.\n")
    write_doc(vault, "raw/articles/tratado.md", "\n".join(chapters), title="Tratado", **ML)
    topic = Vault(vault).topic("hermetismo")
    model = Model()
    model.refine_key = lambda text: "pendulo" if "pêndulo" in text else "fluxo"
    model.refine_names = {
        "pendulo": ("Pêndulo", ["pêndulo"]),
        "fluxo": ("Fluxo e refluxo", ["fluxo e refluxo"]),
    }
    extract_all(topic, model)
    assert len(load_sections(MapLayout(topic))) == 400

    report, _ = build_tree(topic, model)

    tree = _tree(topic)
    assert {n.name for n in tree.children("ritmo")} == {"Pêndulo", "Fluxo e refluxo"}
    assert report.splits >= 1
    assert all(len(tree.members(node_id)) <= 300 for node_id in tree.nodes)


def test_a_group_below_the_minimum_is_merged_into_its_largest_sibling(vault):
    topic = build_corpus(vault)
    write_doc(vault, "raw/articles/vibracao-ml.md", "# Vibração I\n\nTudo vibra.\n", **ML)
    model = Model()
    extract_all(topic, model)
    report, _ = build_tree(topic, model)

    tree = _tree(topic)
    assert "vibracao" not in tree.nodes
    assert report.merges == 1
    assert all(len(tree.total(n.id)) >= 3 for n in tree.children("sete-principios"))


def test_ac5_a_section_that_fits_nowhere_is_to_review_with_a_proposal(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    build_tree(topic, model)

    tree = _tree(topic)
    receita = [k for k in tree.assignments if k.startswith("raw/articles/receita.md")]
    assert len(receita) == 1
    assert tree.assignments[receita[0]].review is True
    proposals = ReviewQueue(MapLayout(topic)).items("node")
    assert [p["name"] for p in proposals] == ["Culinária"]
    assert proposals[0]["sections"] == receita


def test_nfr1_an_incremental_rebuild_keeps_every_id_and_only_asks_for_new_sections(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    build_tree(topic, model)
    before = set(_tree(topic).nodes)

    write_doc(vault, "raw/articles/ritmo-2.md", "# Mais ritmo\n\nO ritmo volta sempre.\n", **ML)
    extract_all(topic, model)
    _report, provider = build_tree(topic, model)

    tree = _tree(topic)
    assert before <= set(tree.nodes)
    assert provider.tasks() == ["assign"]
    asked = [s["key"] for s in provider.calls[0].payload["sections"]]
    assert asked == ["raw/articles/ritmo-2.md#s001"]
    assert tree.assignments["raw/articles/ritmo-2.md#s001"].nodes == ["ritmo"]


def test_the_review_file_and_the_index_show_the_tree_with_counts(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    build_tree(topic, model)
    layout = MapLayout(topic)
    tree = _tree(topic)
    queue = ReviewQueue(layout)

    review = render_review(layout, tree, queue)
    assert "**Ritmo** `ritmo` — 3 trechos (3 diretos)" in review
    assert "Sinônimos: lei do ritmo, fluxo e refluxo, pêndulo" in review
    assert "- rename: {node: ritmo" in review
    assert "**Culinária** sob `cabala`" in review

    page = write_index(layout, tree, page_titles(layout, tree), load_sections(layout), queue)
    assert page.state == "created"
    index = layout.index_file.read_text(encoding="utf-8")
    assert "kb_map: 1" in index
    assert "## Sete Princípios" in index
    assert "  - [[Ritmo]] — O princípio: Ritmo (3 trechos, 1 fontes)" in index
    assert "## Fila de revisão" in index

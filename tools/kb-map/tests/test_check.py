"""KBC-141 BR-4 and FR-2: `kb-map check` proves the map complete and current, by code."""

import json

from conftest import TOPIC, write_doc
from corpus import ML, build_corpus, build_tree, extract_all
from fakes import Model
from kb_map.check import run_check
from kb_map.dossier import compile_dossiers
from kb_map.layout import MapLayout, ReviewQueue, read_json, write_json
from kb_map.providers import Ledger
from kb_map.tree import Tree


def _complete_map(vault):
    topic = build_corpus(vault)
    model = Model()
    extract_all(topic, model)
    build_tree(topic, model)
    layout = MapLayout(topic)
    compile_dossiers(layout, Ledger(model.provider()), ReviewQueue(layout))
    return topic, layout, model


def _kinds(problems):
    return sorted({p.kind for p in problems})


def test_a_complete_map_passes(vault):
    topic, _layout, _model = _complete_map(vault)
    assert run_check(topic) == []


def test_a_topic_without_a_map_has_nothing_to_check(vault):
    topic = build_corpus(vault)
    assert run_check(topic) == []


def test_ac4_a_new_section_without_a_node_fails_and_is_named(vault):
    topic, _layout, model = _complete_map(vault)
    write_doc(vault, "raw/articles/novo.md", "# Novo\n\nO ritmo de novo.\n", **ML)
    extract_all(topic, model)

    problems = run_check(topic)

    assert [str(p) for p in problems if p.kind == "unplaced"] == [
        "unplaced: raw/articles/novo.md#s001: an ok section is in no node of the tree"
    ]


def test_a_source_without_sections_is_pending_unless_allowed(vault):
    topic, _layout, _model = _complete_map(vault)
    write_doc(vault, "raw/articles/sem-mapa.md", "Texto ainda não mapeado.\n", **ML)
    assert [str(p) for p in run_check(topic)] == [
        "pending: raw/articles/sem-mapa.md: the source has no sections yet"
    ]
    assert run_check(topic, allow_pending=True) == []


def test_a_changed_source_has_the_map_of_another_content(vault):
    topic, _layout, _model = _complete_map(vault)
    write_doc(vault, "raw/articles/ritmo-ml.md", "# Ritmo\n\nOutro texto agora.\n", **ML)
    problems = run_check(topic)
    assert any(p.kind == "stale" and p.subject == "raw/articles/ritmo-ml.md" for p in problems)


def test_a_dossier_with_one_less_or_one_more_section_fails(vault):
    topic, layout, _model = _complete_map(vault)
    dossier = read_json(layout.dossier_file("ritmo"))
    removed = dossier["sections"].pop()
    dossier["sections"].append("raw/articles/polaridade.md#s001")
    write_json(layout.dossier_file("ritmo"), dossier)

    details = [p.detail for p in run_check(topic) if p.subject == "ritmo"]
    assert f"leaves out {removed}" in details
    assert "cites raw/articles/polaridade.md#s001, which is not in the node" in details


def test_a_section_in_no_aspect_and_a_missing_dossier_fail(vault):
    topic, layout, _model = _complete_map(vault)
    dossier = read_json(layout.dossier_file("ritmo"))
    lost = dossier["aspects"][0]["sections"].pop(0)
    for statements in dossier["aspects"][0]["views"].values():
        statements[:] = [s for s in statements if lost not in s["cites"]]
    write_json(layout.dossier_file("ritmo"), dossier)
    layout.dossier_file("vibracao").unlink()

    problems = [str(p) for p in run_check(topic)]
    assert f"dossier: ritmo: {lost} is in no aspect" in problems
    assert "dossier: vibracao: no dossier for a node with 3 sections" in problems


def test_broken_coverage_and_orphans_fail(vault):
    topic, layout, _model = _complete_map(vault)
    path = layout.sections_file("raw/articles/ritmo-ml.md")
    data = json.loads(path.read_text(encoding="utf-8"))
    data["sections"][1]["start"] += 1
    write_json(path, data)
    (vault / TOPIC / "raw/articles/receita.md").unlink()
    tree = Tree.load(layout)
    tree.assignments["raw/articles/fantasma.md#s001"] = tree.assignments[
        next(iter(tree.assignments))
    ]
    tree.save(layout)

    kinds = _kinds(run_check(topic))
    assert {"sections", "orphan", "tree"} <= set(kinds)


def test_what_a_person_took_out_keeps_its_place_in_the_map(vault):
    """KBC-187: it may come back, and the map is whole meanwhile."""
    topic, _layout, _model = _complete_map(vault)
    assert run_check(topic) == []
    inside = vault / TOPIC / "raw/articles/ritmo-ml.md"
    apart = vault / TOPIC / "raw/_quarantine/articles/ritmo-ml.md"
    apart.parent.mkdir(parents=True)
    text = inside.read_text(encoding="utf-8")
    marks = "---\ntriage: quarantined\ntriage_reason: removed_by_person\n"
    apart.write_text(text.replace("---\n", marks, 1), encoding="utf-8")
    inside.unlink()
    assert run_check(topic) == []
    # What kb itself refused, or what is nowhere, is an orphan as ever.
    apart.write_text(text.replace("---\n", "---\ntriage_reason: thin\n", 1), encoding="utf-8")
    assert "orphan" in _kinds(run_check(topic))

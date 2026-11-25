"""KBC-141: dossiers as wiki articles with the exact set of sections, entities and affects."""

import json

from conftest import TOPIC, write_doc
from corpus import ML, build_corpus, build_tree, extract_all
from fakes import Model
from kb_map.dossier import compile_dossiers
from kb_map.entities import compile_entities, write_affects
from kb_map.layout import MapLayout, ReviewQueue, read_json
from kb_map.providers import Ledger
from kb_map.sectionsdb import load_sections
from kb_map.tree import Tree
from kb_map.vault import split_frontmatter


def _mapped(vault, model=None, **corpus):
    topic = build_corpus(vault, **corpus)
    model = model or Model()
    extract_all(topic, model)
    build_tree(topic, model)
    return topic, MapLayout(topic), model


def _compile(layout, model, only=None):
    queue = ReviewQueue(layout)
    provider = model.provider()
    report = compile_dossiers(layout, Ledger(provider), queue, only)
    queue.save()
    return report, provider


def _all_cited(dossier):
    return {k for aspect in dossier["aspects"] for k in aspect["sections"]}


def test_ac1_the_dossier_cites_exactly_the_nodes_sections(vault):
    extra = "".join(
        f"# Ritmo extra {n}\n\nO ritmo aparece de novo, parte {n}.\n\n" for n in range(9)
    )
    topic, layout, model = _mapped(vault)
    write_doc(vault, "raw/articles/ritmo-extra.md", extra, title="Mais ritmo", **ML)
    extract_all(topic, model)
    build_tree(topic, model)
    members = Tree.load(layout).members("ritmo")
    assert len(members) == 12

    report, _ = _compile(layout, model, only="ritmo")

    dossier = read_json(layout.dossier_file("ritmo"))
    assert report.written == ["ritmo"]
    assert dossier["sections"] == members
    assert _all_cited(dossier) == set(members)
    for aspect in dossier["aspects"]:
        for statements in aspect["views"].values():
            for statement in statements:
                assert statement["cites"] and set(statement["cites"]) <= set(aspect["sections"])


def test_ac2_forgotten_sections_are_sent_back_before_anything_is_written(vault):
    _topic, layout, model = _mapped(vault)
    forgotten = Tree.load(layout).members("ritmo")[:2]
    model.forget_in_dossier = set(forgotten)

    _report, provider = _compile(layout, model, only="ritmo")

    assert provider.tasks() == ["dossier", "dossier-fill"]
    assert [s["key"] for s in provider.calls[1].payload["sections"]] == forgotten
    dossier = read_json(layout.dossier_file("ritmo"))
    assert _all_cited(dossier) == set(dossier["sections"])
    other = next(a for a in dossier["aspects"] if a["name"] == "Outros aspectos")
    assert set(other["sections"]) == set(forgotten)


def test_forgotten_twice_goes_to_review_and_writes_nothing(vault):
    _topic, layout, model = _mapped(vault)
    model.forget_in_dossier = set(Tree.load(layout).members("ritmo")[:1])
    model.fill_forgets = True

    report, _ = _compile(layout, model, only="ritmo")

    assert report.review == ["ritmo"]
    assert not layout.dossier_file("ritmo").exists()
    assert [i["key"] for i in ReviewQueue(layout).items("dossier")] == ["dossier:ritmo"]


def test_ac3_mestre_laercio_and_other_authors_are_kept_apart(vault):
    topic, layout, model = _mapped(vault)
    tree = Tree.load(layout)
    # One node with both authors: merge polaridade (other author) into ritmo (Mestre Laércio).
    from kb_map.tree import apply_corrections

    apply_corrections(topic, [{"merge": {"nodes": ["polaridade", "ritmo"], "into": "ritmo"}}])
    tree = Tree.load(layout)
    refs = load_sections(layout)
    groups = {refs[k].group for k in tree.members("ritmo")}
    assert groups == {"mestre-laercio", "outros-autores"}

    _compile(layout, model, only="ritmo")

    dossier = read_json(layout.dossier_file("ritmo"))
    views = dossier["aspects"][0]["views"]
    assert views["mestre-laercio"] and views["outros-autores"]
    for group, statements in views.items():
        for statement in statements:
            assert {refs[k].group for k in statement["cites"]} == {group}
    assert dossier["dropped_mixed_statements"] == 1  # "Todos concordam." cites both groups
    assert dossier["agreements"]
    page = (vault / TOPIC / "wiki/subjects/Ritmo.md").read_text(encoding="utf-8")
    assert "### Mestre Laércio" in page
    assert "### Outros autores" in page
    assert "Todos concordam." not in page


def test_citations_outside_the_node_are_dropped(vault):
    _topic, layout, model = _mapped(vault)
    stranger = Tree.load(layout).members("polaridade")[0]
    original = model.dossier

    def with_a_stranger(request):
        answer = original(request)
        answer["aspects"][0]["sections"].append(stranger)
        answer["aspects"][0]["statements"].append({"text": "Intruso.", "cites": [stranger]})
        return answer

    provider = model.provider()
    provider.handlers["dossier"] = with_a_stranger
    compile_dossiers(layout, Ledger(provider), ReviewQueue(layout), "ritmo")
    dossier = read_json(layout.dossier_file("ritmo"))
    assert stranger not in _all_cited(dossier)
    assert "Intruso." not in json.dumps(dossier, ensure_ascii=False)


def test_the_concept_stub_is_filled_keeping_kbs_keys(vault):
    _topic, layout, model = _mapped(vault)
    concept = vault / TOPIC / "wiki/concepts/Sete Princípios.md"
    before = split_frontmatter(concept.read_text(encoding="utf-8")).data

    _compile(layout, model)

    text = concept.read_text(encoding="utf-8")
    after = split_frontmatter(text).data
    assert after["criterion"] == before["criterion"]
    assert after["aliases"] == before["aliases"]
    assert after["tags"] == before["tags"]
    assert after["stage"] == "compiled"
    assert after["kb_map"] == 1
    assert after["kb_map_node"] == "sete-principios"
    assert "    - esoterismo" in text  # kb's own list indentation stays byte for byte
    assert "**Subassuntos:** [[Polaridade]] · [[Ritmo]] · [[Vibração]]" in text
    subject = (vault / TOPIC / "wiki/subjects/Ritmo.md").read_text(encoding="utf-8")
    data = split_frontmatter(subject).data
    assert data["type"] == "wiki" and data["domain"] == "esoterismo"
    assert data["sources"] == ["[[raw/articles/ritmo-ml]]"]
    assert "[[raw/articles/ritmo-ml|Aula sobre o ritmo]] §1" in subject
    assert "★ " in subject
    assert "**Parte de:** [[Sete Princípios]]" in subject


def test_a_page_written_by_someone_else_is_never_touched(vault):
    _topic, layout, model = _mapped(vault)
    concept = vault / TOPIC / "wiki/concepts/Sete Princípios.md"
    human = concept.read_text(encoding="utf-8").replace("stage: stub", "stage: draft")
    human += "\nTexto escrito pelo dono.\n"
    concept.write_text(human, encoding="utf-8")

    report, _ = _compile(layout, model)

    assert concept.read_text(encoding="utf-8") == human
    refused = [p for p in report.pages if p.state == "refused"]
    assert [p.path.name for p in refused] == ["Sete Princípios.md"]


def test_an_unchanged_node_is_not_compiled_again(vault):
    _topic, layout, model = _mapped(vault)
    _compile(layout, model)
    report, provider = _compile(layout, model)
    assert report.written == []
    assert provider.calls == []


def test_entity_pages_say_what_the_collection_says_and_where(vault):
    _topic, layout, model = _mapped(vault)
    _compile(layout, model)
    tree = Tree.load(layout)
    refs = load_sections(layout)
    from kb_map.titles import page_titles

    titles = page_titles(layout, tree)
    pages, entities = compile_entities(layout, refs, tree, titles)

    names = {e["name"] for e in entities.values()}
    assert {"Caibalion", "José Laércio do Egito", "Três Iniciados"} <= names
    assert "Hermes Trismegisto" not in names  # mentioned once: below the minimum
    caibalion = (vault / TOPIC / "wiki/entities/Caibalion.md").read_text(encoding="utf-8")
    assert "**Aparece em:** 3 trechos de 3 fontes" in caibalion
    assert "### Mestre Laércio" in caibalion and "### Outros autores" in caibalion
    assert "- O Caibalion chama de fluxo e refluxo — [[raw/articles/ritmo-ml" in caibalion
    assert "[[Ritmo]] (1)" in caibalion

    affects = write_affects(layout, refs, titles, entities)
    assert "wiki/subjects/Ritmo.md" in affects["raw/articles/ritmo-ml.md"]
    assert "wiki/entities/Caibalion.md" in affects["raw/articles/ritmo-ml.md"]
    assert all(page.state in ("created", "updated") for page in pages)

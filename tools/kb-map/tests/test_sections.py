"""KBC-139: sections with propositions, context and speaker (AC-1 to AC-4, FR-1 to FR-3)."""

import itertools
import json

import pytest

from conftest import TOPIC, write_doc
from fakes import Model
from kb_map.extract import extract_document
from kb_map.layout import MapLayout, ReviewQueue, read_json
from kb_map.providers import Ledger
from kb_map.textutil import utf16_len
from kb_map.vault import Vault

BOOK = """SUMÁRIO

Capítulo 1 — O Ritmo .......... 3
Capítulo 2 — A Polaridade ..... 9
Capítulo 3 — A Vibração ....... 15

# Capítulo 1 — O Ritmo

Tudo flui e reflui; a lei do ritmo governa as marés. O pêndulo oscila.

Fluxo e refluxo aparecem em todos os planos.

# Capítulo 2 — A Polaridade

Tudo é duplo; a polaridade une os opostos. Os extremos se tocam.

# Capítulo 3 — A Vibração

Nada está parado; tudo vibra. A vibração distingue os planos.
"""

LECTURE = """# Palestra sobre o ritmo

Gravação: Aula 7 · faixa 1 de 2 · José Laércio do Egito · 12:00

[0:00] **José Laércio do Egito:** Hoje falamos do ritmo. Ele está em tudo.

[0:41] **José Laércio do Egito:** O ritmo se compensa. A lei da compensação vale.

[1:15] **José Laércio do Egito:** Como o Caibalion diz, há marés. Hermes ensinou.

[2:02] **José Laércio do Egito:** Pois bem, o ritmo pode ser neutralizado. É a lei da neutralização.
"""


def _setup(vault):
    topic = Vault(vault).topic(TOPIC)
    return topic, MapLayout(topic), ReviewQueue(MapLayout(topic))


def test_ac1_chapters_become_sections_and_the_toc_is_out_of_the_map(vault):
    doc = write_doc(
        vault,
        "raw/articles/caibalion.md",
        BOOK,
        author="Três Iniciados",
        author_group="outros-autores",
    )
    topic, layout, queue = _setup(vault)
    model = Model()
    outcome = extract_document(topic, Ledger(model.provider()), queue, doc)

    assert outcome.state == "written"
    data = read_json(layout.sections_file(doc))
    sections = data["sections"]
    assert [s["status"] for s in sections] == ["fora-do-mapa", "ok", "ok", "ok"]
    assert sections[0]["reason"] == "sumário"
    assert [s.get("heading") for s in sections[1:]] == [
        "Capítulo 1 — O Ritmo",
        "Capítulo 2 — A Polaridade",
        "Capítulo 3 — A Vibração",
    ]
    # BR-1: from the first to the last character, no gap, no overlap (read_document's count).
    body = topic.read(doc).body
    assert sections[0]["start"] == 0
    assert sections[-1]["end"] == utf16_len(body) == data["length"]
    for before, after in itertools.pairwise(sections):
        assert before["end"] == after["start"]
    ritmo = sections[1]
    assert ritmo["propositions"][0]["text"].startswith("Tudo flui e reflui")
    assert ritmo["speaker"] == {"name": "Três Iniciados", "group": "outros-autores"}
    assert ritmo["context"]
    assert data["body_sha256"] == topic.read(doc).body_sha256
    assert data["extractor_version"] == 1
    # The source itself is never changed.
    assert (vault / TOPIC / doc).read_text(encoding="utf-8").endswith(BOOK)


def test_ac2_an_unchanged_document_makes_no_model_call(vault):
    doc = write_doc(vault, "raw/articles/caibalion.md", BOOK, author="Três Iniciados")
    topic, layout, queue = _setup(vault)
    model = Model()
    provider = model.provider()
    extract_document(topic, Ledger(provider), queue, doc)
    calls = len(provider.calls)
    before = layout.sections_file(doc).read_text(encoding="utf-8")

    again = extract_document(topic, Ledger(provider), queue, doc)

    assert again.state == "unchanged"
    assert len(provider.calls) == calls
    assert layout.sections_file(doc).read_text(encoding="utf-8") == before
    # A changed body is extracted again (BR-3 is about the content, not the file's date).
    write_doc(vault, doc, BOOK + "\nNovo parágrafo sobre o ritmo.\n", author="Três Iniciados")
    assert extract_document(topic, Ledger(provider), queue, doc).state == "written"
    assert len(provider.calls) > calls


@pytest.mark.parametrize(
    "bad",
    [
        lambda s: [{**s[0], "end": s[0]["end"] + 999_999}, *s[1:]],  # outside the body
        lambda s: s[1:],  # coverage does not start at the window's start
        lambda s: [{**s[0], "end": s[0]["end"] - 1}, *s[1:]],  # not on a block edge
        lambda s: [{**s[0], "end": s[1]["end"]}, *s[2:]],  # swallows a heading
    ],
)
def test_ac3_invalid_positions_retry_once_then_go_to_review(vault, bad):
    doc = write_doc(vault, "raw/articles/caibalion.md", BOOK, author="Três Iniciados")
    topic, layout, queue = _setup(vault)
    model = Model()
    good = model.sections

    def wrong(request):
        answer = good(request)
        return {"sections": bad(answer["sections"])}

    provider = model.provider()
    provider.handlers["sections"] = wrong
    outcome = extract_document(topic, Ledger(provider), queue, doc)
    queue.save()

    assert outcome.state == "review"
    assert provider.tasks() == ["sections", "sections"]
    assert not layout.sections_file(doc).exists()
    items = json.loads(layout.review_queue_file.read_text(encoding="utf-8"))
    assert [item["key"] for item in items] == [f"sections:{doc}"]


def test_ac3_a_good_second_answer_is_kept_and_clears_the_review(vault):
    doc = write_doc(vault, "raw/articles/caibalion.md", BOOK, author="Três Iniciados")
    topic, _layout, queue = _setup(vault)
    queue.put("sections", doc, doc=doc, reason="old")
    model = Model()
    answers = iter([{"sections": []}, None])

    def flaky(request):
        answer = next(answers)
        return answer if answer is not None else model.sections(request)

    provider = model.provider()
    provider.handlers["sections"] = flaky
    assert extract_document(topic, Ledger(provider), queue, doc).state == "written"
    assert queue.items("sections") == []


def test_ac4_a_quoted_author_speaks_the_quoted_propositions(vault):
    doc = write_doc(
        vault,
        "raw/media/rec-7/track-1.md",
        LECTURE,
        author="José Laércio do Egito",
        author_group="mestre-laercio",
    )
    topic, layout, queue = _setup(vault)
    extract_document(topic, Ledger(Model().provider()), queue, doc)

    sections = read_json(layout.sections_file(doc))["sections"]
    propositions = [p for s in sections for p in s.get("propositions", [])]
    quoted = [p for p in propositions if p["speaker"] == "O Caibalion"]
    own = [p for p in propositions if p["speaker"] == "José Laércio do Egito"]
    assert quoted and all(p["group"] == "outros-autores" for p in quoted)
    assert own and all(p["group"] == "mestre-laercio" for p in own)


def test_a_track_is_cut_at_its_time_anchors_like_a_text_at_its_headings(vault):
    doc = write_doc(
        vault,
        "raw/media/rec-7/track-1.md",
        LECTURE,
        author="José Laércio do Egito",
        author_group="mestre-laercio",
    )
    topic, layout, queue = _setup(vault)
    extract_document(topic, Ledger(Model().provider()), queue, doc)

    sections = read_json(layout.sections_file(doc))["sections"]
    body = topic.read(doc).body
    # The heading, then anchors: each section after the heading starts on an anchor.
    assert sections[0].get("heading") == "Palestra sobre o ritmo"
    for section in sections[1:]:
        assert body[section["start"] :].lstrip().startswith("[")
        assert section["at"]
    assert [s.get("at") for s in sections if s.get("at")] == ["0:00", "2:02"]
    assert sections[-1]["end"] == utf16_len(body)


def test_positions_count_utf16_units_like_read_document(vault):
    body = "# Um 🜁 símbolo\n\nO ar 🜁 e o ritmo.\n\n# Dois\n\nA polaridade.\n"
    doc = write_doc(vault, "raw/articles/simbolos.md", body, author="X")
    topic, layout, queue = _setup(vault)
    extract_document(topic, Ledger(Model().provider()), queue, doc)

    sections = read_json(layout.sections_file(doc))["sections"]
    assert len(body) != utf16_len(body)  # the alchemical symbol is outside the BMP
    assert sections[-1]["end"] == utf16_len(topic.read(doc).body)
    second = sections[1]["start"]
    assert body.encode("utf-16-le")[second * 2 :].decode("utf-16-le").startswith("# Dois")


def test_an_empty_body_writes_an_empty_map(vault):
    doc = write_doc(vault, "raw/articles/vazio.md", "", author="X")
    topic, layout, queue = _setup(vault)
    provider = Model().provider()
    assert extract_document(topic, Ledger(provider), queue, doc).state == "empty"
    assert provider.calls == []
    assert read_json(layout.sections_file(doc))["sections"] == []

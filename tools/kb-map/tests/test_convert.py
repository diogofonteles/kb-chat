"""KBC-148: convert and reconvert, with stubbed converters and a fake kb (no model, no network)."""

import json
import os
from pathlib import Path

import pytest

from conftest import TOPIC, write_doc
from convert_fakes import FakeKb, StubConverter, stub_set
from kb_map import cli
from kb_map.convert import factory
from kb_map.convert.converters import GENERATED_HEADING
from kb_map.convert.originals import sha256_file
from kb_map.layout import MapLayout, read_json
from kb_map.vault import Vault, split_frontmatter


@pytest.fixture
def kb(vault, monkeypatch):
    fake = FakeKb(vault)
    monkeypatch.setattr(factory, "ingest_factory", lambda args, v: fake)
    return fake


@pytest.fixture
def converters(monkeypatch):
    holder = {"set": stub_set()}
    monkeypatch.setattr(factory, "converter_factory", lambda args, v, ledger: holder["set"])
    return holder


def _run(vault, *args):
    return cli.main(["--vault", str(vault), *args])


def _doc(vault, doc_id):
    text = (vault / TOPIC / doc_id).read_text(encoding="utf-8")
    split = split_frontmatter(text)
    return text, split.data, split.body


def _pdf(tmp_path: Path, name="Caibalion.pdf", data=b"%PDF-1.4 tres capitulos") -> Path:
    path = tmp_path / "inbox" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# ---- AC-1: structure, original and hash ----------------------------------------------------


def test_a_pdf_keeps_its_three_chapters_and_table_and_its_original(
    vault, tmp_path, kb, converters, capsys
):
    pdf = _pdf(tmp_path)
    digest = sha256_file(pdf)

    code = _run(
        vault, "convert", TOPIC, str(pdf), "--origin", "Três Iniciados", "--year", "1908", "--json"
    )

    assert code == 0
    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result["state"] == "converted"
    assert result["document"] == "raw/articles/tres-iniciados-caibalion-1908.md"
    text, data, body = _doc(vault, result["document"])
    for heading in ("# Capítulo 1", "# Capítulo 2", "# Capítulo 3"):
        assert heading in body
    assert "| Ritmo | Tudo flui e reflui |" in body
    assert "<!-- página 2 -->" in body
    original = vault / TOPIC / "raw" / "_originals" / f"{digest}.pdf"
    assert original.read_bytes() == pdf.read_bytes()
    assert not os.access(original, os.W_OK)
    assert result["original"] == f"raw/_originals/{digest}.pdf"
    assert data["original_sha256"] == digest
    assert data["original_name"] == "Caibalion.pdf"
    assert data["converter"] == "docling"
    assert data["converter_version"] == "2.0.0"
    assert data["converted_at"]
    # kb's own keys stay as kb wrote them, byte for byte
    assert "tags:\n    - esoterismo\n    - raw\n" in text
    assert data["title"] == "Três Iniciados - Caibalion - 1908"
    # kb got a body-only Markdown that opens with the name's heading
    _topic, staged = kb.calls[0]
    assert staged.startswith("# Três Iniciados - Caibalion - 1908\n\n")
    assert not (vault / ".kb-map" / "stage").exists() or not any(
        (vault / ".kb-map" / "stage").iterdir()
    )
    log = (vault / TOPIC / "log.md").read_text(encoding="utf-8")
    assert "] convert | kb-map convert: 1 documents" in log


def test_the_source_path_is_where_the_original_came_from(vault, tmp_path, kb, converters, capsys):
    inside = vault / "_extract" / "Livros" / "Caibalion.pdf"
    inside.parent.mkdir(parents=True)
    inside.write_bytes(b"%PDF caibalion")

    assert _run(vault, "convert", TOPIC, str(inside)) == 0
    assert _run(vault, "convert", TOPIC, str(_pdf(tmp_path, "Outro.pdf", b"%PDF outro"))) == 0
    assert (
        _run(
            vault,
            "convert",
            TOPIC,
            str(_pdf(tmp_path, "x.pdf", b"%PDF up")),
            "--name",
            "Up.pdf",
            "--source-path",
            "upload/Up.pdf",
        )
        == 0
    )

    data = {d["original_name"]: d for d in _all_provenance(vault)}
    assert data["Caibalion.pdf"]["source_path"] == "_extract/Livros/Caibalion.pdf"
    assert data["Outro.pdf"]["source_path"] == "Outro.pdf"  # outside the vault: never a home path
    assert data["Up.pdf"]["source_path"] == "upload/Up.pdf"


def _all_provenance(vault):
    out = []
    for path in (vault / TOPIC / "raw").rglob("*.md"):
        data = split_frontmatter(path.read_text(encoding="utf-8")).data
        if "original_sha256" in data:
            out.append(data)
    return out


def test_the_same_original_twice_is_the_existing_document(vault, tmp_path, kb, converters, capsys):
    pdf = _pdf(tmp_path)
    assert _run(vault, "convert", TOPIC, str(pdf), "--json") == 0
    first = json.loads(capsys.readouterr().out.strip())

    copy = _pdf(tmp_path, "Caibalion (cópia).pdf", pdf.read_bytes())
    assert _run(vault, "convert", TOPIC, str(copy), "--json") == 0
    again = json.loads(capsys.readouterr().out.strip())

    assert again["state"] == "duplicate"
    assert again["document"] == first["document"]
    assert len(kb.calls) == 1


def test_a_link_keeps_the_page_as_its_original(vault, kb, converters, capsys):
    url = "https://www.hermetismo.org/artigos/o-ritmo"
    assert _run(vault, "convert", TOPIC, url, "--json") == 0
    result = json.loads(capsys.readouterr().out.strip())

    assert result["state"] == "converted"
    _text, data, _body = _doc(vault, result["document"])
    assert data["source_path"] == url
    assert data["converter"] == "firecrawl"
    assert data["original_name"] == "page.html"
    assert (vault / TOPIC / result["original"]).read_bytes() == b"<html>page</html>"
    assert kb.calls[0][1].startswith("# hermetismo.org - Página de teste\n")

    assert _run(vault, "convert", TOPIC, url, "--json") == 0
    assert json.loads(capsys.readouterr().out.strip())["state"] == "duplicate"


def test_a_link_falls_back_to_jina_when_firecrawl_fails(vault, kb, converters, capsys):
    url = "https://example.org/pagina"
    firecrawl = StubConverter("firecrawl", fails={url})
    jina = StubConverter("jina", default="# Página\n\n" + "texto da página " * 10)
    converters["set"] = stub_set(links=(firecrawl, jina))

    assert _run(vault, "convert", TOPIC, url, "--json") == 0
    result = json.loads(capsys.readouterr().out.strip())

    assert _doc(vault, result["document"])[1]["converter"] == "jina"


def test_youtube_is_refused_it_goes_through_the_transcriber(vault, kb, converters, capsys):
    code = _run(vault, "convert", TOPIC, "https://youtu.be/abc123", "--json")

    assert code == 1
    result = json.loads(capsys.readouterr().out.strip())
    assert result["state"] == "failed"
    assert "transcriber" in result["detail"]
    assert kb.calls == []


def test_an_empty_conversion_writes_nothing_and_goes_to_review(
    vault, tmp_path, kb, converters, capsys
):
    converters["set"] = stub_set(pdf=StubConverter("docling", default="<!-- página 1 -->\n\n"))
    pdf = _pdf(tmp_path, "scan.pdf")

    assert _run(vault, "convert", TOPIC, str(pdf), "--json") == 1

    result = json.loads(capsys.readouterr().out.strip())
    assert result["state"] == "failed"
    assert "empty or unreadable" in result["detail"]
    assert kb.calls == []
    assert not (vault / TOPIC / "raw" / "_originals").exists()
    queue = read_json(MapLayout(Vault(vault).topic(TOPIC)).review_queue_file)
    assert queue[0]["kind"] == "convert"


def test_kb_finding_the_same_text_is_a_duplicate(vault, tmp_path, kb, converters, capsys):
    kb.triage = "duplicate-skipped"

    assert _run(vault, "convert", TOPIC, str(_pdf(tmp_path)), "--json") == 0

    result = json.loads(capsys.readouterr().out.strip())
    assert result == result | {"state": "duplicate", "document": "raw/articles/existing.md"}


def test_csv_and_json_go_as_they_are_with_a_page_that_describes_them(
    vault, tmp_path, kb, converters, capsys
):
    data_csv = tmp_path / "planetas.csv"
    data_csv.write_text("planeta,metal\nSol,ouro\nLua,prata\n", encoding="utf-8")
    data_json = tmp_path / "graus.json"
    data_json.write_text('[{"grau": 1}, {"grau": 2}]', encoding="utf-8")

    assert _run(vault, "convert", TOPIC, str(data_csv), str(data_json), "--json") == 0

    results = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]
    csv_body = _doc(vault, results[0]["document"])[2]
    assert "2 linhas e 2 colunas" in csv_body
    assert "| Sol | ouro |" in csv_body
    assert _doc(vault, results[0]["document"])[1]["converter"] == "none"
    assert "uma lista de 2 itens" in _doc(vault, results[1]["document"])[2]
    assert (vault / TOPIC / results[0]["original"]).read_text() == data_csv.read_text()


def test_a_markdown_original_is_never_kept_as_a_document(vault, tmp_path, kb, converters, capsys):
    note = tmp_path / "nota.md"
    note.write_text("# Nota\n\n" + "uma nota de estudo sobre o ritmo " * 3, encoding="utf-8")

    assert _run(vault, "convert", TOPIC, str(note), "--json") == 0

    result = json.loads(capsys.readouterr().out.strip())
    assert result["original"].endswith(".markdown")
    assert all("_originals" not in doc for doc in Vault(vault).topic(TOPIC).documents())


# ---- AC-4: a generated description is marked and never the author's words ----------------


def test_an_image_description_is_marked_as_generated(vault, tmp_path, kb, converters, capsys):
    ocr = StubConverter("docling", default="Mercúrio — Enxofre — Sal\n")
    calls = []

    def describe(path):
        calls.append(path.name)
        return "Um diagrama triangular com os três princípios alquímicos nos vértices.", 0.0004

    converters["set"] = stub_set(pdf=ocr, describe=describe)
    image = tmp_path / "triangulo.png"
    image.write_bytes(b"\x89PNG fake")

    assert _run(vault, "convert", TOPIC, str(image), "--json") == 0

    result = json.loads(capsys.readouterr().out.strip())
    assert result["usd"] == pytest.approx(0.0004)
    _text, data, body = _doc(vault, result["document"])
    assert data["generated_description"] is True
    assert f"## {GENERATED_HEADING}" in body
    assert "não é texto do autor" in body
    assert "## Texto da imagem (OCR)" in body
    assert calls == ["triangulo.png"]


def test_a_generated_description_is_out_of_the_map(vault, monkeypatch):
    from fakes import Model
    from kb_map.commands import _common

    write_doc(
        vault,
        "raw/articles/diagrama.md",
        "# Diagrama\n\n## Texto da imagem (OCR)\n\nMercúrio, Enxofre e Sal são os três "
        "princípios.\n\n## Descrição gerada\n\n> Descrição gerada por um modelo de visão a "
        "partir da imagem; não é texto do autor.\n\nUm triângulo com os princípios nos "
        "vértices.\n",
        author="José Laércio do Egito",
        author_group="mestre-laercio",
        generated_description="true",
    )
    provider = Model().provider()
    monkeypatch.setattr(_common, "provider_factory", lambda args, v: provider)

    assert _run(vault, "sections", TOPIC) == 0

    sections = read_json(
        MapLayout(Vault(vault).topic(TOPIC)).sections_file("raw/articles/diagrama.md")
    )["sections"]
    generated = [s for s in sections if s.get("heading") == "Descrição gerada"]
    assert generated
    for section in generated:
        assert section["status"] == "fora-do-mapa"
        assert "propositions" not in section
        assert "speaker" not in section
    assert any(s["status"] == "ok" for s in sections if s.get("heading") != "Descrição gerada")


# ---- FR-2: reconversion ------------------------------------------------------------------


PLAIN = (
    "A lei do ritmo rege todas as coisas do atomo as estrelas num fluxo e refluxo continuo "
    "Tudo e duplo tudo tem polos os opostos sao identicos em natureza e diferem em grau "
    "Ritmo Tudo flui e reflui Polaridade Tudo e duplo "
    "Nada esta parado tudo se move tudo vibra em frequencias diferentes e mensuraveis\n"
)


def _classified(vault, name="Caibalion.pdf"):
    return write_doc(
        vault,
        "raw/articles/caibalion-pdf.md",
        PLAIN,
        source_path=f"_convert/ready/dropbox/Livros/{name}.txt",
        author_group="mestre-laercio",
        author="José Laércio do Egito",
        related="\n    - '[[hermetismo/wiki/concepts/Ritmo]]'",
        genre="treatise",
    )


def _original(vault, relative="Livros/Caibalion.pdf", data=b"%PDF original"):
    path = vault / "_extract" / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_reconvert_swaps_the_body_and_keeps_the_id_and_every_key(vault, converters, capsys):
    doc_id = _classified(vault)
    original = _original(vault)
    before, before_data, _ = _doc(vault, doc_id)

    assert _run(vault, "reconvert", TOPIC) == 0

    after, data, body = _doc(vault, doc_id)
    assert (vault / TOPIC / doc_id).exists()
    for key in ("author_group", "author", "related", "genre", "source_path", "title", "type"):
        assert data[key] == before_data[key]
    head_before = before.split("---\n")[1]
    assert after.startswith("---\n" + head_before)  # kb's keys byte for byte, then provenance
    assert "# Capítulo 1" in body and "# Capítulo 3" in body
    assert data["original_sha256"] == sha256_file(original)
    assert data["original_name"] == "Caibalion.pdf"
    out = capsys.readouterr().out
    assert "replaced" in out
    assert "next: kb classify hermetismo" in out
    assert "] convert | kb-map reconvert: 1 replaced" in (vault / TOPIC / "log.md").read_text()


def test_a_poor_ocr_changes_nothing_and_goes_to_review(vault, converters, capsys):
    doc_id = _classified(vault)
    _original(vault)
    short = PLAIN[: int(len(PLAIN) * 0.3)]
    converters["set"] = stub_set(pdf=StubConverter("docling", default=short))
    before = (vault / TOPIC / doc_id).read_bytes()

    assert _run(vault, "reconvert", TOPIC) == 0

    assert (vault / TOPIC / doc_id).read_bytes() == before
    assert not (vault / TOPIC / "raw" / "_originals").exists()
    queue = read_json(MapLayout(Vault(vault).topic(TOPIC)).review_queue_file)
    assert queue[0]["kind"] == "reconvert"
    assert queue[0]["doc"] == doc_id
    assert "30 %" in queue[0]["reason"]

    # The next run leaves it waiting; --retry tries again.
    capsys.readouterr()
    assert _run(vault, "reconvert", TOPIC) == 0
    assert "review" in capsys.readouterr().out
    assert converters["set"].pdf.seen == ["Caibalion.pdf"]
    assert _run(vault, "reconvert", TOPIC, "--retry") == 0
    assert converters["set"].pdf.seen == ["Caibalion.pdf", "Caibalion.pdf"]


def test_dry_run_lists_and_changes_nothing(vault, converters, capsys):
    doc_id = _classified(vault)
    _original(vault)
    write_doc(vault, "raw/articles/perdido.md", PLAIN, source_path="_convert/ready/x/Sumiu.pdf.txt")
    before = (vault / TOPIC / doc_id).read_bytes()

    assert _run(vault, "reconvert", TOPIC, "--dry-run") == 0

    out = capsys.readouterr().out
    assert "would-convert" in out and doc_id in out
    assert "no-original" in out and "perdido.md" in out
    assert "(dry run): 1 no-original, 1 would-convert" in out
    assert (vault / TOPIC / doc_id).read_bytes() == before
    assert converters["set"].pdf.seen == []


def test_reconvert_resumes_where_it_stopped(vault, converters, capsys):
    for index in range(3):
        write_doc(
            vault,
            f"raw/articles/livro-{index}.md",
            PLAIN,
            source_path=f"_convert/ready/dropbox/Livros/Livro {index}.pdf.txt",
        )
        _original(vault, f"Livros/Livro {index}.pdf", f"%PDF {index}".encode())

    assert _run(vault, "reconvert", TOPIC, "--limit", "2") == 0
    assert "2 replaced" in capsys.readouterr().out
    assert _run(vault, "reconvert", TOPIC) == 0
    out = capsys.readouterr().out
    assert "1 replaced" in out and "2 current" in out
    assert _run(vault, "reconvert", TOPIC) == 0
    assert "3 current" in capsys.readouterr().out
    assert len(converters["set"].pdf.seen) == 3


def test_the_original_is_found_by_name_and_a_doubled_extension(vault, converters, capsys):
    doc_id = _classified(vault, name="O Dom Supremo.pdf.pdf")
    _original(vault, "Outra pasta/O Dom Supremo.pdf")

    assert _run(vault, "reconvert", TOPIC) == 0

    assert _doc(vault, doc_id)[1]["original_name"] == "O Dom Supremo.pdf"


def test_two_originals_with_the_same_name_are_ambiguous(vault, converters, capsys):
    _classified(vault, name="Apostila.pdf")
    _original(vault, "A/Apostila.pdf", b"%PDF a")
    _original(vault, "B/Apostila.pdf", b"%PDF b")

    assert _run(vault, "reconvert", TOPIC, "--from", str(vault / "_extract")) == 0

    assert "ambiguous: 2 files named Apostila.pdf" in capsys.readouterr().out
    assert converters["set"].pdf.seen == []


def test_track_documents_and_plain_text_originals_are_left_alone(vault, converters, capsys):
    write_doc(vault, "raw/media/aula/faixa-1.md", PLAIN, source_path="x")
    write_doc(vault, "raw/articles/nota.md", PLAIN, source_path="_extract/nota.txt")
    (vault / "_extract").mkdir()
    (vault / "_extract" / "nota.txt").write_text(PLAIN)

    assert _run(vault, "reconvert", TOPIC) == 0

    assert "kb-map reconvert: 1 skip" in capsys.readouterr().out
    assert converters["set"].pdf.seen == []


def test_what_kb_spent_ingesting_is_in_the_outcome(vault, tmp_path, kb, converters, capsys):
    kb.usd = 0.0021
    assert _run(vault, "convert", TOPIC, str(_pdf(tmp_path)), "--json") == 0
    outcome = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert outcome["usd"] == pytest.approx(0.0021)

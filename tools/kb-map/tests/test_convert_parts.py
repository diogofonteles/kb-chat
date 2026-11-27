"""The pieces of conversion on their own: frontmatter keys, names, quality, links, kb's output."""

import io
import json
import shutil
import subprocess
import urllib.error

import pytest

from kb_map.convert.converters import (
    ConversionFailed,
    ConverterMissing,
    DataPage,
    ImageConverter,
    as_docx,
)
from kb_map.convert.ingest import IngestFailed, KbIngestCli, parse_result, spend_of
from kb_map.convert.naming import heading_of, title_from_name
from kb_map.convert.pipeline import original_names
from kb_map.convert.provenance import replace_body, set_keys
from kb_map.convert.quality import useful_chars, verdict
from kb_map.convert.sources import Source, UnsupportedSource, source_of
from kb_map.convert.vision import DEFAULT_VISION_MODEL, VisionDescriber, vision_model
from kb_map.convert.web import FirecrawlConverter, JinaConverter

KB_HEADER = (
    "---\ndomain: esoterismo\ntags:\n    - esoterismo\n    - raw\ntitle: O Dom: Supremo\n"
    "related:\n    - '[[x]]'\n---\n"
)


def test_set_keys_adds_and_replaces_only_its_keys():
    text = KB_HEADER + "corpo\n"

    once = set_keys(text, {"original_name": 'Livro "A": 1.pdf', "converter": "docling"})
    twice = set_keys(once, {"converter": "markitdown"})

    assert twice.startswith(KB_HEADER[:-4])
    assert 'original_name: "Livro \\"A\\": 1.pdf"\n' in twice
    assert 'converter: "markitdown"\n' in twice and "docling" not in twice
    assert twice.endswith("---\ncorpo\n")


def test_set_keys_on_a_text_without_frontmatter_and_replace_body():
    assert set_keys("corpo", {"converted_at": "x", "generated_description": True}) == (
        '---\nconverted_at: "x"\ngenerated_description: true\n---\ncorpo'
    )
    assert replace_body(KB_HEADER + "velho\n", "novo\n") == KB_HEADER + "novo\n"


def test_names_follow_origin_title_year():
    assert (
        heading_of("O Caibalion", "Três Iniciados", "1908") == "Três Iniciados - O Caibalion - 1908"
    )
    assert heading_of("Só título") == "Só título"
    assert title_from_name("O_Dom  Supremo.pdf.pdf") == "O Dom Supremo"


def test_useful_characters_ignore_markup_and_page_markers():
    assert useful_chars("<!-- página 3 -->\n# A | b |\n|---|") == 2
    assert verdict("", None).startswith("empty or unreadable")
    assert verdict("a" * 100, "b" * 100) is None
    assert "30 %" in verdict("a" * 60, "b" * 200)


def test_original_names_from_the_vault_pipeline_paths():
    assert original_names("_convert/ready/dropbox/Livros/A.pdf.pdf.txt") == (
        "Livros/A.pdf.pdf",
        ["A.pdf.pdf", "A.pdf"],
    )
    assert original_names("_convert/ocr/scan/B.pdf.txt") == ("B.pdf", ["B.pdf"])
    assert original_names("outro/C.txt") == (None, ["C.txt"])


def test_sources_by_kind(tmp_path):
    for name, kind in (
        ("a.pdf", "pdf"),
        ("b.EPUB", "epub"),
        ("c.docx", "office"),
        ("d.png", "image"),
    ):
        (tmp_path / name).write_bytes(b"x")
        assert source_of(str(tmp_path / name)).kind == kind
    (tmp_path / "e.xyz").write_bytes(b"x")
    with pytest.raises(UnsupportedSource):
        source_of(str(tmp_path / "e.xyz"))
    assert source_of(str(tmp_path / "e.xyz"), name="Livro.pdf").kind == "pdf"
    assert source_of("https://ex.org/a").kind == "url"
    with pytest.raises(UnsupportedSource):
        source_of("https://www.youtube.com/watch?v=1")
    with pytest.raises(UnsupportedSource):
        source_of(str(tmp_path / "missing.pdf"))


def test_a_bad_json_is_a_failed_conversion(tmp_path):
    bad = tmp_path / "x.json"
    bad.write_text("{nope", encoding="utf-8")
    with pytest.raises(ConversionFailed):
        DataPage().convert(Source("data", "x.json", path=bad))


class _Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_firecrawl_sends_the_key_only_in_the_header():
    seen = []

    def opener(request, timeout):
        seen.append(request)
        body = {
            "success": True,
            "data": {
                "markdown": "# Página\n\ntexto",
                "rawHtml": "<p>texto</p>",
                "metadata": {"title": "Página"},
            },
        }
        return _Answer(json.dumps(body).encode())

    converter = FirecrawlConverter(key=lambda: "fc-secret", opener=opener)
    result = converter.convert(Source("url", "ex.org", url="https://ex.org/a"))

    assert result.title == "Página"
    assert result.original == b"<p>texto</p>"
    request = seen[0]
    assert request.get_header("Authorization") == "Bearer fc-secret"
    assert b"fc-secret" not in request.data
    assert "fc-secret" not in request.full_url


def test_firecrawl_without_a_key_or_with_an_error_fails_cleanly():
    with pytest.raises(ConversionFailed, match="FIRECRAWL_API_KEY"):
        FirecrawlConverter(key=lambda: None).convert(Source("url", "x", url="https://x.org"))

    def refusing(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 402, "Payment", {}, None)

    with pytest.raises(ConversionFailed, match="HTTP 402") as err:
        FirecrawlConverter(key=lambda: "fc-secret", opener=refusing).convert(
            Source("url", "x", url="https://x.org")
        )
    assert "fc-secret" not in str(err.value)


def test_jina_reads_the_page_and_its_html():
    formats = []

    def opener(request, timeout):
        formats.append(request.get_header("X-return-format"))
        assert request.get_header("Authorization") is None
        return _Answer(b"# Pagina\n\ntexto" if formats[-1] == "markdown" else b"<html/>")

    result = JinaConverter(key=lambda: None, opener=opener).convert(
        Source("url", "x", url="https://x.org/a")
    )

    assert formats == ["markdown", "html"]
    assert result.original == b"<html/>"
    assert result.converter == "jina"


def test_the_vision_model_comes_from_kb_toml_or_the_default(tmp_path):
    assert vision_model({}, None) == DEFAULT_VISION_MODEL
    assert vision_model({"vision": {"model": "x/y"}}, None) == "x/y"
    assert vision_model({"vision": {"model": "x/y"}}, "z/w") == "z/w"

    image = tmp_path / "a.png"
    image.write_bytes(b"png")

    def opener(request, timeout):
        assert request.get_header("Authorization") == "Bearer or-secret"
        body = json.loads(request.data)
        assert body["messages"][0]["content"][1]["image_url"]["url"].startswith(
            "data:image/png;base64,"
        )
        return _Answer(
            json.dumps(
                {"choices": [{"message": {"content": " Um diagrama. "}}], "usage": {"cost": 0.0002}}
            ).encode()
        )

    text, usd = VisionDescriber(model="m", key=lambda: "or-secret", opener=opener)(image)
    assert (text, usd) == ("Um diagrama.", 0.0002)


def test_kbs_receipts_are_its_spend_and_its_cap_is_not():
    output = (
        "decisions: 6 calls, 0 cache hits, US$ 0.0014\n"
        "generation: 1 calls, 0 cache hits, US$ 0.0006\n"
        "budget: US$ 0.5000 limit reached\n"
    )
    assert spend_of(output) == pytest.approx(0.002)
    assert spend_of("nothing") == 0


def fake_kb(tmp_path, stdout: str, code: int) -> KbIngestCli:
    binary = tmp_path / "kb"
    binary.write_text(f"#!/bin/sh\ncat <<'EOF'\n{stdout}\nEOF\nexit {code}\n", encoding="utf-8")
    binary.chmod(0o755)
    return KbIngestCli(tmp_path, str(binary))


def test_an_error_after_kb_wrote_the_document_keeps_the_document(tmp_path):
    written = '{"topic": "t", "filePath": "t/raw/articles/a.md", "triage": "kept"}'
    receipt = "decisions: 1 calls, 0 cache hits, US$ 0.0010"
    result = fake_kb(tmp_path, f"{written}\n{receipt}", 1).ingest_file("t", tmp_path / "a.md", 0.1)
    assert result.file_path == "t/raw/articles/a.md"
    assert result.usd == pytest.approx(0.001)
    with pytest.raises(IngestFailed) as failed:
        fake_kb(tmp_path, receipt, 1).ingest_file("t", tmp_path / "a.md", 0.1)
    assert failed.value.usd == pytest.approx(0.001)


@pytest.mark.skipif(shutil.which("textutil") is None, reason="textutil is macOS")
@pytest.mark.parametrize("extension", ["doc", "odt", "rtf"])
def test_old_word_opendocument_and_rtf_become_word_first(tmp_path, extension):
    source = tmp_path / "nota.txt"
    source.write_text("O todo é mente.\n", encoding="utf-8")
    old = tmp_path / f"nota.{extension}"
    subprocess.run(
        ["textutil", "-convert", extension, "-output", str(old), str(source)], check=True
    )
    folder = tmp_path / "out"
    folder.mkdir()
    docx = as_docx(old, folder)
    assert docx.read_bytes()[:2] == b"PK"


def test_without_textutil_an_old_format_says_what_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    with pytest.raises(ConverterMissing, match="textutil"):
        as_docx(tmp_path / "a.doc", tmp_path)


def test_an_image_keeps_its_text_when_the_description_fails(tmp_path):
    image = tmp_path / "a.png"
    image.write_bytes(b"png")

    def broken(_path):
        raise ConversionFailed("the vision model answered HTTP 502")

    class Ocr:
        text = "Texto da placa."

        def markdown_of(self, _path):
            return self.text

        def version(self):
            return "1"

    ocr = Ocr()
    source = Source("image", "a.png", path=image)
    converted = ImageConverter(ocr=ocr, describe=broken).convert(source)
    assert "Texto da placa." in converted.markdown
    assert not converted.generated_description
    ocr.text = ""
    with pytest.raises(ConversionFailed, match="502"):
        ImageConverter(ocr=ocr, describe=broken).convert(source)


def test_kb_ingest_output_is_read_and_the_command_has_no_secret(tmp_path):
    stdout = (
        'gate dedupe: apply\n{\n  "topic": "t",\n  "filePath": "t/raw/articles/a.md",\n'
        '  "triage": "kept"\n}\nreceipt\n'
    )
    assert parse_result(stdout)["filePath"] == "t/raw/articles/a.md"
    with pytest.raises(IngestFailed):
        parse_result("nothing here")
    command = KbIngestCli(tmp_path, "kb").command("t", tmp_path / "a.md", 0.05)
    assert command == [
        "kb",
        "ingest",
        "file",
        str(tmp_path / "a.md"),
        "--topic",
        "t",
        "--budget",
        "0.0500",
    ]


def test_kb_ingest_has_no_fixed_limit(tmp_path, monkeypatch):
    """KBC-190: a long `kb ingest file` runs to its end; the transcriber watches it."""
    from kb_map.convert import ingest

    seen = []

    def run(command, **options):
        seen.append(options)
        written = '{"topic": "t", "filePath": "t/raw/articles/a.md", "triage": "kept"}'
        return subprocess.CompletedProcess(command, 0, written + "\n", "")

    monkeypatch.setattr(ingest.subprocess, "run", run)
    KbIngestCli(tmp_path, "kb").ingest_file("t", tmp_path / "a.md", 0.1)
    assert "timeout" not in seen[0]

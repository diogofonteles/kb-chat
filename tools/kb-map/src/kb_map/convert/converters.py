"""The converters, each behind one protocol, and the choice by kind (docs/research source-to-raw).

| kind            | converter                                                   |
|-----------------|-------------------------------------------------------------|
| pdf             | Docling: reading order, headings, tables, OCR, page markers |
| image           | Docling OCR + a short description marked as generated (BR-4)|
| office/epub/html| MarkItDown                                                  |
| url             | Firecrawl (the key in the Keychain), Jina Reader otherwise  |
| data (csv/json) | none: a short page that describes the file, the file kept   |
| text            | none: the text as it is                                     |

Docling and MarkItDown are imported only when used (`uv sync --extra convert` on the Mac);
tests replace the whole set through `pipeline.converter_factory`, so none runs in CI.
"""

import csv
import io
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Protocol

from .sources import Source

# A page break in a converted PDF: an HTML comment, invisible in the app and to the splitter's
# headings, kept so a citation can name its page.
PAGE_MARKER = "<!-- página {n} -->"
GENERATED_HEADING = "Descrição gerada"
GENERATED_NOTE = (
    "> Descrição gerada por um modelo de visão a partir da imagem; não é texto do autor."
)
OCR_HEADING = "Texto da imagem (OCR)"
DATA_PREVIEW_ROWS = 20


class ConversionFailed(Exception):
    """The converter ran and could not make Markdown of this source: the message says why."""


class ConverterMissing(ConversionFailed):
    """The converter's library is not installed on this machine."""


@dataclass(frozen=True)
class Conversion:
    markdown: str
    converter: str
    version: str
    title: str | None = None
    # A link has no file: the page as fetched is its original (BR-1).
    original: bytes | None = None
    original_name: str | None = None
    # The body holds a model's description (BR-4): marked in the text and the frontmatter.
    generated_description: bool = False
    usd: float = 0.0


class Converter(Protocol):
    name: str

    def version(self) -> str: ...

    def convert(self, source: Source) -> Conversion: ...


def package_version(name: str) -> str:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return "unknown"


def _require(module: str, extra: str = "convert"):
    try:
        return __import__(module, fromlist=["_"])
    except ImportError as err:
        raise ConverterMissing(
            f"{module} is not installed: run `uv sync --project tools/kb-map --extra {extra}`"
        ) from err


@dataclass
class DoclingConverter:
    """PDF (text or scanned) and images, with OCR and table structure, one page at a time."""

    name: str = "docling"
    _engine: object | None = field(default=None, init=False, repr=False)

    def version(self) -> str:
        return package_version("docling")

    def _converter(self):
        if self._engine is None:
            converter_mod = _require("docling.document_converter")
            base = _require("docling.datamodel.base_models")
            options = _require("docling.datamodel.pipeline_options")
            pipeline = options.PdfPipelineOptions(do_ocr=True, do_table_structure=True)
            self._engine = converter_mod.DocumentConverter(
                format_options={
                    base.InputFormat.PDF: converter_mod.PdfFormatOption(pipeline_options=pipeline),
                    base.InputFormat.IMAGE: converter_mod.ImageFormatOption(
                        pipeline_options=pipeline
                    ),
                }
            )
        return self._engine

    def markdown_of(self, path: Path) -> str:
        try:
            result = self._converter().convert(str(path))
        except ConverterMissing:
            raise
        except Exception as err:
            raise ConversionFailed(f"docling: {type(err).__name__}: {err}") from err
        document = result.document
        pages = sorted(getattr(document, "pages", {}) or {})
        if len(pages) <= 1:
            text = document.export_to_markdown()
        else:
            parts = []
            for number in pages:
                parts.append(PAGE_MARKER.format(n=number))
                parts.append(document.export_to_markdown(page_no=number).strip())
            text = "\n\n".join(part for part in parts if part)
        return text.strip() + "\n"

    def convert(self, source: Source) -> Conversion:
        if source.path is None:
            raise ConversionFailed("docling converts files only")
        return Conversion(self.markdown_of(source.path), self.name, self.version())


@dataclass
class MarkItDownConverter:
    """Word, PowerPoint, Excel, EPUB and saved HTML to Markdown with headings and lists."""

    name: str = "markitdown"

    def version(self) -> str:
        return package_version("markitdown")

    def convert(self, source: Source) -> Conversion:
        if source.path is None:
            raise ConversionFailed("markitdown converts files only")
        module = _require("markitdown")
        try:
            result = module.MarkItDown(enable_plugins=False).convert(str(source.path))
        except Exception as err:
            raise ConversionFailed(f"markitdown: {type(err).__name__}: {err}") from err
        text = (getattr(result, "text_content", None) or getattr(result, "markdown", "")).strip()
        title = getattr(result, "title", None)
        return Conversion(text + "\n", self.name, self.version(), title=title or None)


@dataclass
class PlainText:
    """A `.txt` or `.md` is already text: it goes as it is (its own original kept)."""

    name: str = "text"

    def version(self) -> str:
        return "1"

    def convert(self, source: Source) -> Conversion:
        if source.path is None:
            raise ConversionFailed("text converts files only")
        raw = source.path.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1")
        return Conversion(text.strip() + "\n", self.name, self.version())


@dataclass
class DataPage:
    """CSV and JSON stay as they are: the page describes the file and shows its first rows."""

    name: str = "none"

    def version(self) -> str:
        return "1"

    def convert(self, source: Source) -> Conversion:
        if source.path is None:
            raise ConversionFailed("data pages are made of files only")
        text = source.path.read_text(encoding="utf-8", errors="replace")
        is_csv = source.extension == ".csv"
        body = _csv_page(text) if is_csv else _json_page(text, source.extension)
        intro = (
            f"Arquivo de dados `{source.name}`, guardado como está (sem conversão). "
            "O arquivo completo é o original."
        )
        return Conversion(f"{intro}\n\n{body}".strip() + "\n", self.name, self.version())


def _csv_page(text: str) -> str:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return "O arquivo está vazio."
    header, data = rows[0], rows[1:]
    width = len(header)
    cell = lambda value: value.replace("|", "\\|").replace("\n", " ").strip()  # noqa: E731
    lines = [
        f"{len(data)} linhas e {width} colunas: {', '.join(cell(name) for name in header)}.",
        "",
        "| " + " | ".join(cell(name) for name in header) + " |",
        "|" + "---|" * width,
    ]
    for row in data[:DATA_PREVIEW_ROWS]:
        padded = (row + [""] * width)[:width]
        lines.append("| " + " | ".join(cell(value) for value in padded) + " |")
    if len(data) > DATA_PREVIEW_ROWS:
        lines += ["", f"(as primeiras {DATA_PREVIEW_ROWS} linhas)"]
    return "\n".join(lines)


def _json_page(text: str, extension: str) -> str:
    try:
        if extension == ".jsonl":
            values = [json.loads(line) for line in text.splitlines() if line.strip()]
            shape = f"{len(values)} registros (JSON Lines)"
            sample = values[:3]
        else:
            value = json.loads(text)
            if isinstance(value, list):
                shape, sample = f"uma lista de {len(value)} itens", value[:3]
            elif isinstance(value, dict):
                shape, sample = f"um objeto com as chaves {', '.join(list(value)[:20])}", value
            else:
                shape, sample = "um valor simples", value
    except json.JSONDecodeError as err:
        raise ConversionFailed(f"the JSON does not parse: {err.msg}") from err
    preview = json.dumps(sample, ensure_ascii=False, indent=2)[:4000]
    return f"O arquivo tem {shape}.\n\n```json\n{preview}\n```"


Describe = Callable[[Path], tuple[str, float]]


@dataclass
class ImageConverter:
    """The text in the image (Docling's OCR) and a short description by a cheap vision model.

    The description sits under its own heading, `Descrição gerada`, with a note saying it is
    not the author's text, and the frontmatter carries `generated_description: true` (BR-4).
    kb-map's sections take that heading out of the map, so no citation gives it as the
    author's words.
    """

    ocr: DoclingConverter
    describe: Describe | None
    name: str = "docling+vision"

    def version(self) -> str:
        return self.ocr.version()

    def convert(self, source: Source) -> Conversion:
        if source.path is None:
            raise ConversionFailed("images are files")
        text = self.ocr.markdown_of(source.path)
        parts: list[str] = []
        if text.strip():
            parts += [f"## {OCR_HEADING}", "", text.strip(), ""]
        usd = 0.0
        generated = False
        if self.describe is not None:
            description, usd = self.describe(source.path)
            if description.strip():
                generated = True
                parts += [f"## {GENERATED_HEADING}", "", GENERATED_NOTE, "", description.strip()]
        if not parts:
            raise ConversionFailed("the image has no text and no description")
        return Conversion(
            "\n".join(parts).strip() + "\n",
            self.name,
            self.version(),
            generated_description=generated,
            usd=usd,
        )


@dataclass
class ConverterSet:
    """The converter of each kind; a link tries Firecrawl, then Jina."""

    pdf: Converter
    image: Converter
    office: Converter
    data: Converter
    text: Converter
    links: tuple[Converter, ...]

    def for_kind(self, kind: str) -> Converter:
        table = {
            "pdf": self.pdf,
            "image": self.image,
            "office": self.office,
            "epub": self.office,
            "html": self.office,
            "data": self.data,
            "text": self.text,
        }
        if kind not in table:
            raise ConversionFailed(f"no converter for {kind}")
        return table[kind]

    def convert(self, source: Source) -> Conversion:
        if source.kind != "url":
            return self.for_kind(source.kind).convert(source)
        problems = []
        for converter in self.links:
            try:
                return converter.convert(source)
            except ConversionFailed as err:
                problems.append(f"{converter.name}: {err}")
        raise ConversionFailed("; ".join(problems) or "no link converter")

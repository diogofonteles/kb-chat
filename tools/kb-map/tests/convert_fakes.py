"""Stand-ins for the converters and for kb ingest: no library, no network, no binary."""

import re
from dataclasses import dataclass, field
from pathlib import Path

from kb_map.convert.converters import Conversion, ConversionFailed, ConverterSet, ImageConverter
from kb_map.convert.ingest import IngestResult
from kb_map.convert.sources import Source
from kb_map.textutil import slugify

THREE_CHAPTERS = """<!-- página 1 -->

# Capítulo 1 — A Lei do Ritmo

A lei do ritmo rege todas as coisas, do átomo às estrelas, num fluxo e refluxo contínuo.

<!-- página 2 -->

# Capítulo 2 — A Polaridade

Tudo é duplo, tudo tem polos; os opostos são idênticos em natureza e diferem em grau.

| Princípio | Enunciado |
|---|---|
| Ritmo | Tudo flui e reflui |
| Polaridade | Tudo é duplo |

<!-- página 3 -->

# Capítulo 3 — A Vibração

Nada está parado; tudo se move; tudo vibra em frequências diferentes e mensuráveis.
"""


@dataclass
class StubConverter:
    """Answers a fixed Markdown per file name (or fails), recording what it was given."""

    name: str
    answers: dict[str, str] = field(default_factory=dict)
    default: str | None = None
    fails: set[str] = field(default_factory=set)
    ver: str = "2.0.0"
    seen: list[str] = field(default_factory=list)

    def version(self) -> str:
        return self.ver

    def markdown_of(self, path: Path) -> str:
        self.seen.append(path.name)
        if path.name in self.fails:
            raise ConversionFailed(f"{self.name} could not read {path.name}")
        answer = self.answers.get(path.name, self.default)
        if answer is None:
            raise ConversionFailed(f"no stub answer for {path.name}")
        return answer

    def convert(self, source: Source) -> Conversion:
        if source.url:
            self.seen.append(source.url)
            if source.url in self.fails:
                raise ConversionFailed(f"{self.name} could not fetch")
            answer = self.answers.get(source.url, self.default) or ""
            return Conversion(
                answer,
                self.name,
                self.ver,
                title="Página de teste",
                original=b"<html>page</html>",
                original_name="page.html",
            )
        assert source.path is not None
        return Conversion(self.markdown_of(source.path), self.name, self.ver)


def stub_set(
    pdf: StubConverter | None = None,
    office: StubConverter | None = None,
    links: tuple[StubConverter, ...] = (),
    describe=None,
) -> ConverterSet:
    pdf = pdf or StubConverter("docling", default=THREE_CHAPTERS)
    from kb_map.convert.converters import DataPage, PlainText

    return ConverterSet(
        pdf=pdf,
        image=ImageConverter(ocr=pdf, describe=describe),  # type: ignore[arg-type]
        office=office or StubConverter("markitdown", default="# Título\n\nTexto do documento.\n"),
        data=DataPage(),
        text=PlainText(),
        links=links or (StubConverter("firecrawl", default="# Página\n\n" + "conteúdo " * 20),),
    )


@dataclass
class FakeKb:
    """`kb ingest file` as kb 0.0.12 does it: titled by the first line, its own frontmatter."""

    vault: Path
    triage: str = "kept"
    calls: list[tuple[str, str]] = field(default_factory=list)

    def ingest_file(self, topic: str, path: Path, budget_usd: float | None) -> IngestResult:
        text = path.read_text(encoding="utf-8")
        self.calls.append((topic, text))
        title = re.sub(r"^#+\s*", "", text.strip().splitlines()[0]).strip()
        relative = f"{topic}/raw/articles/{slugify(title)}.md"
        if self.triage == "duplicate-skipped":
            return IngestResult("", self.triage, duplicate_of="raw/articles/existing.md")
        target = self.vault / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            "---\n"
            "domain: esoterismo\n"
            'scraped: "2026-11-16"\n'
            "source_kind: document\n"
            f"source_path: {path.relative_to(self.vault).as_posix()}\n"
            "stage: raw\n"
            "tags:\n    - esoterismo\n    - raw\n"
            f"title: {title}\n"
            "type: source\n"
            f"triage: {self.triage}\n"
            f"---\n{text}",
            encoding="utf-8",
        )
        return IngestResult(relative, self.triage)

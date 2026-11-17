"""Document names: `<autor ou origem>-<título>-<ano>` (docs/research source-to-raw).

kb names a document from its first line, so the staged Markdown opens with a heading made of
those parts; kb's slug of it is the file name (`Paulo Coelho - O Dom Supremo - 1990` →
`paulo-coelho-o-dom-supremo-1990.md`).
"""

import re
from pathlib import Path

_SEPARATORS = re.compile(r"[_]+|\s+")


def title_from_name(name: str) -> str:
    """A readable title from a file name: no extension, underscores as spaces."""
    stem = Path(name).stem
    # "Livro.pdf.pdf" keeps one extension too many after the first stem.
    while Path(stem).suffix.lower() in (".pdf", ".docx", ".doc", ".epub", ".txt"):
        stem = Path(stem).stem
    return " ".join(_SEPARATORS.sub(" ", stem).split()) or "Documento"


def heading_of(title: str, origin: str | None = None, year: str | None = None) -> str:
    parts = [part.strip() for part in (origin, title, year) if part and part.strip()]
    return " - ".join(parts) or "Documento"

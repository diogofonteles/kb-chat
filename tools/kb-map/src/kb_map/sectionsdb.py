"""The written sections of a topic, read back for the tree, the dossiers and the check."""

from dataclasses import dataclass
from typing import Any

from .extract import STATUS_OK
from .layout import MapLayout, read_json


@dataclass(frozen=True)
class SectionRef:
    key: str  # "<doc id>#<section id>", the map's address of a section
    doc: str
    id: str
    number: int  # 1-based, shown as "§n"
    doc_title: str
    status: str
    start: int
    end: int
    context: str
    propositions: tuple[dict[str, str], ...]
    entities: tuple[str, ...]
    speaker: str
    group: str
    heading: str | None
    at: str | None

    def label(self) -> str:
        where = f" ({self.at})" if self.at else ""
        return f"§{self.number}{where}"

    def brief(self) -> dict[str, Any]:
        """What a model sees of a section: never the body, only what was extracted."""
        return {
            "key": self.key,
            "source": self.doc_title,
            "speaker": self.speaker,
            "group": self.group,
            **({"heading": self.heading} if self.heading else {}),
            "context": self.context,
            "propositions": [p["text"] for p in self.propositions],
        }

    def text(self) -> str:
        """Everything the section says in extracted form (for synonym and entity matching)."""
        parts = [self.context, self.heading or "", *(p["text"] for p in self.propositions)]
        return "\n".join(parts)


def section_key(doc: str, section_id: str) -> str:
    return f"{doc}#{section_id}"


def load_document_sections(layout: MapLayout, doc: str) -> dict[str, Any] | None:
    return read_json(layout.sections_file(doc))


def refs_of(data: dict[str, Any]) -> list[SectionRef]:
    doc = data["doc"]
    refs = []
    for number, section in enumerate(data.get("sections", []), start=1):
        speaker = section.get("speaker") or {}
        refs.append(
            SectionRef(
                key=section_key(doc, section["id"]),
                doc=doc,
                id=section["id"],
                number=number,
                doc_title=data.get("title") or doc,
                status=section["status"],
                start=section["start"],
                end=section["end"],
                context=section.get("context", ""),
                propositions=tuple(section.get("propositions", [])),
                entities=tuple(section.get("entities", [])),
                speaker=speaker.get("name", ""),
                group=speaker.get("group", ""),
                heading=section.get("heading"),
                at=section.get("at"),
            )
        )
    return refs


def load_sections(layout: MapLayout, only_ok: bool = True) -> dict[str, SectionRef]:
    """Every section of the topic, by key, in document order."""
    found: dict[str, SectionRef] = {}
    for doc in layout.section_docs():
        data = load_document_sections(layout, doc)
        if not data:
            continue
        for ref in refs_of(data):
            if not only_ok or ref.status == STATUS_OK:
                found[ref.key] = ref
    return found

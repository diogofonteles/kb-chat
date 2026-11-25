"""KBC-139: each source cut into sections with context, propositions, entities and speaker.

The cut points come from the splitter (headings, time anchors, paragraphs); the model only
chooses which of them to use and annotates each section. Its answer is validated before
anything is written (FR-3): positions on block edges inside the window, contiguous coverage
from the window's first to its last character, every heading honoured. One retry per window;
a second failure sends the document to the review queue and writes nothing for it.
"""

from dataclasses import dataclass
from typing import Any

from .authorship import default_speaker, group_of
from .convert.converters import GENERATED_HEADING
from .layout import FORMAT_VERSION, MapLayout, ReviewQueue, now, read_json, write_json
from .providers import Ledger, ProviderError, Request
from .splitter import Block, Window, blocks_of, windows_of
from .textutil import one_line
from .vault import Document, Topic

EXTRACTOR_VERSION = 1
STATUS_OK = "ok"
STATUS_OUT = "fora-do-mapa"
STATUSES = (STATUS_OK, STATUS_OUT)
# KBC-148 BR-4: a model's description of an image is never the author's teaching.
GENERATED_REASON = "descrição gerada por modelo, não é texto do autor"
ATTEMPTS = 2

SYSTEM = (
    "You index a study collection of Hermetic and esoteric teachings written in Brazilian "
    "Portuguese. You never add knowledge from outside the text you are given."
)

INSTRUCTIONS = """Split the window of a document into sections and annotate each one.

Rules:
- The window is given as numbered blocks with their `start` and `end` positions. A section is a
  run of consecutive blocks: its `start` is the `start` of its first block and its `end` the
  `end` of its last block. Use only those numbers.
- The sections cover the whole window, in order, with no gap and no overlap: the first starts at
  the first block's start, each next one starts where the previous ended, the last ends at the
  last block's end.
- Every position in `must_start_at` (a heading) starts a section.
- Aim for sections of about 1 to 3 pages (1500 to 6000 characters); keep a chapter whole when it
  is short.
- `status` is "ok" for teaching content, or "fora-do-mapa" for parts with no teaching (table of
  contents, index, catalogue card, bibliography, blank or garbled text) with a short `reason`.
- For an "ok" section: `context` is one line saying where it comes from and what it is about;
  `propositions` are the teachings it affirms, short and self-contained, in the document's own
  words when possible, nothing that the section does not say; each proposition has a `speaker`
  (who affirms it: the document's author, or the author it quotes); `entities` are the people,
  works, places and named concepts it mentions; `speaker` is who mainly speaks in the section.
- Write `context` and `propositions` in Portuguese (pt-BR).

Answer: {"sections": [{"start": int, "end": int, "status": "ok"|"fora-do-mapa", "reason": str,
"context": str, "propositions": [{"text": str, "speaker": str}], "entities": [str],
"speaker": str}]}"""


class InvalidSections(Exception):
    """The model's sections cannot be written: the message names the first problem."""


@dataclass(frozen=True)
class DocOutcome:
    doc: str
    state: str  # "written" | "unchanged" | "review" | "empty"
    detail: str = ""


def _payload(doc: Document, window: Window) -> dict[str, Any]:
    return {
        "document": {
            "id": doc.id,
            "title": doc.title,
            "author": doc.author,
            "author_group": doc.author_group,
        },
        "must_start_at": sorted(window.unit_starts),
        "blocks": [
            {
                "start": block.u16_start,
                "end": block.u16_end,
                **({"heading": block.heading} if block.heading else {}),
                **({"at": block.at} if block.at else {}),
                **({"speaker": block.speaker} if block.speaker else {}),
                "text": block.text.strip(),
            }
            for block in window.blocks
        ],
    }


def _text(value: Any) -> str:
    return one_line(str(value)) if isinstance(value, str | int | float) else ""


def validate_window(window: Window, answer: dict[str, Any], doc: Document) -> list[dict[str, Any]]:
    """The window's sections, normalised, or InvalidSections with the first problem found."""
    raw = answer.get("sections")
    if not isinstance(raw, list) or not raw:
        raise InvalidSections("no sections in the answer")
    starts = {block.u16_start for block in window.blocks}
    ends = {block.u16_end for block in window.blocks}
    expected = window.u16_start
    sections = []
    for item in raw:
        if not isinstance(item, dict):
            raise InvalidSections("a section is not an object")
        start, end = item.get("start"), item.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            raise InvalidSections("a section has no integer start/end")
        if start < window.u16_start or end > window.u16_end:
            raise InvalidSections(f"section {start}-{end} is outside the window")
        if start != expected:
            raise InvalidSections(f"coverage broken at {expected} (section starts at {start})")
        if start >= end or start not in starts or end not in ends:
            raise InvalidSections(f"section {start}-{end} is not on block edges")
        sections.append(_normalise(item, doc))
        expected = end
    if expected != window.u16_end:
        raise InvalidSections(f"coverage stops at {expected}, the window ends at {window.u16_end}")
    section_starts = {section["start"] for section in sections}
    missing = sorted(window.unit_starts - section_starts)
    if missing:
        raise InvalidSections(f"a heading at {missing[0]} does not start a section")
    return sections


def _normalise(item: dict[str, Any], doc: Document) -> dict[str, Any]:
    status = item.get("status")
    if status not in STATUSES:
        raise InvalidSections(f"unknown status {status!r}")
    fallback = default_speaker(doc.author, doc.author_group)
    speaker = _text(item.get("speaker")) or fallback
    section: dict[str, Any] = {"start": item["start"], "end": item["end"], "status": status}
    if status == STATUS_OUT:
        section["reason"] = _text(item.get("reason")) or "sem ensinamento"
        return section
    propositions = []
    for raw in item.get("propositions") or []:
        text = _text(raw.get("text") if isinstance(raw, dict) else raw)
        if not text:
            continue
        said_by = _text(raw.get("speaker")) if isinstance(raw, dict) else ""
        said_by = said_by or speaker
        propositions.append(
            {
                "text": text,
                "speaker": said_by,
                "group": group_of(said_by, doc.author, doc.author_group),
            }
        )
    if not propositions:
        raise InvalidSections(f"section {item['start']}-{item['end']} is ok with no proposition")
    context = _text(item.get("context"))
    if not context:
        raise InvalidSections(f"section {item['start']}-{item['end']} has no context")
    entities = sorted({_text(entity) for entity in item.get("entities") or [] if _text(entity)})
    section |= {
        "context": context,
        "propositions": propositions,
        "entities": entities,
        "speaker": {"name": speaker, "group": group_of(speaker, doc.author, doc.author_group)},
    }
    return section


def _decorate(sections: list[dict[str, Any]], blocks: list[Block]) -> list[dict[str, Any]]:
    """Ids, the heading in force and the first time anchor of each section. A heading always
    starts a section (validated), so the heading in force is the last one at or before it."""
    out = []
    for number, section in enumerate(sections, start=1):
        inside = [b for b in blocks if section["start"] <= b.u16_start < section["end"]]
        before = [b for b in blocks if b.u16_start <= section["start"] and b.heading is not None]
        heading = before[-1].heading if before else None
        at = next((block.at for block in inside if block.at), None)
        kept = _out_of_map(section, GENERATED_REASON) if heading == GENERATED_HEADING else section
        out.append(
            {"id": f"s{number:03d}", **kept}
            | ({"heading": heading} if heading else {})
            | ({"at": at} if at else {})
        )
    return out


def _out_of_map(section: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "start": section["start"],
        "end": section["end"],
        "status": STATUS_OUT,
        "reason": reason,
    }


def extract_document(
    topic: Topic, ledger: Ledger, queue: ReviewQueue, doc_id: str, force: bool = False
) -> DocOutcome:
    layout = MapLayout(topic)
    doc = topic.read(doc_id)
    target = layout.sections_file(doc_id)
    previous = read_json(target)
    if (
        not force
        and previous
        and previous.get("body_sha256") == doc.body_sha256
        and previous.get("extractor_version") == EXTRACTOR_VERSION
    ):
        return DocOutcome(doc_id, "unchanged")
    blocks = blocks_of(doc.body)
    sections: list[dict[str, Any]] = []
    for window in windows_of(blocks):
        problem = ""
        for _attempt in range(ATTEMPTS):
            request = Request("sections", SYSTEM, INSTRUCTIONS, _payload(doc, window))
            try:
                sections.extend(validate_window(window, ledger.ask_json(request), doc))
                problem = ""
                break
            except (InvalidSections, ProviderError) as err:
                problem = str(err)
        if problem:
            queue.put("sections", doc_id, doc=doc_id, reason=problem, body_sha256=doc.body_sha256)
            return DocOutcome(doc_id, "review", problem)
    queue.drop("sections", doc_id)
    write_json(
        target,
        {
            "format": FORMAT_VERSION,
            "doc": doc_id,
            "title": doc.title,
            "author": doc.author,
            "author_group": doc.author_group,
            "body_sha256": doc.body_sha256,
            "length": blocks[-1].u16_end if blocks else 0,
            "extractor_version": EXTRACTOR_VERSION,
            "provider": ledger.provider.name,
            "extracted_at": now(),
            "sections": _decorate(sections, blocks),
        },
    )
    return DocOutcome(doc_id, "written" if blocks else "empty")

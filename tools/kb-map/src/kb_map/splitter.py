"""Deterministic blocks and windows of a body: the only places a section may start or end.

A body is cut into blocks that cover it with no gap and no overlap:
- a Markdown heading is a block of its own and opens a new *unit* (a section never crosses a
  heading, so chapters of the structured Markdown of KBC-148 are respected);
- a paragraph that opens with a time anchor (`[m:ss]`, `[h:mm:ss]`, a transcribed track, ADR
  0035) is a block, with its time and its `**Speaker:**` label, so a track gets exactly the
  same treatment as a text, cut at anchors instead of headings;
- any other paragraph (lines up to a blank line) is a block.
Blank lines belong to the block before them. Units are grouped into windows of at most
`window_chars` for one model call; a unit larger than that is split at block edges.
"""

import re
from dataclasses import dataclass

from .textutil import utf16_len

HEADING = re.compile(r"^(#{1,6})[ \t]+(\S.*?)\s*#*\s*$")
ANCHOR = re.compile(r"^\[((?:\d+:)?\d{1,2}:\d{2})\]")
SPEAKER_LABEL = re.compile(r"^\[(?:\d+:)?\d{1,2}:\d{2}\]\s+\*\*([^*]+?):\*\*")
WINDOW_CHARS = 16_000


@dataclass(frozen=True)
class Block:
    start: int  # code points, in the NFC body
    end: int
    u16_start: int  # the API's count (UTF-16 units)
    u16_end: int
    text: str
    heading: str | None  # the heading text when this block is a heading line
    level: int | None
    at: str | None  # the time anchor that opens it, for track documents
    speaker: str | None  # the `**Name:**` label after the anchor


@dataclass(frozen=True)
class Window:
    blocks: tuple[Block, ...]
    unit_starts: frozenset[int]  # u16 starts inside the window where a section must start

    @property
    def u16_start(self) -> int:
        return self.blocks[0].u16_start

    @property
    def u16_end(self) -> int:
        return self.blocks[-1].u16_end


def blocks_of(body: str) -> list[Block]:
    lines = body.splitlines(keepends=True)
    starts: list[int] = []
    position = 0
    previous_blank = True
    previous_heading = False
    for line in lines:
        stripped = line.strip()
        blank = not stripped
        opens = not blank and (
            previous_blank
            or previous_heading
            or HEADING.match(stripped) is not None
            or ANCHOR.match(stripped) is not None
        )
        if opens:
            starts.append(position)
        previous_blank = blank
        previous_heading = not blank and HEADING.match(stripped) is not None
        position += len(line)
    if not starts:
        return [_block(body, 0, len(body))] if body else []
    starts[0] = 0  # leading blank lines belong to the first block
    bounds = [*starts, len(body)]
    blocks = []
    u16 = 0
    for i in range(len(starts)):
        block = _block(body, bounds[i], bounds[i + 1], u16)
        blocks.append(block)
        u16 = block.u16_end
    return blocks


def _block(body: str, start: int, end: int, u16_start: int = 0) -> Block:
    text = body[start:end]
    first = text.strip().splitlines()[0] if text.strip() else ""
    heading = HEADING.match(first)
    anchor = ANCHOR.match(first)
    speaker = SPEAKER_LABEL.match(first)
    return Block(
        start=start,
        end=end,
        u16_start=u16_start,
        u16_end=u16_start + utf16_len(text),
        text=text,
        heading=heading.group(2) if heading else None,
        level=len(heading.group(1)) if heading else None,
        at=anchor.group(1) if anchor else None,
        speaker=speaker.group(1).strip() if speaker else None,
    )


def units_of(blocks: list[Block]) -> list[list[Block]]:
    """Runs of blocks between headings: a heading opens a unit."""
    units: list[list[Block]] = []
    for block in blocks:
        if block.heading is not None or not units:
            units.append([block])
        else:
            units[-1].append(block)
    return units


def windows_of(blocks: list[Block], window_chars: int = WINDOW_CHARS) -> list[Window]:
    pieces: list[tuple[list[Block], bool]] = []
    for unit in units_of(blocks):
        split = _split_unit(unit, window_chars)
        pieces.extend((piece, index == 0) for index, piece in enumerate(split))
    windows: list[Window] = []
    current: list[Block] = []
    starts: set[int] = set()
    for piece, opens_unit in pieces:
        size = sum(len(block.text) for block in piece)
        current_size = sum(len(block.text) for block in current)
        if current and current_size + size > window_chars:
            windows.append(Window(tuple(current), frozenset(starts)))
            current, starts = [], set()
        if current and opens_unit:
            starts.add(piece[0].u16_start)
        current.extend(piece)
    if current:
        windows.append(Window(tuple(current), frozenset(starts)))
    return windows


def _split_unit(unit: list[Block], window_chars: int) -> list[list[Block]]:
    """A unit larger than a window, cut at block edges. The pieces are not new units: a
    section may not run across a window, but the cut between pieces is not a heading."""
    pieces: list[list[Block]] = [[]]
    size = 0
    for block in unit:
        if pieces[-1] and size + len(block.text) > window_chars:
            pieces.append([])
            size = 0
        pieces[-1].append(block)
        size += len(block.text)
    return pieces

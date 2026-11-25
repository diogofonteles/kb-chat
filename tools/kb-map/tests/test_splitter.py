"""The deterministic cut points: blocks cover the body, headings and anchors open blocks."""

import itertools

from kb_map.splitter import blocks_of, units_of, windows_of
from kb_map.textutil import utf16_len


def _cover(body, blocks):
    assert blocks[0].start == 0
    assert blocks[-1].end == len(body)
    for before, after in itertools.pairwise(blocks):
        assert before.end == after.start
    assert "".join(block.text for block in blocks) == body


def test_blocks_cover_the_body_and_headings_stand_alone():
    body = "\n\nIntro sem título.\nSegunda linha.\n\n## Capítulo\nTexto logo abaixo.\n\nOutro.\n"
    blocks = blocks_of(body)
    _cover(body, blocks)
    assert [b.heading for b in blocks] == [None, "Capítulo", None, None]
    assert blocks[0].text.startswith("\n\nIntro")  # leading blank lines go to the first block
    assert blocks[1].level == 2
    assert [len(u) for u in units_of(blocks)] == [1, 3]


def test_plain_text_without_structure_falls_back_to_paragraphs():
    body = "Um parágrafo.\n\nDois.\n\nTrês.\n"
    blocks = blocks_of(body)
    _cover(body, blocks)
    assert len(blocks) == 3
    assert len(units_of(blocks)) == 1


def test_each_time_anchor_opens_a_block_with_its_time_and_speaker():
    body = "[0:00] **Ana:** Bom dia.\n[1:05:09] Sem nome.\n\n[12:30] **Beto:** Fim.\n"
    blocks = blocks_of(body)
    _cover(body, blocks)
    assert [(b.at, b.speaker) for b in blocks] == [
        ("0:00", "Ana"),
        ("1:05:09", None),
        ("12:30", "Beto"),
    ]


def test_windows_respect_their_size_and_mark_where_headings_start():
    chapter = "# Capítulo {n}\n\n" + ("palavra " * 60) + "\n\n"
    body = "".join(chapter.format(n=n) for n in range(10))
    blocks = blocks_of(body)
    windows = windows_of(blocks, window_chars=1200)
    assert len(windows) > 1
    assert windows[0].u16_start == 0
    assert windows[-1].u16_end == utf16_len(body)
    for before, after in itertools.pairwise(windows):
        assert before.u16_end == after.u16_start
    for window in windows:
        starts = {b.u16_start for b in window.blocks if b.heading}
        assert window.unit_starts == starts - {window.u16_start}


def test_a_unit_larger_than_a_window_is_cut_at_block_edges():
    body = "# Longo\n\n" + "".join(f"Parágrafo {n} " + "x" * 300 + "\n\n" for n in range(20))
    windows = windows_of(blocks_of(body), window_chars=1000)
    assert len(windows) > 3
    assert all(sum(len(b.text) for b in w.blocks) <= 1000 for w in windows)
    assert all(w.unit_starts == frozenset() for w in windows)

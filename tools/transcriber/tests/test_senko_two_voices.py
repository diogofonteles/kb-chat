"""The real Senko on a short synthetic conversation in Portuguese (KBC-064).

Two macOS voices (Luciana and Reed, pt-BR) take turns: question, answer, question, answer.
The audio is made at test time with `say` and never kept. Runs only on a Mac with the
`diarize` extra (`uv sync --extra diarize`); elsewhere (CI on Linux) the engine is absent.
"""

import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from transcriber.audio import decode_pcm16k

senko = pytest.importorskip("senko", reason="the diarize extra is not installed")
if not shutil.which("say") or not shutil.which("ffmpeg"):
    pytest.skip("needs macOS `say` and ffmpeg", allow_module_level=True)

from transcriber.diarize import SenkoDiarizer, separate  # noqa: E402

LINES = [
    ("Luciana", "Mestre, o senhor está lembrado das circunstâncias que o trouxeram até aqui?"),
    (
        "Reed",
        "Lembro sim. Eu trabalhava numa empresa de construção civil e um amigo me "
        "convidou para conhecer a sessão. Foi assim que tudo começou na minha vida.",
    ),
    ("Luciana", "E qual seria a mensagem que o senhor daria a quem está chegando agora?"),
    ("Reed", "Que tenham paciência e firmeza. O caminho é longo, mas cada passo tem valor."),
]


def conversation(folder: Path) -> tuple[np.ndarray, list[tuple[float, float, str]]]:
    """The four lines with 0.6 s of silence between them, and where each one is."""
    pause = np.zeros(int(0.6 * 16000), dtype=np.float32)
    pieces: list[np.ndarray] = []
    spans: list[tuple[float, float, str]] = []
    at = 0.0
    for index, (voice, text) in enumerate(LINES):
        aiff = folder / f"{index}.aiff"
        subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True)
        pcm = decode_pcm16k(aiff)
        spans.append((at, at + len(pcm) / 16000, voice))
        pieces += [pcm, pause]
        at += (len(pcm) + len(pause)) / 16000
    return np.concatenate(pieces), spans


@pytest.fixture(scope="module")
def engine() -> SenkoDiarizer:
    return SenkoDiarizer()


@pytest.mark.parametrize("voices", [None, 2])
def test_senko_finds_the_two_voices_where_they_speak(tmp_path, engine, voices):
    pcm, spans = conversation(tmp_path)
    turns = separate(pcm, diarizer=engine, voices=voices, scratch=tmp_path)
    assert len({t["voice"] for t in turns}) == 2
    # Each line is spoken mostly by one voice, and the two speakers never share one.
    by_speaker: dict[str, set[str]] = {}
    for start, end, speaker in spans:
        middle = (start + end) / 2
        voice = next(t["voice"] for t in turns if t["start"] <= middle <= t["end"])
        by_speaker.setdefault(speaker, set()).add(voice)
    assert all(len(found) == 1 for found in by_speaker.values())
    assert by_speaker["Luciana"] != by_speaker["Reed"]
    # Nothing but the synthesized audio was written in the job folder.
    assert sorted(p.suffix for p in tmp_path.iterdir()) == [".aiff"] * 4

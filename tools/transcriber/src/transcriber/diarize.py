"""Separating the voices of one recording (KBC-064, ADR 0029 §1), engine-agnostic.

An engine (Senko now; pyannote community-1 later, behind the same protocol) returns its
turns and, in memory only, one centroid per voice. This module keeps one voice per instant,
joins voices down to the number a person announced (or to 10), and returns only
start, end and voice name: centroids never leave this process (BR-1).
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from .config import DIARIZE_PARAMETERS


@dataclass(frozen=True)
class Turn:
    start: float
    end: float
    voice: str


@dataclass
class Separation:
    """An engine's answer: turns, and per-voice centroids that stay in memory."""

    turns: list[Turn]
    centroids: Mapping[str, np.ndarray] = field(default_factory=dict)


class Diarizer(Protocol):
    """A diarization engine: 16 kHz mono PCM in, a separation out.

    `scratch` is the job's temporary folder, for an engine that needs files on disk; it is
    deleted with everything in it when the job ends.
    """

    engine: str
    model: str

    def __call__(self, pcm: np.ndarray, *, voices: int | None, scratch: Path) -> Separation: ...


def exclusive_turns(turns: Sequence[Turn]) -> list[Turn]:
    """One voice per instant: where two turns overlap, the later one takes over from its start."""
    ordered = sorted((t for t in turns if t.end > t.start), key=lambda t: (t.start, t.end))
    kept: list[Turn] = []
    for index, turn in enumerate(ordered):
        following = ordered[index + 1] if index + 1 < len(ordered) else None
        end = min(turn.end, following.start) if following else turn.end
        if end > turn.start:
            kept.append(Turn(round(turn.start, 3), round(end, 3), turn.voice))
    return kept


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0 else vector


def join_voices(separation: Separation, limit: int) -> list[Turn]:
    """Joins the two most alike voices (cosine of their centroids) until at most `limit`.

    A voice with no centroid joins the voice that speaks most. Centroids are only read here.
    """
    names = {t.voice for t in separation.turns}
    if len(names) <= limit:
        return list(separation.turns)
    alias = {name: name for name in names}
    centroids = {
        name: _unit(np.asarray(vector, dtype=np.float64))
        for name, vector in separation.centroids.items()
        if name in names
    }
    spoken = _speaking_time(separation.turns)
    while len(set(alias.values())) > limit:
        keep, drop = _closest_pair(set(alias.values()), centroids, spoken)
        for name, target in alias.items():
            if target == drop:
                alias[name] = keep
        if drop in centroids and keep in centroids:
            centroids[keep] = _unit(centroids[keep] + centroids[drop])
        spoken[keep] = spoken.get(keep, 0.0) + spoken.pop(drop, 0.0)
    return [Turn(t.start, t.end, alias[t.voice]) for t in separation.turns]


def _speaking_time(turns: Sequence[Turn]) -> dict[str, float]:
    spoken: dict[str, float] = {}
    for turn in turns:
        spoken[turn.voice] = spoken.get(turn.voice, 0.0) + turn.end - turn.start
    return spoken


def _closest_pair(
    voices: set[str], centroids: Mapping[str, np.ndarray], spoken: Mapping[str, float]
) -> tuple[str, str]:
    """The pair to join: (the one that speaks more, the other)."""
    without = sorted(v for v in voices if v not in centroids)
    if without:
        drop = without[0]
        keep = max((v for v in voices if v != drop), key=lambda v: spoken.get(v, 0.0))
        return keep, drop
    ordered = sorted(voices)
    best: tuple[float, str, str] | None = None
    for i, first in enumerate(ordered):
        for second in ordered[i + 1 :]:
            similarity = float(np.dot(centroids[first], centroids[second]))
            if best is None or similarity > best[0]:
                best = (similarity, first, second)
    if best is None:
        raise ValueError("nothing to join")
    _, first, second = best
    if spoken.get(first, 0.0) >= spoken.get(second, 0.0):
        return first, second
    return second, first


def separate(
    pcm: np.ndarray, *, diarizer: Diarizer, voices: int | None, scratch: Path
) -> list[dict]:
    """The turns to upload: exclusive, at most `voices` (or 10) voices, nothing else."""
    found = diarizer(pcm, voices=voices, scratch=scratch)
    limit = voices or DIARIZE_PARAMETERS["max_voices"]
    joined = join_voices(found, limit)
    # The separation, with its centroids, goes out of scope here: only plain turns remain.
    del found
    return [{"start": t.start, "end": t.end, "voice": t.voice} for t in exclusive_turns(joined)]


class SenkoDiarizer:
    """Senko (MIT; pyannote 3.0 segmentation + CAM++ on CoreML), loaded once, kept warm."""

    engine = "senko"

    def __init__(self) -> None:
        from importlib.metadata import version

        from senko import Diarizer as Senko

        self.model = f"senko {version('senko')} ({DIARIZE_PARAMETERS['senko_commit']})"
        self._senko = Senko(device="auto", warmup=True, quiet=True)

    def __call__(self, pcm: np.ndarray, *, voices: int | None, scratch: Path) -> Separation:
        spectral = self._senko.spectral_cluster.cluster
        # Recordings under 20 min use spectral clustering, which takes the number of voices.
        spectral.k = voices
        try:
            result = self._senko.diarize_samples(pcm, sample_rate=16_000)
        finally:
            spectral.k = None
        if result is None:  # no speech at all
            return Separation(turns=[])
        turns = [
            Turn(float(s["start"]), float(s["end"]), str(s["speaker"]))
            for s in result["merged_segments"]
        ]
        return Separation(turns=turns, centroids=dict(result["speaker_centroids"]))


def senko_or_none() -> Diarizer | None:
    """The Senko engine when installed (the `diarize` extra, Apple silicon); None otherwise."""
    try:
        import senko  # noqa: F401
    except ImportError:
        return None
    return _LazySenko()


class _LazySenko:
    """Loads Senko on the first separation (~10 s), not when the worker starts."""

    engine = "senko"

    def __init__(self) -> None:
        self._loaded: SenkoDiarizer | None = None

    @property
    def model(self) -> str:
        return self._load().model

    def _load(self) -> SenkoDiarizer:
        if self._loaded is None:
            self._loaded = SenkoDiarizer()
        return self._loaded

    def __call__(self, pcm: np.ndarray, *, voices: int | None, scratch: Path) -> Separation:
        return self._load()(pcm, voices=voices, scratch=scratch)

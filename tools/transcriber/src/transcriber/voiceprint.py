"""Voice prints on the Mac (KBC-071, ADR 0032): sensitive personal data, handled in memory only.

A print is the mean of ECAPA vectors over a voice's speech. It is made for a profile whose
consent the API recorded, or to compare a recording's voices with the profiles of its
collection. Nothing here writes to disk or logs a vector, and `wipe` zeroes the arrays when
the job ends (BR-5). With no profile for the job's collection, no vector is computed at all.
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .config import SAMPLE_RATE, VOICE_PARAMETERS

WINDOW_S = VOICE_PARAMETERS["window_s"]
HOP_S = VOICE_PARAMETERS["hop_s"]
BATCH = 64


class Embedder(Protocol):
    """A speaker model: fixed-length 16 kHz windows in, one vector per window out."""

    model: str

    def __call__(self, windows: np.ndarray) -> np.ndarray: ...


@dataclass(frozen=True)
class Span:
    """A stretch of one voice, in seconds."""

    start: float
    end: float


@dataclass
class Profile:
    """A profile sent for this job: wiped when the job ends."""

    id: str
    embedding: np.ndarray


def spans_of(raw: Iterable[Mapping]) -> list[Span]:
    """The API's spans (ms) as seconds."""
    return [Span(one["startMs"] / 1000, one["endMs"] / 1000) for one in raw]


def _windows(pcm: np.ndarray, spans: Sequence[Span]) -> np.ndarray:
    """Windows of WINDOW_S every HOP_S inside each span; a span too short gives none."""
    size = int(WINDOW_S * SAMPLE_RATE)
    hop = int(HOP_S * SAMPLE_RATE)
    pieces: list[np.ndarray] = []
    for span in spans:
        first = int(span.start * SAMPLE_RATE)
        last = min(int(span.end * SAMPLE_RATE), len(pcm))
        pieces.extend(pcm[start : start + size] for start in range(first, last - size + 1, hop))
    return np.stack(pieces) if pieces else np.empty((0, size), dtype=np.float32)


def _unit(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=-1, keepdims=True)
    return vectors / np.where(norms > 0, norms, 1.0)


def window_vectors(pcm: np.ndarray, spans: Sequence[Span], embedder: Embedder) -> np.ndarray:
    """One unit vector per window of the spans."""
    windows = _windows(pcm, spans)
    done = [embedder(windows[i : i + BATCH]) for i in range(0, len(windows), BATCH)]
    return _unit(np.concatenate(done)) if done else np.empty((0, 0))


def mean_print(vectors: Sequence[np.ndarray]) -> np.ndarray:
    """The print of a voice: the unit mean of its window vectors, wherever they came from."""
    joined = [v for v in vectors if len(v) > 0]
    if not joined:
        raise ValueError("no speech long enough to make a voice print")
    return _unit(np.concatenate(joined).mean(axis=0))


def wipe(arrays: Iterable[np.ndarray]) -> None:
    """Zeroes the arrays: they are gone before Python frees them."""
    for array in arrays:
        array.fill(0)


def closest(voice: np.ndarray, profiles: Sequence[Profile]) -> tuple[str, float] | None:
    """The closest profile and its cosine, or None when another comes within the margin.

    The margin is what kept a reader of the research apart from a speaker he sounds like:
    one above the threshold alone would be a false positive.
    """
    if not profiles:
        return None
    scores = sorted(
        ((float(np.dot(voice, one.embedding)), one.id) for one in profiles), reverse=True
    )
    best, profile_id = scores[0]
    if len(scores) > 1 and best - scores[1][0] < VOICE_PARAMETERS["margin"]:
        return None
    return profile_id, best


def match_voices(
    pcm: np.ndarray, turns: Sequence[Mapping], profiles: Sequence[Profile], embedder: Embedder
) -> list[dict]:
    """Per voice with enough speech, only its closest profile and the score (FR-3)."""
    by_voice: dict[str, list[Span]] = {}
    for turn in turns:
        by_voice.setdefault(turn["voice"], []).append(Span(turn["start"], turn["end"]))
    matches: list[dict] = []
    for voice, spans in by_voice.items():
        if sum(s.end - s.start for s in spans) < VOICE_PARAMETERS["min_speech_s"]:
            continue
        vectors = window_vectors(pcm, spans, embedder)
        if len(vectors) == 0:
            continue
        centroid = mean_print([vectors])
        found = closest(centroid, profiles)
        wipe([vectors, centroid])
        if found:
            matches.append(
                {"voice": voice, "profileId": found[0], "similarity": round(found[1], 4)}
            )
    return matches


class EcapaEmbedder:
    """ECAPA-TDNN (SpeechBrain, Apache-2.0), loaded on the first job, on the Mac's GPU."""

    model = VOICE_PARAMETERS["model"]

    def __init__(self) -> None:
        self._encoder = None

    def _load(self):
        if self._encoder is None:
            from pathlib import Path

            import torch
            from speechbrain.inference.speaker import EncoderClassifier

            device = "mps" if torch.backends.mps.is_available() else "cpu"
            self._encoder = EncoderClassifier.from_hparams(
                source=self.model,
                savedir=str(Path.home() / ".cache" / "nova-alexandria-ecapa"),
                run_opts={"device": device},
            )
        return self._encoder

    def __call__(self, windows: np.ndarray) -> np.ndarray:
        import torch

        encoder = self._load()
        with torch.no_grad():
            batch = torch.from_numpy(windows.astype(np.float32)).to(encoder.device)
            return encoder.encode_batch(batch).squeeze(1).cpu().numpy()


def ecapa_or_none() -> Embedder | None:
    """The speaker model when the `voiceprint` extra is installed; None otherwise."""
    try:
        import speechbrain  # noqa: F401
    except ImportError:
        return None
    return EcapaEmbedder()

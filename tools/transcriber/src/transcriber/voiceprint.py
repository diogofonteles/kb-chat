"""Voice prints on the Mac (KBC-071, ADR 0032): sensitive personal data, handled in memory only.

A print is the mean of ECAPA vectors over a voice's speech. It is made for a profile whose
consent the API recorded, or to compare a recording's voices with the profiles of its
collection. Nothing here writes to disk or logs a vector. The main arrays of a job (the prints
received, the window vectors, the print made) are in a `PrintHold`, zeroed when the job ends or
as soon as a revocation arrives (BR-2, BR-5). What is not: the arrays numpy makes on the way
(each concatenation and mean; a voice's centroid is zeroed right after use, outside the hold),
the model's tensors, on the GPU too, the JSON a print came in and the float lists sent. They are
released, not zeroed. With no profile for the job's collection, no vector is computed at all.
"""

import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .config import SAMPLE_RATE, VOICE_MODEL_REVISION, VOICE_PARAMETERS
from .transcribe import Stopped

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


def wipe(arrays: Iterable[np.ndarray]) -> None:
    """Zeroes the arrays: they are gone before Python frees them."""
    for array in arrays:
        array.fill(0)


class PrintHold:
    """The main arrays a job has of a print, which another thread can drop at any moment.

    The heartbeat drops it when the API names a revocation or the lease is gone, and a watcher
    when the API has not answered for too long. Neither waits for the job's thread, which sees
    it at the next batch: that keeps the bound of BR-2 on a source of any length.
    """

    def __init__(self, stopped: Callable[[], bool] = lambda: False) -> None:
        self._stopped = stopped
        self._lock = threading.Lock()
        self._arrays: list[np.ndarray] = []
        self._ids: list[str] = []
        self._dropped = False
        self._acknowledged_at = time.time()

    def keep(self, *arrays: np.ndarray) -> None:
        """Registers arrays to wipe; if the hold was dropped meanwhile, they go right away."""
        with self._lock:
            if self._dropped:
                wipe(arrays)
            else:
                self._arrays.extend(arrays)
        self.check()

    def compare(self, profiles: Sequence["Profile"], asked_at: float) -> None:
        """The prints the API sent when asked at `asked_at`: from now on each heartbeat names
        them."""
        self.acknowledge(asked_at)
        with self._lock:
            self._ids = [one.id for one in profiles]
        self.keep(*(one.embedding for one in profiles))

    def check(self) -> None:
        """Raises Stopped when this job must not go on with a print."""
        if self._dropped or self._stopped():
            raise Stopped

    def drop(self) -> None:
        with self._lock:
            self._dropped = True
            wipe(self._arrays)
            self._arrays.clear()
            self._ids.clear()

    def acknowledge(self, sent_at: float) -> None:
        """The API answered a request sent at `sent_at`: all it says is that no revocation had
        reached it by then. The time of the answer would let late answers stretch the bound."""
        with self._lock:
            self._acknowledged_at = max(self._acknowledged_at, sent_at)

    def profile_ids(self) -> list[str]:
        with self._lock:
            return list(self._ids)

    def unanswered_s(self) -> float:
        """Seconds holding a print with no answer from the API; wall clock, so a Mac that
        slept counts it. Nothing held, nothing to answer for."""
        with self._lock:
            held = bool(self._arrays)
            acknowledged_at = self._acknowledged_at
        return time.time() - acknowledged_at if held else 0.0


def spans_of(raw: Iterable[Mapping]) -> list[Span]:
    """The API's spans (ms) as seconds."""
    return [Span(one["startMs"] / 1000, one["endMs"] / 1000) for one in raw]


def _batches(pcm: np.ndarray, spans: Sequence[Span]) -> Iterator[np.ndarray]:
    """Windows of WINDOW_S every HOP_S inside each span, BATCH at a time, made as they are
    needed: a long source costs no more memory, and a stop lands between two batches.
    A span too short gives none."""
    size = int(WINDOW_S * SAMPLE_RATE)
    hop = int(HOP_S * SAMPLE_RATE)
    pieces: list[np.ndarray] = []
    for span in spans:
        first = int(span.start * SAMPLE_RATE)
        last = min(int(span.end * SAMPLE_RATE), len(pcm))
        for start in range(first, last - size + 1, hop):
            pieces.append(pcm[start : start + size])
            if len(pieces) == BATCH:
                yield np.stack(pieces)
                pieces = []
    if pieces:
        yield np.stack(pieces)


def _unit(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=-1, keepdims=True)
    return vectors / np.where(norms > 0, norms, 1.0)


def window_vectors(
    pcm: np.ndarray, spans: Sequence[Span], embedder: Embedder, hold: PrintHold | None = None
) -> np.ndarray:
    """One unit vector per window of the spans; raises Stopped between batches."""
    held = hold or PrintHold()
    done: list[np.ndarray] = []
    for windows in _batches(pcm, spans):
        held.check()
        vectors = embedder(windows)
        held.keep(vectors)
        done.append(vectors)
    if not done:
        return np.empty((0, 0))
    joined = np.concatenate(done)
    units = _unit(joined)
    held.keep(joined, units)
    return units


def mean_print(vectors: Sequence[np.ndarray]) -> np.ndarray:
    """The print of a voice: the unit mean of its window vectors, wherever they came from."""
    joined = [v for v in vectors if len(v) > 0]
    if not joined:
        raise ValueError("no speech long enough to make a voice print")
    return _unit(np.concatenate(joined).mean(axis=0))


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
    pcm: np.ndarray,
    turns: Sequence[Mapping],
    profiles: Sequence[Profile],
    embedder: Embedder,
    hold: PrintHold | None = None,
) -> list[dict]:
    """Per voice with enough speech, only its closest profile and the score (FR-3)."""
    held = hold or PrintHold()
    by_voice: dict[str, list[Span]] = {}
    for turn in turns:
        by_voice.setdefault(turn["voice"], []).append(Span(turn["start"], turn["end"]))
    matches: list[dict] = []
    for voice, spans in by_voice.items():
        if sum(s.end - s.start for s in spans) < VOICE_PARAMETERS["min_speech_s"]:
            continue
        vectors = window_vectors(pcm, spans, embedder, held)
        if len(vectors) == 0:
            continue
        centroid = mean_print([vectors])
        found = closest(centroid, profiles)
        wipe([vectors, centroid])
        # A print wiped by another thread meanwhile scores nothing that may be kept.
        held.check()
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
                revision=VOICE_MODEL_REVISION,
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

"""Speech detection with Silero VAD and the pilot's chunking (ADR 0023 §3)."""

from collections.abc import Callable, Sequence

import numpy as np

from .config import PARAMETERS, SAMPLE_RATE

Span = tuple[float, float]
SpeechFinder = Callable[[np.ndarray], list[Span]]

_model = None


def silero_speech(pcm: np.ndarray) -> list[Span]:
    """Speech spans (seconds) of a 16 kHz mono track, with the pilot's Silero parameters."""
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    global _model  # noqa: PLW0603 - the model loads once per process
    torch.set_num_threads(2)
    if _model is None:
        _model = load_silero_vad()
    params = {k: v for k, v in PARAMETERS["vad"].items() if k != "engine"}
    stamps = get_speech_timestamps(
        torch.from_numpy(np.ascontiguousarray(pcm, dtype=np.float32)),
        _model,
        sampling_rate=SAMPLE_RATE,
        return_seconds=True,
        **params,
    )
    return [(round(float(t["start"]), 3), round(float(t["end"]), 3)) for t in stamps]


def merge_chunks(spans: Sequence[Span], max_s: float = PARAMETERS["chunk_max_s"]) -> list[Span]:
    """Greedily merges speech spans into contiguous spans of at most `max_s` seconds."""
    out: list[list[float]] = []
    for start, end in spans:
        if out and end - out[-1][0] <= max_s:
            out[-1][1] = end
        else:
            out.append([start, end])
    return [(s, e) for s, e in out]


def speech_ratio(spans: Sequence[Span], duration_s: float) -> float:
    if duration_s <= 0:
        return 0.0
    speech = sum(max(0.0, e - s) for s, e in spans)
    return max(0.0, min(1.0, speech / duration_s))

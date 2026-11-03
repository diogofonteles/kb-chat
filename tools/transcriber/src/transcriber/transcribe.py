"""One track to its raw result: VAD chunks with the terms in every prompt (ADR 0023 §3)."""

import math
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import numpy as np

from .config import PARAMETERS, SAMPLE_RATE
from .vad import SpeechFinder, merge_chunks, speech_ratio


class WhisperModel(Protocol):
    """mlx_whisper.transcribe's signature (the real one, or a fake in tests)."""

    def __call__(self, audio: np.ndarray, **kwargs: Any) -> dict: ...


class Stopped(Exception):
    """A shutdown or a lost lease stopped the job between chunks: nothing is uploaded."""


@dataclass(frozen=True)
class TrackResult:
    raw: dict
    vad: Literal["applied", "skipped"]
    speech_ratio: float


TokenCounter = Callable[[str], int]


def estimate_tokens(text: str) -> int:
    """A conservative token count for Portuguese text when no tokenizer is at hand."""
    return -(-len(text.encode("utf-8")) // 2)


def build_prompt(
    terms: Sequence[str],
    max_tokens: int = PARAMETERS["prompt_max_tokens"],
    count: TokenCounter = estimate_tokens,
) -> str:
    """The terms as comma-separated words, cut at whole terms to fit whisper's prompt."""
    kept: list[str] = []
    for term in terms:
        candidate = ", ".join([*kept, term]) + "."
        if count(candidate) > max_tokens:
            break
        kept.append(term)
    return ", ".join(kept) + "." if kept else ""


def json_safe(value: Any) -> Any:
    """Whisper's output with numpy values turned into plain JSON types."""
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [json_safe(v) for v in value]
    if isinstance(value, np.ndarray):
        return json_safe(value.tolist())
    if isinstance(value, np.generic):
        return json_safe(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None  # whisper can give NaN (avg_logprob); JSON has no NaN
    return value


def ordered(result: dict) -> dict:
    """Times in order: a word or segment that ends before it starts ends where it starts.

    The API refuses `end < start`; whisper's word timestamps may cross by a few ms.
    """
    for segment in result.get("segments", []):
        _order(segment)
        for word in segment.get("words", []) or []:
            _order(word)
    return result


def _order(span: dict) -> None:
    start, end = span.get("start"), span.get("end")
    if isinstance(start, int | float) and isinstance(end, int | float) and end < start:
        span["end"] = start


def transcribe_track(
    pcm: np.ndarray,
    *,
    model: WhisperModel,
    prompt: str,
    find_speech: SpeechFinder,
    stop: threading.Event | None = None,
    on_progress: Callable[[int], None] | None = None,
) -> TrackResult:
    """Transcribes a 16 kHz mono track. Under 40 % speech the whole track goes without VAD."""
    duration = len(pcm) / SAMPLE_RATE
    spans = find_speech(pcm)
    ratio = speech_ratio(spans, duration)
    if ratio < PARAMETERS["min_speech_ratio"]:
        chunks, vad = [(0.0, round(duration, 3))], "skipped"
    else:
        chunks, vad = merge_chunks(spans), "applied"
    raw: dict = {
        "model": PARAMETERS["model"],
        "prompt": prompt,
        "vad": vad,
        "speechRatio": round(ratio, 4),
        "chunks": [],
    }
    for index, (start, end) in enumerate(chunks):
        if stop is not None and stop.is_set():
            raise Stopped
        piece = pcm[int(start * SAMPLE_RATE) : int(end * SAMPLE_RATE)]
        result = model(piece, **_options(prompt))
        raw["chunks"].append({"offset": start, "end": end, "result": ordered(json_safe(result))})
        if on_progress is not None:
            on_progress(int((index + 1) * 100 / len(chunks)))
    if stop is not None and stop.is_set():
        raise Stopped
    return TrackResult(raw=raw, vad=vad, speech_ratio=round(ratio, 4))


def _options(prompt: str) -> dict:
    options: dict = {
        "path_or_hf_repo": PARAMETERS["model"],
        "language": PARAMETERS["language"],
        "word_timestamps": PARAMETERS["word_timestamps"],
        "temperature": tuple(PARAMETERS["temperature"]),
        "condition_on_previous_text": PARAMETERS["condition_on_previous_text"],
    }
    if prompt:
        options["initial_prompt"] = prompt
    return options

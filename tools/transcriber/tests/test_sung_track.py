"""AC-3 (BR-4): a track that is only a sung "chamada" goes whole, without VAD, and is not empty.

The signal is synthetic (no recording in the repository): sustained vowels sung as harmonic
tones with vibrato and a slow swell, the kind of audio the real Silero VAD under-detects.
"""

import numpy as np
import pytest

from transcriber.transcribe import transcribe_track

from .conftest import FakeModel

SR = 16000


def sung_vowels(seconds: float = 12.0, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    notes = [196.0, 220.0, 246.9, 220.0]  # a slow G-A-B-A line, each note held 3 s
    pitch = np.repeat(notes, len(t) // len(notes) + 1)[: len(t)]
    pitch = pitch * (1 + 0.012 * np.sin(2 * np.pi * 5.5 * t))  # vibrato
    phase = 2 * np.pi * np.cumsum(pitch) / SR
    voice = sum((0.6 / k) * np.sin(k * phase) for k in range(1, 9))
    swell = 0.5 + 0.5 * np.sin(2 * np.pi * t / 3.0 - np.pi / 2)
    signal = 0.3 * voice * swell + 0.003 * rng.standard_normal(len(t))
    return signal.astype(np.float32)


def test_a_sung_track_is_transcribed_whole_without_vad():
    pytest.importorskip("silero_vad")
    from transcriber.vad import silero_speech

    model = FakeModel()
    pcm = sung_vowels()
    result = transcribe_track(pcm, model=model, prompt="Hoasca.", find_speech=silero_speech)
    assert result.speech_ratio < 0.40
    assert result.vad == "skipped"
    assert result.raw["chunks"][0]["offset"] == 0.0
    assert model.calls[0]["samples"] == len(pcm)
    assert result.raw["chunks"][0]["result"]["text"].strip() != ""

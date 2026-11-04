import json
import threading

import numpy as np
import pytest

from transcriber.config import PARAMETERS
from transcriber.transcribe import Stopped, build_prompt, json_safe, sanitized, transcribe_track
from transcriber.vad import merge_chunks, speech_ratio

from .conftest import FakeModel

SR = 16000


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def test_merges_speech_spans_into_chunks_of_at_most_28_s():
    spans = [(0.0, 10.0), (11.0, 20.0), (21.0, 30.0), (31.0, 40.0)]
    assert merge_chunks(spans) == [(0.0, 20.0), (21.0, 40.0)]
    assert merge_chunks([]) == []


def test_speech_ratio_is_the_share_of_speech_in_the_track():
    assert speech_ratio([(0.0, 3.0), (5.0, 6.0)], 10.0) == pytest.approx(0.4)
    assert speech_ratio([], 0.0) == 0.0


def test_puts_the_terms_in_every_chunk_with_the_pilot_parameters():
    model = FakeModel()
    pcm = silence(60)
    result = transcribe_track(
        pcm,
        model=model,
        prompt="Hoasca, Caiano.",
        find_speech=lambda _: [(0.0, 10.0), (12.0, 25.0), (30.0, 50.0)],
    )
    assert result.vad == "applied"
    assert len(model.calls) == 2
    for call in model.calls:
        assert call["initial_prompt"] == "Hoasca, Caiano."
        assert call["condition_on_previous_text"] is False
        assert call["temperature"] == (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
        assert call["language"] == "pt"
        assert call["word_timestamps"] is True
        assert call["path_or_hf_repo"] == "mlx-community/whisper-large-v3-turbo"
    assert [(c["offset"], c["end"]) for c in result.raw["chunks"]] == [(0.0, 25.0), (30.0, 50.0)]
    assert model.calls[0]["samples"] == 25 * SR


def test_transcribes_the_whole_track_without_vad_under_40_percent_speech():
    model = FakeModel()
    result = transcribe_track(
        silence(30), model=model, prompt="", find_speech=lambda _: [(0.0, 11.0)]
    )
    assert result.vad == "skipped"
    assert result.speech_ratio == pytest.approx(11 / 30, abs=1e-3)
    assert [(c["offset"], c["end"]) for c in result.raw["chunks"]] == [(0.0, 30.0)]
    assert model.calls[0]["samples"] == 30 * SR
    assert "initial_prompt" not in model.calls[0]


def test_the_raw_result_is_plain_json():
    result = transcribe_track(
        silence(5), model=FakeModel(), prompt="x.", find_speech=lambda _: [(0.0, 5.0)]
    )
    text = json.dumps(result.raw)
    assert '"tokens": [50365, 2111]' in text
    assert json_safe((np.int64(3), np.float32(0.5))) == [3, 0.5]


def test_stops_between_chunks_and_reports_progress():
    stop = threading.Event()
    progress: list[int] = []
    model = FakeModel(on_call=lambda n: stop.set() if n == 1 else None)
    with pytest.raises(Stopped):
        transcribe_track(
            silence(80),
            model=model,
            prompt="",
            find_speech=lambda _: [(0.0, 25.0), (26.0, 50.0), (51.0, 75.0)],
            stop=stop,
            on_progress=progress.append,
        )
    assert len(model.calls) == 1
    assert progress == [33]


def test_reports_each_cut_done_out_of_the_total():
    cuts = []
    transcribe_track(
        silence(80),
        model=FakeModel(),
        prompt="",
        find_speech=lambda _: [(0.0, 25.0), (26.0, 50.0), (51.0, 75.0)],
        on_cuts=lambda done, total: cuts.append((done, total)),
    )
    assert cuts == [(1, 3), (2, 3), (3, 3)]


def test_cuts_the_term_list_at_whole_terms_to_fit_the_prompt():
    terms = [f"Termo{i}" for i in range(100)]
    prompt = build_prompt(terms, max_tokens=20, count=lambda text: len(text.split(",")))
    assert prompt == ", ".join(terms[:20]) + "."
    assert build_prompt([], count=len) == ""
    assert PARAMETERS["prompt_max_tokens"] == 224


def test_nan_becomes_none_and_crossed_times_are_put_in_order():
    result = json_safe(
        {
            "segments": [
                {
                    "start": 1.0,
                    "end": 0.5,
                    "avg_logprob": float("nan"),
                    "compression_ratio": np.float32("inf"),
                    "words": [{"word": " a", "start": 0.9, "end": 0.8}],
                }
            ]
        }
    )
    (segment,) = sanitized(result)["segments"]
    assert segment["avg_logprob"] is None
    assert segment["compression_ratio"] is None
    assert segment["end"] == 1.0
    assert segment["words"][0]["end"] == 0.9


def test_spans_without_finite_times_are_dropped_before_upload():
    result = json_safe(
        {
            "segments": [
                {"start": float("nan"), "end": 1.0, "text": " lost"},
                {
                    "start": 1.0,
                    "end": 2.0,
                    "text": " kept",
                    "words": [
                        {"word": " kept", "start": 1.0, "end": 1.5},
                        {"word": " gone", "start": None, "end": 1.9},
                        {"word": " gone", "start": 1.6, "end": float("inf")},
                    ],
                },
            ]
        }
    )
    (segment,) = sanitized(result)["segments"]
    assert segment["text"] == " kept"
    assert [word["word"] for word in segment["words"]] == [" kept"]

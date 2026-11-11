"""KBC-071: only synthetic vectors and generated tones here, never a recording (BR-1)."""

import logging
import tempfile
from pathlib import Path

import numpy as np
import pytest

from transcriber.api import ApiClient
from transcriber.config import SAMPLE_RATE, VOICE_PARAMETERS
from transcriber.transcribe import Stopped
from transcriber.voiceprint import (
    PrintHold,
    Profile,
    Span,
    closest,
    match_voices,
    mean_print,
    spans_of,
    window_vectors,
    wipe,
)
from transcriber.worker import Worker

from .conftest import JOB, TOKEN, FakeModel
from .test_diarize import FakeDiarizer, interview

PROFILE_ID = "44444444-4444-4444-8444-444444444444"
AUDIO_PATH = f"/api/v1/media-worker/jobs/{JOB['id']}/audio/{JOB['mediaId']}"
VOICE_JOB = {
    **JOB,
    "kind": "voice-profile",
    "sources": [{"audioPath": AUDIO_PATH, "spans": [{"startMs": 0, "endMs": 30_000}]}],
}
DIARIZE_JOB = {**JOB, "kind": "diarize", "voices": None}


def unit(values: list[float]) -> np.ndarray:
    vector = np.asarray(values, dtype=np.float64)
    return vector / np.linalg.norm(vector)


class ToneEmbedder:
    """A vector from each window's strongest frequency: no speaker model, no real voice."""

    model = VOICE_PARAMETERS["model"]

    def __init__(self) -> None:
        self.windows = 0

    def __call__(self, windows: np.ndarray) -> np.ndarray:
        self.windows += len(windows)
        peaks = np.abs(np.fft.rfft(windows, axis=1)).argmax(axis=1) / windows.shape[1]
        return np.stack([np.cos(peaks * 40), np.sin(peaks * 40), np.ones(len(windows))], axis=1)


def tone(frequency: float, seconds: float) -> np.ndarray:
    times = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return np.sin(2 * np.pi * frequency * times).astype(np.float32)


def worker(api, *, embedder, pcm_seconds: float = 120.0) -> Worker:
    return Worker(
        api=ApiClient(api.url, lambda: TOKEN, "mac-test"),
        model=FakeModel(),
        find_speech=lambda _: [(0.0, 9.0)],
        decode=lambda path: tone(220.0, pcm_seconds),
        diarizer=FakeDiarizer(interview()),
        embedder=embedder,
        poll_s=0.01,
        error_backoff_s=0.01,
        unauthorized_backoff_s=0.01,
    )


def transcriber_folders() -> list[Path]:
    return list(Path(tempfile.gettempdir()).glob("transcriber-*"))


def test_spans_come_in_ms():
    assert spans_of([{"startMs": 1500, "endMs": 4000}]) == [Span(1.5, 4.0)]


def test_windows_stay_inside_the_spans_and_a_short_span_gives_none():
    embedder = ToneEmbedder()
    pcm = tone(220.0, 10.0)
    assert len(window_vectors(pcm, [Span(0.0, 1.0)], embedder)) == 0
    vectors = window_vectors(pcm, [Span(0.0, 3.0)], embedder)
    assert len(vectors) == 3
    assert np.linalg.norm(vectors, axis=1) == pytest.approx(1.0)


def test_a_print_is_the_unit_mean_of_every_source():
    voice = mean_print([np.array([[1.0, 0.0]]), np.array([[0.0, 1.0]])])
    assert voice == pytest.approx(unit([1.0, 1.0]))


def test_no_speech_makes_no_print():
    with pytest.raises(ValueError, match="no speech"):
        mean_print([np.empty((0, 0))])


def test_the_closest_profile_needs_the_margin_over_the_next():
    voice = unit([1.0, 0.0])
    clear = [Profile("a", unit([1.0, 0.1])), Profile("b", unit([0.0, 1.0]))]
    assert closest(voice, clear)[0] == "a"
    tied = [Profile("a", unit([1.0, 0.1])), Profile("b", unit([1.0, 0.12]))]
    assert closest(voice, tied) is None
    assert closest(voice, []) is None


def test_a_voice_with_little_speech_is_not_compared():
    embedder = ToneEmbedder()
    turns = [{"start": 0.0, "end": 9.0, "voice": "SPEAKER_01"}]
    profile = Profile(PROFILE_ID, unit([1.0, 0.0, 1.0]))
    assert match_voices(tone(220.0, 30.0), turns, [profile], embedder) == []
    assert embedder.windows == 0


def test_only_the_closest_profile_and_the_score_come_out():
    pcm = tone(220.0, 30.0)
    voice = mean_print([window_vectors(pcm, [Span(0.0, 12.0)], ToneEmbedder())])
    turns = [{"start": 0.0, "end": 12.0, "voice": "SPEAKER_01"}]
    matches = match_voices(pcm, turns, [Profile(PROFILE_ID, voice.copy())], ToneEmbedder())
    assert matches == [{"voice": "SPEAKER_01", "profileId": PROFILE_ID, "similarity": 1.0}]


def test_wipe_zeroes_what_it_is_given():
    array = np.ones(4)
    wipe([array])
    assert not array.any()


def test_the_worker_calculates_a_print_and_uploads_only_it(fake_api):
    fake_api.jobs = [dict(VOICE_JOB)]
    assert worker(fake_api, embedder=ToneEmbedder()).step() == "job"
    (body,) = fake_api.bodies("voice-print")
    assert set(body) == {"worker", "leaseId", "model", "embedding"}
    assert body["model"] == VOICE_PARAMETERS["model"]
    assert np.linalg.norm(body["embedding"]) == pytest.approx(1.0, abs=1e-5)


def test_a_source_with_no_long_speech_fails_the_job_without_a_print(fake_api):
    short = {**VOICE_JOB, "sources": [{"audioPath": AUDIO_PATH, "spans": []}]}
    fake_api.jobs = [short]
    worker(fake_api, embedder=ToneEmbedder()).step()
    assert fake_api.bodies("voice-print") == []
    assert fake_api.bodies("fail")[0]["failure"] == "conversion-failed"


def test_without_a_speaker_model_no_print_is_asked_or_fetched(fake_api):
    fake_api.jobs = [dict(DIARIZE_JOB)]
    fake_api.profiles = [{"id": PROFILE_ID, "model": "x", "embedding": [1.0]}]
    w = worker(fake_api, embedder=None)
    assert "voice-profile" not in w.kinds
    w.step()
    assert not [c for c in fake_api.calls if c[1].endswith("/voice-profiles")]
    (upload,) = fake_api.bodies("diarization")
    assert "voiceMatches" not in upload


def test_with_no_profile_in_the_collection_no_vector_is_computed(fake_api):
    fake_api.jobs = [dict(DIARIZE_JOB)]
    embedder = ToneEmbedder()
    worker(fake_api, embedder=embedder).step()
    assert embedder.windows == 0
    assert "voiceMatches" not in fake_api.bodies("diarization")[0]


def test_a_profile_of_another_model_is_not_compared(fake_api):
    fake_api.jobs = [dict(DIARIZE_JOB)]
    fake_api.profiles = [{"id": PROFILE_ID, "model": "other", "embedding": [1.0, 0.0, 0.0]}]
    embedder = ToneEmbedder()
    worker(fake_api, embedder=embedder).step()
    assert embedder.windows == 0


def test_ac6_a_separation_uploads_scores_and_leaves_no_print_behind(fake_api, caplog):
    caplog.set_level(logging.DEBUG, logger="transcriber")
    fake_api.jobs = [dict(DIARIZE_JOB)]
    vector = mean_print([window_vectors(tone(220.0, 30.0), [Span(0.0, 12.0)], ToneEmbedder())])
    fake_api.profiles = [
        {"id": PROFILE_ID, "model": ToneEmbedder.model, "embedding": vector.tolist()}
    ]
    before = transcriber_folders()
    assert worker(fake_api, embedder=ToneEmbedder()).step() == "job"
    (upload,) = fake_api.bodies("diarization")
    assert upload["voiceMatches"]
    assert set(upload["voiceMatches"][0]) == {"voice", "profileId", "similarity"}
    assert "embedding" not in str(upload)
    assert transcriber_folders() == before
    assert str(round(float(vector[0]), 4)) not in caplog.text
    assert "embedding" not in caplog.text


def test_the_profiles_sent_are_wiped_when_the_comparison_ends(fake_api, monkeypatch):
    kept: list[Profile] = []
    w = worker(fake_api, embedder=ToneEmbedder())
    profile = Profile(PROFILE_ID, unit([1.0, 0.0, 1.0]))
    kept.append(profile)
    monkeypatch.setattr(w, "_profiles_of", lambda job: kept)
    turns = [{"start": 0.0, "end": 12.0, "voice": "SPEAKER_01"}]
    w._matches(DIARIZE_JOB, tone(220.0, 30.0), turns, PrintHold())
    assert not profile.embedding.any()


def test_a_failed_comparison_keeps_the_separation(fake_api):
    fake_api.jobs = [dict(DIARIZE_JOB)]
    fake_api.status["voice-profiles"] = 500
    assert worker(fake_api, embedder=ToneEmbedder()).step() == "job"
    (upload,) = fake_api.bodies("diarization")
    assert upload["raw"]["turns"]
    assert "voiceMatches" not in upload


def test_a_token_that_may_not_read_prints_compares_nothing(fake_api):
    fake_api.jobs = [dict(DIARIZE_JOB)]
    fake_api.status["voice-profiles"] = 404
    embedder = ToneEmbedder()
    worker(fake_api, embedder=embedder).step()
    assert embedder.windows == 0


def test_a_failed_print_job_logs_the_type_of_the_error_and_not_its_message(fake_api, caplog):
    caplog.set_level(logging.DEBUG, logger="transcriber")
    fake_api.jobs = [dict(VOICE_JOB)]

    def explodes(_windows):
        raise RuntimeError("tensor([0.1234, 0.5678])")

    w = worker(fake_api, embedder=explodes)
    assert w.step() == "job-error"
    assert "RuntimeError" in caplog.text
    assert "0.1234" not in caplog.text
    assert "0.1234" not in str(fake_api.bodies("fail"))


def test_a_drop_while_the_body_is_made_uploads_nothing(fake_api, monkeypatch):
    hold = PrintHold()

    class DropsWhenRead(np.ndarray):
        def __iter__(self):
            hold.drop()
            return super().__iter__()

    monkeypatch.setattr(
        "transcriber.worker.mean_print", lambda _vectors: np.ones(3).view(DropsWhenRead)
    )
    w = worker(fake_api, embedder=ToneEmbedder())
    with pytest.raises(Stopped):
        w._upload_print(VOICE_JOB, [], hold)
    assert fake_api.bodies("voice-print") == []


def test_a_lost_lease_drops_the_print(fake_api, caplog):
    caplog.set_level(logging.WARNING, logger="transcriber")
    fake_api.jobs = [dict(VOICE_JOB)]
    fake_api.status["voice-print"] = 409
    worker(fake_api, embedder=ToneEmbedder()).step()
    assert "lease was lost" in caplog.text

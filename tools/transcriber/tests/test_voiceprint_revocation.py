"""KBC-071 BR-2, question 87: a revocation reaches the Mac during a job. Synthetic data only."""

import sys
import threading
import time
import types

import numpy as np

from transcriber.config import SAMPLE_RATE, VOICE_PARAMETERS
from transcriber.diarize import Separation, Turn
from transcriber.voiceprint import EcapaEmbedder, Profile

from .conftest import JOB
from .test_diarize import FakeDiarizer
from .test_voiceprint import (
    AUDIO_PATH,
    DIARIZE_JOB,
    PROFILE_ID,
    VOICE_JOB,
    ToneEmbedder,
    tone,
    unit,
    worker,
)

BEAT_S = 0.02
HOUR_MS = 3_600_000
# One revocation must never wait for the end of a source: a tenth of it at most.
A_FEW_BATCHES = 30


class SlowEmbedder(ToneEmbedder):
    """As slow as a batch on a busy Mac, scaled down; `first_batch` opens once it started."""

    def __init__(self, batch_s: float = BEAT_S) -> None:
        super().__init__()
        self.batch_s = batch_s
        self.batches = 0
        self.first_batch = threading.Event()

    def __call__(self, windows: np.ndarray) -> np.ndarray:
        self.batches += 1
        self.first_batch.set()
        time.sleep(self.batch_s)
        return super().__call__(windows)


def beating(api, embedder, *, pcm_seconds: float, **fields):
    w = worker(api, embedder=embedder)
    silence = np.zeros(int(pcm_seconds * SAMPLE_RATE), dtype=np.float32)
    w.decode = lambda path: silence
    w.heartbeat_s = BEAT_S
    for name, value in fields.items():
        setattr(w, name, value)
    return w


def comparing(api) -> None:
    """A separation with one print sent for it."""
    api.jobs = [dict(DIARIZE_JOB)]
    api.profiles = [
        {
            "id": PROFILE_ID,
            "model": VOICE_PARAMETERS["model"],
            "embedding": unit([1.0, 0.0, 1.0]).tolist(),
        }
    ]


def long_voice(w, seconds: float) -> None:
    w.diarizer = FakeDiarizer(
        Separation(
            turns=[Turn(0.0, seconds, "A")],
            centroids={"A": np.array([1.0, 0.0, 0.0])},
        )
    )


def test_each_heartbeat_names_the_prints_held_and_a_transcription_names_none(fake_api):
    comparing(fake_api)
    embedder = SlowEmbedder()
    w = beating(fake_api, embedder, pcm_seconds=240.0)
    long_voice(w, 240.0)
    w.step()
    beats = fake_api.bodies("heartbeat")
    assert any(beat.get("voiceProfiles") == [PROFILE_ID] for beat in beats)
    assert fake_api.bodies("diarization")[0]["voiceMatches"]


def test_a_revocation_during_a_comparison_stops_it_and_keeps_the_separation(fake_api):
    comparing(fake_api)
    fake_api.revoked = {PROFILE_ID}
    embedder = SlowEmbedder()
    w = beating(fake_api, embedder, pcm_seconds=3600.0)
    long_voice(w, 3600.0)
    assert w.step() == "job"
    assert embedder.batches < A_FEW_BATCHES
    (upload,) = fake_api.bodies("diarization")
    assert upload["raw"]["turns"]
    assert "voiceMatches" not in upload


def test_the_heartbeat_wipes_the_print_without_waiting_for_a_slow_batch(fake_api, monkeypatch):
    fake_api.jobs = [dict(DIARIZE_JOB)]
    embedding = unit([1.0, 0.0, 1.0])
    embedder = SlowEmbedder(batch_s=0.5)
    w = beating(fake_api, embedder, pcm_seconds=240.0)
    long_voice(w, 240.0)
    monkeypatch.setattr(w, "_profiles_of", lambda job: [Profile(PROFILE_ID, embedding)])
    run = threading.Thread(target=w.step)
    run.start()
    assert embedder.first_batch.wait(5)
    fake_api.revoked = {PROFILE_ID}
    revoked_at = time.monotonic()
    while embedding.any() and time.monotonic() - revoked_at < 5:
        time.sleep(0.001)
    wiped_in = time.monotonic() - revoked_at
    run.join()
    assert not embedding.any()
    assert wiped_in < 0.25


def test_without_an_answer_from_the_api_the_prints_go_all_the_same(fake_api):
    comparing(fake_api)
    fake_api.status["heartbeat"] = 500
    embedder = SlowEmbedder()
    w = beating(fake_api, embedder, pcm_seconds=3600.0, print_ack_s=0.1)
    long_voice(w, 3600.0)
    assert w.step() == "job"
    assert embedder.batches < A_FEW_BATCHES
    assert "voiceMatches" not in fake_api.bodies("diarization")[0]


def test_a_blip_of_the_api_does_not_cost_the_comparison(fake_api):
    comparing(fake_api)
    fake_api.status["heartbeat"] = 500
    threading.Timer(0.05, fake_api.status.clear).start()
    embedder = SlowEmbedder()
    w = beating(fake_api, embedder, pcm_seconds=240.0, print_ack_s=30.0)
    long_voice(w, 240.0)
    w.step()
    assert fake_api.bodies("diarization")[0]["voiceMatches"]


def a_long_source(hours: int) -> dict:
    spans = [{"startMs": 0, "endMs": hours * HOUR_MS}]
    return {**VOICE_JOB, "sources": [{"audioPath": AUDIO_PATH, "spans": spans}]}


def test_a_revoked_print_job_stops_within_a_batch_on_a_source_of_any_length(fake_api):
    fake_api.jobs = [a_long_source(1)]
    fake_api.status["heartbeat"] = 409
    embedder = SlowEmbedder()
    w = beating(fake_api, embedder, pcm_seconds=3600.0)
    assert w.step() == "job"
    assert embedder.batches < A_FEW_BATCHES
    assert fake_api.bodies("voice-print") == []


def test_a_print_job_without_an_answer_from_the_api_stops_too(fake_api):
    fake_api.jobs = [a_long_source(1)]
    fake_api.status["heartbeat"] = 500
    embedder = SlowEmbedder()
    w = beating(fake_api, embedder, pcm_seconds=3600.0, print_ack_s=0.1)
    w.step()
    assert embedder.batches < A_FEW_BATCHES
    assert fake_api.bodies("voice-print") == []


def test_a_shutdown_stops_a_print_job_within_a_batch(fake_api):
    fake_api.jobs = [a_long_source(1)]
    embedder = SlowEmbedder()
    w = beating(fake_api, embedder, pcm_seconds=3600.0)
    threading.Timer(0.05, w.stop.set).start()
    w.step()
    assert embedder.batches < A_FEW_BATCHES
    assert fake_api.bodies("voice-print") == []


def test_a_failure_in_a_print_job_sends_no_library_message(fake_api):
    secret = "0.1234567"

    class Broken(ToneEmbedder):
        def __call__(self, windows: np.ndarray) -> np.ndarray:
            raise RuntimeError(f"bad value {secret}")

    fake_api.jobs = [dict(VOICE_JOB)]
    worker(fake_api, embedder=Broken()).step()
    (failure,) = fake_api.bodies("fail")
    assert secret not in failure["detail"]


def test_an_odd_value_in_a_print_job_sends_no_library_message(fake_api):
    secret = "0.7654321"

    class Odd(ToneEmbedder):
        def __call__(self, windows: np.ndarray) -> np.ndarray:
            raise ValueError(f"bad value {secret}")

    fake_api.jobs = [dict(VOICE_JOB)]
    worker(fake_api, embedder=Odd()).step()
    (failure,) = fake_api.bodies("fail")
    assert secret not in failure["detail"]
    assert failure["failure"] == "conversion-failed"


def test_transcriptions_are_untouched(fake_api):
    fake_api.jobs = [dict(JOB)]
    w = worker(fake_api, embedder=ToneEmbedder())
    w.heartbeat_s = BEAT_S
    w.model.on_call = lambda _: time.sleep(BEAT_S * 3)
    w.decode = lambda path: tone(220.0, 2.0)
    assert w.step() == "job"
    assert all("voiceProfiles" not in beat for beat in fake_api.bodies("heartbeat"))


def test_the_speaker_model_is_pinned_to_one_commit(monkeypatch):
    seen: dict = {}

    def from_hparams(**kwargs):
        seen.update(kwargs)
        return "encoder"

    classifier = types.SimpleNamespace(from_hparams=from_hparams)
    speaker = types.ModuleType("speechbrain.inference.speaker")
    speaker.EncoderClassifier = classifier
    torch = types.ModuleType("torch")
    torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "speechbrain", types.ModuleType("speechbrain"))
    monkeypatch.setitem(sys.modules, "speechbrain.inference", types.ModuleType("inference"))
    monkeypatch.setitem(sys.modules, "speechbrain.inference.speaker", speaker)
    EcapaEmbedder()._load()
    assert len(seen["revision"]) == 40

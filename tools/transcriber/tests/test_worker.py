import logging
import threading
import time

import numpy as np
import pytest

from transcriber.api import ApiClient
from transcriber.audio import InvalidAudio
from transcriber.config import PARAMETERS, PARAMETERS_VERSION
from transcriber.worker import REVOKED, Worker

from .conftest import JOB, TOKEN, FakeModel


def worker(api, model=None, find_speech=None, decode=None, token=TOKEN, **kwargs) -> Worker:
    return Worker(
        api=ApiClient(api.url, lambda: token, "mac-test"),
        model=model or FakeModel(),
        find_speech=find_speech or (lambda _: [(0.0, 9.0)]),
        decode=decode or (lambda path: np.zeros(10 * 16000, dtype=np.float32)),
        poll_s=0.01,
        error_backoff_s=0.01,
        unauthorized_backoff_s=0.01,
        **kwargs,
    )


def test_leases_downloads_transcribes_and_uploads_the_raw_result(fake_api):
    downloaded = []

    def decode(path):
        downloaded.append((path.suffix, path.read_bytes()))
        return np.zeros(10 * 16000, dtype=np.float32)

    assert worker(fake_api, decode=decode).run(once=True) == 0
    lease = fake_api.bodies("lease")[0]
    assert lease == {"worker": "mac-test", "kinds": ["transcribe"]}
    assert downloaded == [(".flac", b"fake-flac")]
    audio = next(c for c in fake_api.calls if c[1].endswith("/audio"))
    assert audio[0] == "GET"
    (upload,) = fake_api.bodies("transcript")
    assert upload["worker"] == "mac-test"
    assert upload["leaseId"] == JOB["leaseId"]
    assert upload["provider"] == "mlx-whisper"
    assert upload["parametersVersion"] == PARAMETERS_VERSION
    assert upload["parameters"]["vad"] == PARAMETERS["vad"]
    assert upload["termsVersion"] == 1
    assert upload["vad"] == "applied"
    assert upload["speechRatio"] == pytest.approx(0.9)
    assert upload["raw"]["chunks"][0]["result"]["segments"][0]["text"] == " Existia um rei."
    assert upload["raw"]["prompt"] == "Hoasca, Mestre Gabriel, Caiano."
    posts = [c for c in fake_api.calls if c[0] == "POST"]
    assert all(
        {k.lower(): v for k, v in c[3].items()}.get("x-requested-with") == "kb-chat" for c in posts
    )


def test_an_empty_queue_is_idle(fake_api):
    fake_api.jobs.clear()
    assert worker(fake_api).step() == "idle"
    assert worker(fake_api).run(exit_when_idle=True) == 0
    assert fake_api.bodies("transcript") == []


def test_a_revoked_token_logs_and_backs_off(fake_api, caplog):
    caplog.set_level(logging.ERROR, logger="transcriber")
    assert worker(fake_api, token="revoked" * 6).step() == "revoked"
    assert REVOKED in caplog.text
    assert "revoked" * 6 not in caplog.text


def test_the_token_is_read_again_on_every_call(fake_api):
    tokens = iter(["old" * 15, TOKEN, TOKEN, TOKEN, TOKEN, TOKEN, TOKEN])
    w = worker(fake_api)
    w.api = ApiClient(fake_api.url, lambda: next(tokens), "mac-test")
    assert w.step() == "revoked"
    assert w.step() == "job"


def test_a_lost_lease_at_upload_drops_the_result(fake_api, caplog):
    fake_api.status["transcript"] = 409
    caplog.set_level(logging.WARNING, logger="transcriber")
    assert worker(fake_api).step() == "job"
    assert "lease was lost" in caplog.text


def test_a_lost_lease_on_heartbeat_stops_between_chunks(fake_api):
    fake_api.status["heartbeat"] = 409
    model = FakeModel(on_call=lambda n: time.sleep(0.15))
    spans = [(float(i * 30), float(i * 30 + 25)) for i in range(6)]
    w = worker(
        fake_api,
        model=model,
        find_speech=lambda _: spans,
        decode=lambda p: np.zeros(180 * 16000, dtype=np.float32),
        heartbeat_s=0.05,
    )
    w.step()
    assert len(model.calls) < 6
    assert fake_api.bodies("transcript") == []
    assert fake_api.bodies("heartbeat")[0]["leaseId"] == JOB["leaseId"]


def test_a_shutdown_stops_between_chunks_and_uploads_nothing(fake_api):
    stop = threading.Event()
    model = FakeModel(on_call=lambda n: stop.set())
    spans = [(0.0, 25.0), (30.0, 55.0), (60.0, 85.0)]
    w = worker(
        fake_api,
        model=model,
        find_speech=lambda _: spans,
        decode=lambda p: np.zeros(90 * 16000, dtype=np.float32),
        stop=stop,
    )
    assert w.run() == 0
    assert len(model.calls) == 1
    assert fake_api.bodies("transcript") == []
    assert fake_api.bodies("fail") == []


def test_undecodable_audio_fails_the_job_as_invalid(fake_api):
    def decode(path):
        raise InvalidAudio("moov atom not found")

    worker(fake_api, decode=decode).step()
    (fail,) = fake_api.bodies("fail")
    assert fail["failure"] == "invalid-audio"
    assert fail["detail"] == "moov atom not found"


def test_a_crash_fails_the_job_as_retryable(fake_api):
    def model(audio, **kwargs):
        raise RuntimeError("metal out of memory")

    worker(fake_api, model=model).step()
    (fail,) = fake_api.bodies("fail")
    assert fail["failure"] == "conversion-failed"
    assert "metal out of memory" in fail["detail"]


def test_audio_that_is_not_ours_is_dropped(fake_api):
    fake_api.status["audio"] = 404
    assert worker(fake_api).step() == "job"
    assert fake_api.bodies("transcript") == []
    assert fake_api.bodies("fail") == []


def test_an_unreachable_api_backs_off():
    api = type("Api", (), {"url": "http://127.0.0.1:9"})()
    assert worker(api).step() == "error"

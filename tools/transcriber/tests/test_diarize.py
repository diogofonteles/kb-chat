"""Voice separation (KBC-064): the rules on the engine's answer, and the worker's diarize job."""

import json
import tempfile
from pathlib import Path

import numpy as np
import pytest

from transcriber.api import ApiClient
from transcriber.config import DIARIZE_PARAMETERS, DIARIZE_PARAMETERS_VERSION
from transcriber.diarize import Separation, Turn, exclusive_turns, join_voices, separate
from transcriber.worker import Worker

from .conftest import JOB, TOKEN, FakeModel

DIARIZE_JOB = {**JOB, "kind": "diarize", "voices": None}
UPLOAD_KEYS = {
    "worker",
    "leaseId",
    "engine",
    "model",
    "parametersVersion",
    "parameters",
    "requestedVoices",
    "elapsedMs",
    "raw",
}


class FakeDiarizer:
    """Answers fixed turns and centroids; writes its centroids into the job's scratch folder,
    as an engine that keeps files on disk would (AC-3)."""

    engine = "senko"
    model = "fake senko"

    def __init__(self, separation: Separation) -> None:
        self.separation = separation
        self.calls: list[dict] = []
        self.scratch: Path | None = None

    def __call__(self, pcm: np.ndarray, *, voices: int | None, scratch: Path) -> Separation:
        self.calls.append({"samples": len(pcm), "voices": voices})
        self.scratch = scratch
        names = sorted(self.separation.centroids)
        if names:
            np.save(
                scratch / "centroids.npy", np.stack([self.separation.centroids[n] for n in names])
            )
        return self.separation


def interview() -> Separation:
    """Interviewer (A), the one who answers split in two groups (B1, B2), the audience (C)."""
    return Separation(
        turns=[
            Turn(0.0, 5.2, "A"),
            Turn(5.0, 15.3, "B1"),
            Turn(15.3, 22.0, "A"),
            Turn(22.0, 40.0, "B2"),
            Turn(40.0, 45.0, "C"),
            Turn(45.0, 60.0, "B1"),
        ],
        centroids={
            "A": np.array([1.0, 0.0, 0.0]),
            "B1": np.array([0.0, 1.0, 0.1]),
            "B2": np.array([0.0, 0.95, 0.2]),
            "C": np.array([0.6, 0.0, 0.8]),
        },
    )


def test_exclusive_turns_keep_one_voice_per_instant():
    turns = exclusive_turns([Turn(4.0, 8.0, "B"), Turn(0.0, 5.0, "A"), Turn(9.0, 9.0, "C")])
    assert turns == [Turn(0.0, 4.0, "A"), Turn(4.0, 8.0, "B")]


def test_join_voices_merges_the_most_alike_until_the_limit():
    joined = join_voices(interview(), 3)
    assert {t.voice for t in joined} == {"A", "B1", "C"}
    assert [t.voice for t in joined][3] == "B1"  # B2 joined B1, which speaks more
    two = join_voices(interview(), 2)
    assert len({t.voice for t in two}) == 2


def test_join_voices_leaves_a_separation_within_the_limit_alone():
    separation = interview()
    assert join_voices(separation, 10) == separation.turns


def test_a_voice_without_centroid_joins_the_one_that_speaks_most():
    separation = Separation(
        turns=[Turn(0, 1, "X"), Turn(1, 10, "Y"), Turn(10, 12, "Z")],
        centroids={"Y": np.array([1.0, 0.0]), "Z": np.array([0.0, 1.0])},
    )
    assert [t.voice for t in join_voices(separation, 2)] == ["Y", "Y", "Z"]


def test_separate_caps_voices_at_ten_and_sends_plain_turns(tmp_path):
    rng = np.random.default_rng(1)
    names = [f"S{i}" for i in range(12)]
    separation = Separation(
        turns=[Turn(float(i), float(i) + 0.9, name) for i, name in enumerate(names)],
        centroids={name: rng.normal(size=8) for name in names},
    )
    turns = separate(
        np.zeros(16000, dtype=np.float32),
        diarizer=FakeDiarizer(separation),
        voices=None,
        scratch=tmp_path,
    )
    assert len({t["voice"] for t in turns}) == DIARIZE_PARAMETERS["max_voices"]
    assert all(set(t) == {"start", "end", "voice"} for t in turns)


def test_an_announced_number_of_voices_is_honoured(tmp_path):
    turns = separate(
        np.zeros(16000, dtype=np.float32),
        diarizer=FakeDiarizer(interview()),
        voices=2,
        scratch=tmp_path,
    )
    assert len({t["voice"] for t in turns}) == 2


def test_no_speech_gives_no_turns(tmp_path):
    turns = separate(
        np.zeros(16000, dtype=np.float32),
        diarizer=FakeDiarizer(Separation(turns=[])),
        voices=None,
        scratch=tmp_path,
    )
    assert turns == []


def diarizing_worker(api, diarizer, **kwargs) -> Worker:
    return Worker(
        api=ApiClient(api.url, lambda: TOKEN, "mac-test"),
        model=FakeModel(),
        find_speech=lambda _: [(0.0, 9.0)],
        decode=lambda path: np.zeros(60 * 16000, dtype=np.float32),
        poll_s=0.01,
        error_backoff_s=0.01,
        unauthorized_backoff_s=0.01,
        diarizer=diarizer,
        **kwargs,
    )


def leftover_scratch() -> list[Path]:
    return list(Path(tempfile.gettempdir()).glob("transcriber-*"))


def test_the_worker_leases_a_separation_and_uploads_only_the_turns(fake_api):
    """AC-1, AC-3, NFR-3: no voice print leaves the Mac nor stays on it."""
    fake_api.jobs = [dict(DIARIZE_JOB, voices=3)]
    before = set(leftover_scratch())
    diarizer = FakeDiarizer(interview())
    assert diarizing_worker(fake_api, diarizer).run(once=True) == 0

    assert fake_api.bodies("lease")[0]["kinds"] == ["transcribe", "diarize"]
    assert diarizer.calls == [{"samples": 60 * 16000, "voices": 3}]
    (upload,) = fake_api.bodies("diarization")
    assert set(upload) == UPLOAD_KEYS
    assert upload["engine"] == "senko"
    assert upload["parametersVersion"] == DIARIZE_PARAMETERS_VERSION
    assert upload["requestedVoices"] == 3
    # The API takes plain parameter values only (BR-1): nothing here may hold a vector.
    assert all(isinstance(v, str | int | float | bool) for v in upload["parameters"].values())
    assert set(upload["raw"]) == {"turns"}
    assert len({t["voice"] for t in upload["raw"]["turns"]}) == 3
    # Only names and times travel: no vector, under any key, in the turns.
    assert all(set(turn) == {"start", "end", "voice"} for turn in upload["raw"]["turns"])
    assert "[" not in json.dumps(upload["raw"]["turns"][0])
    # The scratch folder with the engine's files is gone, and nothing new is left behind.
    assert diarizer.scratch is not None
    assert not diarizer.scratch.exists()
    assert set(leftover_scratch()) == before
    assert fake_api.bodies("transcript") == []


def test_without_an_engine_the_worker_asks_only_for_transcriptions(fake_api):
    worker = diarizing_worker(fake_api, None)
    worker.run(once=True)
    assert fake_api.bodies("lease")[0]["kinds"] == ["transcribe"]


def test_a_failing_engine_fails_the_job_as_retryable(fake_api):
    fake_api.jobs = [dict(DIARIZE_JOB)]

    def broken(pcm, *, voices, scratch):
        raise RuntimeError("coreml out of memory")

    broken.engine = "senko"
    broken.model = "fake"
    diarizing_worker(fake_api, broken).step()
    (fail,) = fake_api.bodies("fail")
    assert fail["failure"] == "conversion-failed"
    assert "coreml out of memory" in fail["detail"]
    assert fake_api.bodies("diarization") == []


def test_a_lost_lease_at_upload_drops_the_turns(fake_api, caplog):
    fake_api.jobs = [dict(DIARIZE_JOB)]
    fake_api.status["diarization"] = 409
    assert diarizing_worker(fake_api, FakeDiarizer(interview())).step() == "job"
    assert "lease was lost" in caplog.text


@pytest.mark.parametrize("status", [404])
def test_audio_that_is_not_ours_is_dropped(fake_api, status):
    fake_api.jobs = [dict(DIARIZE_JOB)]
    fake_api.status["audio"] = status
    diarizer = FakeDiarizer(interview())
    assert diarizing_worker(fake_api, diarizer).step() == "job"
    assert diarizer.calls == []
    assert fake_api.bodies("diarization") == []

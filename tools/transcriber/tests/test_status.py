"""The worker's sign of life (KBC-114 AC-11): its state, job, counts and last error."""

import fcntl
import re
import threading
import time

import numpy as np

from transcriber.api import ApiClient
from transcriber.config import PARAMETERS_VERSION
from transcriber.kb_publish import LOCK_FILE, KbPublisher
from transcriber.status import StatusReporter, WorkerStatus
from transcriber.worker import REVOKED, Worker

from .conftest import JOB, TOKEN, FakeModel
from .test_kb_publish import JOB as KB_JOB
from .test_kb_publish import FakeKb

ISO = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
KEYS = {
    "state",
    "detail",
    "version",
    "kinds",
    "startedAt",
    "currentJob",
    "recentJobs",
    "lastError",
    "counts",
    "vaultPath",
    "kbVersion",
}


def reporting(api, token=TOKEN, publisher=None, model=None, **status) -> Worker:
    client = ApiClient(api.url, lambda: token, "mac-test")
    return Worker(
        api=client,
        model=model or FakeModel(),
        find_speech=lambda _: [(0.0, 9.0)],
        decode=lambda path: np.zeros(10 * 16000, dtype=np.float32),
        poll_s=0.01,
        error_backoff_s=0.01,
        unauthorized_backoff_s=0.01,
        publisher=publisher,
        status=WorkerStatus(**status),
        reporter=StatusReporter(client),
    )


def test_ac11_an_idle_worker_says_so_with_its_version_and_kinds(fake_api):
    fake_api.jobs.clear()
    w = reporting(fake_api, vault_path="/Users/o/vault", kb_version="0.0.12 (commit=x)")
    assert w.step() == "idle"
    report = fake_api.bodies("status")[-1]
    assert set(report) == KEYS
    assert report["state"] == "idle"
    assert report["detail"] is None
    assert PARAMETERS_VERSION in report["version"]
    assert len(report["version"]) <= 60
    assert report["kinds"] == ["transcribe"]
    assert ISO.match(report["startedAt"])
    assert report["currentJob"] is None
    assert report["recentJobs"] == []
    assert report["lastError"] is None
    assert report["counts"] == {"done": 0, "failed": 0}
    assert report["vaultPath"] == "/Users/o/vault"
    assert report["kbVersion"] == "0.0.12 (commit=x)"
    # The same state again is not sent again: the periodic beat keeps it alive.
    w.step()
    assert len(fake_api.bodies("status")) == 1


def test_ac11_a_job_is_reported_while_it_runs_and_counted_when_done(fake_api):
    seen: list[dict] = []
    model = FakeModel(on_call=lambda n: seen.append(fake_api.bodies("status")[-1]))
    w = reporting(fake_api, model=model)
    assert w.step() == "job"
    working = seen[0]
    assert working["state"] == "working"
    job = working["currentJob"]
    assert job["id"] == JOB["id"]
    assert job["kind"] == "transcribe"
    assert job["label"] == JOB["mediaId"]
    assert ISO.match(job["startedAt"])
    assert job["progress"] == 0
    last = fake_api.bodies("status")[-1]
    assert last["state"] == "idle"
    assert last["currentJob"] is None
    assert last["counts"] == {"done": 1, "failed": 0}
    (recent,) = last["recentJobs"]
    assert recent["id"] == JOB["id"]
    assert recent["outcome"] == "done"
    assert ISO.match(recent["finishedAt"])


def test_ac11_a_busy_vault_is_reported_as_waiting(fake_api, tmp_path):
    fake_api.jobs.clear()
    (tmp_path / "hermetismo").mkdir()
    publisher = KbPublisher(tmp_path, FakeKb(tmp_path))
    with open(tmp_path / LOCK_FILE, "a+") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        reporting(fake_api, publisher=publisher).step()
    report = fake_api.bodies("status")[-1]
    assert report["state"] == "waiting"
    assert report["detail"] == "trava do vault ocupada por outra publicação"
    assert report["kinds"][-1] == "kb-publish"


def test_ac11_an_unreachable_api_is_an_error(fake_api):
    fake_api.status["lease"] = 500
    reporting(fake_api).step()
    report = fake_api.bodies("status")[-1]
    assert report["state"] == "error"
    assert "lease answered 500" in report["detail"]
    assert "lease answered 500" in report["lastError"]["message"]
    assert ISO.match(report["lastError"]["at"])


def test_ac11_a_revoked_token_is_an_error_and_the_report_never_raises(fake_api):
    w = reporting(fake_api, token="revoked" * 6)
    assert w.step() == "revoked"
    assert w.status.snapshot()["state"] == "error"
    assert w.status.snapshot()["detail"] == REVOKED
    # The report itself got 401: logged, never raised.
    assert fake_api.bodies("status")[-1]["state"] == "error"


def test_ac11_a_failed_kb_publish_is_counted_with_its_error(fake_api, tmp_path):
    (tmp_path / "hermetismo" / "raw").mkdir(parents=True)
    (tmp_path / "hermetismo" / "topic.yaml").write_text("slug: hermetismo\n", encoding="utf-8")
    fake_api.jobs[:] = [dict(KB_JOB)]
    publisher = KbPublisher(tmp_path, FakeKb(tmp_path, fail="link"))
    reporting(fake_api, publisher=publisher).step()
    last = fake_api.bodies("status")[-1]
    assert last["counts"] == {"done": 0, "failed": 1}
    (recent,) = last["recentJobs"]
    assert recent["kind"] == "kb-publish"
    assert recent["label"] == "publicando hermetismo (2 documentos)"
    assert recent["outcome"] == "failed"
    assert recent["detail"] == "kb link: Error: OpenRouter 502 Bad Gateway"
    assert last["lastError"]["message"] == "kb link: Error: OpenRouter 502 Bad Gateway"


def test_ac11_the_reporter_beats_every_interval_until_stopped(fake_api):
    client = ApiClient(fake_api.url, lambda: TOKEN, "mac-test")
    reporter = StatusReporter(client, every_s=0.05)
    reporter.start(WorkerStatus())
    time.sleep(0.3)
    reporter.stop()
    sent = len(fake_api.bodies("status"))
    assert sent >= 3
    time.sleep(0.15)
    assert len(fake_api.bodies("status")) == sent


def test_recent_jobs_keep_the_ten_newest(fake_api):
    status = WorkerStatus()
    for index in range(12):
        status.start_job({"id": f"job-{index}", "kind": "transcribe", "mediaId": "m"}, {})
        status.finish_job("done")
    recent = status.snapshot()["recentJobs"]
    assert len(recent) == 10
    assert recent[0]["id"] == "job-11"
    assert status.snapshot()["counts"]["done"] == 12


def test_the_status_is_safe_across_threads():
    status = WorkerStatus()
    threads = [
        threading.Thread(target=lambda: [status.set_state("idle") for _ in range(200)])
        for _ in range(4)
    ]
    for one in threads:
        one.start()
    for one in threads:
        one.join()
    assert status.snapshot()["state"] == "idle"

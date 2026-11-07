"""The automatic sync with production (KBC-100 FR-4, BR-7): never the real script nor SSH."""

from pathlib import Path

import numpy as np
import pytest

from transcriber.api import ApiClient
from transcriber.kb_publish import KbPublisher
from transcriber.vault_sync import SYNC_INTERVAL_S, VaultSync
from transcriber.worker import Worker

from .conftest import TOKEN, FakeModel
from .test_kb_publish import JOB, FakeKb


class Clock:
    def __init__(self) -> None:
        self.now = 1_800_000_000.0

    def __call__(self) -> float:
        return self.now


class Runner:
    """Plays sync-vault.sh: records each command, answers with the exit code asked."""

    def __init__(self, code: int = 0, output: str = "sync-vault: done") -> None:
        self.code = code
        self.output = output
        self.commands: list[list[str]] = []

    def __call__(self, command: list[str]) -> tuple[int, str]:
        self.commands.append(command)
        return self.code, self.output


def a_sync(tmp_path: Path, runner: Runner, clock: Clock) -> VaultSync:
    return VaultSync(
        script=tmp_path / "sync-vault.sh",
        host="ubuntu@kb.example.com",
        vault=tmp_path,
        clock=clock,
        runner=runner,
    )


def test_br7_nothing_runs_without_a_change_pending(tmp_path):
    runner = Runner()
    sync = a_sync(tmp_path, runner, Clock())
    assert sync.run_if_due() is None
    assert runner.commands == []


def test_fr4_a_change_runs_the_sync_with_the_hot_index_swap(tmp_path):
    runner = Runner()
    sync = a_sync(tmp_path, runner, Clock())
    sync.mark_pending()
    report = sync.run_if_due()
    assert runner.commands == [
        [
            str(tmp_path / "sync-vault.sh"),
            "--host",
            "ubuntu@kb.example.com",
            "--vault",
            str(tmp_path),
            "--hot",
        ]
    ]
    assert report is not None
    assert report["ok"] is True
    assert report["detail"] == "sync-vault: done"
    assert report["startedAt"].endswith("Z")
    assert sync.run_if_due() is None


def test_br7_at_most_every_30_minutes_and_a_change_meanwhile_waits_for_it(tmp_path):
    clock = Clock()
    runner = Runner()
    sync = a_sync(tmp_path, runner, clock)
    sync.mark_pending()
    sync.run_if_due()
    clock.now += 10 * 60
    sync.mark_pending()
    assert sync.run_if_due() is None
    clock.now += SYNC_INTERVAL_S - 10 * 60
    assert sync.run_if_due() is not None
    assert len(runner.commands) == 2
    assert SYNC_INTERVAL_S == 30 * 60


def test_a_failed_sync_keeps_the_change_pending_for_the_next_interval(tmp_path):
    clock = Clock()
    runner = Runner(code=1, output="sync-vault: another deploy holds /srv/kb-chat/deploy/.lock")
    sync = a_sync(tmp_path, runner, clock)
    sync.mark_pending()
    report = sync.run_if_due()
    assert report is not None
    assert report["ok"] is False
    assert "another deploy holds" in report["detail"]
    assert sync.run_if_due() is None
    clock.now += SYNC_INTERVAL_S
    runner.code = 0
    assert sync.run_if_due()["ok"] is True


def test_the_report_keeps_the_end_of_a_long_output(tmp_path):
    runner = Runner(output="x" * 5_000 + " the end")
    sync = a_sync(tmp_path, runner, Clock())
    sync.mark_pending()
    report = sync.run_if_due()
    assert len(report["detail"]) == 2_000
    assert report["detail"].endswith("the end")


def worker(api, publisher, sync) -> Worker:
    return Worker(
        api=ApiClient(api.url, lambda: TOKEN, "mac-test"),
        model=FakeModel(),
        find_speech=lambda _: [(0.0, 9.0)],
        decode=lambda path: np.zeros(16000, dtype=np.float32),
        poll_s=0.01,
        error_backoff_s=0.01,
        publisher=publisher,
        sync=sync,
    )


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    (tmp_path / "hermetismo" / "raw").mkdir(parents=True)
    return tmp_path


def test_fr4_after_a_published_batch_the_worker_syncs_and_reports_to_the_api(fake_api, vault):
    fake_api.jobs[:] = [dict(JOB)]
    runner = Runner()
    sync = a_sync(vault, runner, Clock())
    mac = worker(fake_api, KbPublisher(vault, FakeKb(vault)), sync)
    assert mac.step() == "job"
    assert len(runner.commands) == 1
    (report,) = fake_api.bodies("vault-sync")
    assert report["ok"] is True
    # Idle afterwards, with nothing new: no second sync.
    assert mac.step() == "idle"
    assert len(runner.commands) == 1


def test_br7_a_change_left_waiting_is_synced_when_idle_once_its_interval_passed(fake_api, vault):
    clock = Clock()
    runner = Runner()
    sync = a_sync(vault, runner, clock)
    mac = worker(fake_api, KbPublisher(vault, FakeKb(vault)), sync)
    fake_api.jobs[:] = [dict(JOB)]
    mac.step()
    fake_api.jobs[:] = [dict(JOB)]
    clock.now += 60
    mac.step()
    assert len(runner.commands) == 1
    clock.now += SYNC_INTERVAL_S
    assert mac.step() == "idle"
    assert len(runner.commands) == 2


def test_a_failed_publication_is_not_synced(fake_api, vault):
    fake_api.jobs[:] = [dict(JOB)]
    runner = Runner()
    sync = a_sync(vault, runner, Clock())
    worker(fake_api, KbPublisher(vault, FakeKb(vault, fail="link")), sync).step()
    assert runner.commands == []


def test_a_report_the_api_refuses_does_not_stop_the_worker(fake_api, vault):
    fake_api.jobs[:] = [dict(JOB)]
    fake_api.status["vault-sync"] = 500
    runner = Runner()
    mac = worker(fake_api, KbPublisher(vault, FakeKb(vault)), a_sync(vault, runner, Clock()))
    assert mac.step() == "job"
    assert len(runner.commands) == 1


def test_the_cli_syncs_only_with_kb_and_a_host_to_send_to(tmp_path):
    from argparse import Namespace

    from transcriber.cli import SYNC_SCRIPT, vault_sync_of
    from transcriber.kb_publish import KbCli

    kb = KbCli(tmp_path)
    args = Namespace(sync_host=None, sync_script=None, no_sync=False)
    assert vault_sync_of(args, {}, kb) is None
    assert vault_sync_of(args, {"sync_host": "ubuntu@vm"}, None) is None
    sync = vault_sync_of(args, {"sync_host": "ubuntu@vm"}, kb, state_file=tmp_path / "s.json")
    assert sync is not None
    assert sync.script == SYNC_SCRIPT
    assert SYNC_SCRIPT.name == "sync-vault.sh" and SYNC_SCRIPT.exists()
    assert sync.pending is True
    off = Namespace(sync_host="ubuntu@vm", sync_script=None, no_sync=True)
    assert vault_sync_of(off, {}, kb) is None


def test_a_restart_with_nothing_pending_does_not_sync_again(tmp_path):
    """Review suggestion: a start of the transcriber is not a change (launchd restarts it)."""
    state = tmp_path / "vault-sync.json"
    runner = Runner()
    clock = Clock()
    first = VaultSync(
        script=tmp_path / "sync-vault.sh",
        host="ubuntu@vm",
        vault=tmp_path,
        clock=clock,
        runner=runner,
        state_file=state,
    )
    first.load()
    assert first.pending is True  # never synced from this Mac: whatever was published goes
    assert first.run_if_due() is not None

    again = VaultSync(
        script=tmp_path / "sync-vault.sh",
        host="ubuntu@vm",
        vault=tmp_path,
        clock=clock,
        runner=runner,
        state_file=state,
    )
    again.load()
    assert again.pending is False
    assert again.run_if_due() is None
    assert len(runner.commands) == 1


def test_a_change_or_a_failure_left_pending_survives_a_restart(tmp_path):
    state = tmp_path / "vault-sync.json"
    clock = Clock()
    failing = VaultSync(
        script=tmp_path / "sync-vault.sh",
        host="ubuntu@vm",
        vault=tmp_path,
        clock=clock,
        runner=Runner(code=1, output="sync-vault: ssh down"),
        state_file=state,
    )
    failing.load()
    failing.run_if_due()
    restarted = VaultSync(
        script=tmp_path / "sync-vault.sh",
        host="ubuntu@vm",
        vault=tmp_path,
        clock=clock,
        runner=Runner(),
        state_file=state,
    )
    restarted.load()
    assert restarted.pending is True
    # The 30-minute interval counts from the last run, across the restart.
    assert restarted.run_if_due() is None
    clock.now += SYNC_INTERVAL_S
    assert restarted.run_if_due() is not None


def test_a_state_file_that_cannot_be_read_counts_as_a_change(tmp_path):
    state = tmp_path / "vault-sync.json"
    state.write_text("{not json", encoding="utf-8")
    sync = VaultSync(
        script=tmp_path / "sync-vault.sh",
        host="ubuntu@vm",
        vault=tmp_path,
        clock=Clock(),
        runner=Runner(),
        state_file=state,
    )
    sync.load()
    assert sync.pending is True

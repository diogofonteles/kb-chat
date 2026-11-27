"""A long local step runs to its end; only one that stopped working is ended (KBC-190)."""

import contextlib
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from transcriber import watched
from transcriber.watched import StepEnded, StepStopped, cpu_seconds, run_watched, stopped_by

FAST = {"stall_s": 0.6, "poll_s": 0.1, "drain_s": 0.5}
SRC = str(Path(watched.__file__).parents[1])


def busy(seconds: float) -> str:
    return f"import time\nt=time.time()\nwhile time.time()-t<{seconds}: pass\n"


def gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def end(pid_file: Path) -> None:
    """A test's stray process, if a check failed before it was ended."""
    if pid_file.exists():
        pid = int(pid_file.read_text(encoding="utf-8"))
        if not gone(pid):
            os.kill(pid, signal.SIGKILL)


def test_cpu_time_as_ps_writes_it():
    assert cpu_seconds("0:00.01") == pytest.approx(0.01)
    assert cpu_seconds("12:34.56") == pytest.approx(754.56)
    assert cpu_seconds("62:03.45") == pytest.approx(3723.45)
    assert cpu_seconds("1:02:03") == pytest.approx(3723)
    assert cpu_seconds("2-01:00:00") == pytest.approx(176_400)
    assert cpu_seconds("?") is None


# ---------- What counts as work (AC-1, AC-3) ----------


def test_a_new_process_counts_as_work(monkeypatch):
    """kb waits while one `qmd query` after another works: no CPU of its own, new children."""
    counter = iter(range(10_000, 20_000))
    monkeypatch.setattr(watched, "_tree", lambda root: {root: 1.0, next(counter): 0.0})
    done = run_watched(["/bin/sh", "-c", "sleep 1.5; echo done"], **FAST)
    assert done.stdout.strip() == "done"


def test_more_cpu_in_a_process_counts_as_work(monkeypatch):
    clock = iter(range(1, 10_000))
    monkeypatch.setattr(watched, "_tree", lambda root: {root: float(next(clock))})
    done = run_watched(["/bin/sh", "-c", "sleep 1.5; echo done"], **FAST)
    assert done.stdout.strip() == "done"


def test_the_same_processes_with_no_more_cpu_are_stuck(monkeypatch):
    monkeypatch.setattr(watched, "_tree", lambda root: {root: 1.0, 7: 2.0})
    with pytest.raises(StepEnded, match="stalled"):
        run_watched(["/bin/sh", "-c", "sleep 30"], **FAST)


def test_a_step_that_keeps_working_runs_past_the_watch():
    # Linux's ps counts CPU in whole seconds: the watch is longer than one of them.
    done = run_watched([sys.executable, "-c", busy(3.5) + "print('done')"], stall_s=2.0, poll_s=0.1)
    assert done.returncode == 0
    assert done.stdout.strip() == "done"


def test_a_parent_that_waits_while_children_work_is_not_ended():
    child = f'{sys.executable} -c "{busy(0.35)}"'
    script = f"for i in 1 2 3 4 5; do {child}; sleep 0.2; done; echo done"
    done = run_watched(["/bin/sh", "-c", script], stall_s=1.0, poll_s=0.1)
    assert done.returncode == 0
    assert done.stdout.strip() == "done"


def test_without_ps_it_never_ends_a_step_for_not_knowing(monkeypatch):
    monkeypatch.setattr(watched, "PS", "/nonexistent/ps")
    done = run_watched(["/bin/sh", "-c", "sleep 1; echo done"], stall_s=0.3, poll_s=0.1)
    assert done.stdout.strip() == "done"


# ---------- A stuck step ends with all it started (AC-2) ----------


def test_a_step_that_stopped_is_ended_with_all_it_started(tmp_path):
    pid_file = tmp_path / "pid"
    script = f"sleep 30 & echo $! > {pid_file}; wait"
    started = time.monotonic()
    try:
        with pytest.raises(StepEnded, match="sh: stalled"):
            run_watched(["/bin/sh", "-c", script], **FAST)
        assert time.monotonic() - started < 3
        assert gone(int(pid_file.read_text(encoding="utf-8")))
    finally:
        end(pid_file)


def test_what_it_said_goes_with_why():
    script = 'echo "linking raw/a.md (1/3123)"; echo "decisions: 2 calls, US$ 0.0420"; sleep 30'
    with pytest.raises(StepEnded) as ended:
        run_watched(["/bin/sh", "-c", script], **FAST)
    lines = ended.value.output.splitlines()
    assert lines[:2] == ["linking raw/a.md (1/3123)", "decisions: 2 calls, US$ 0.0420"]
    assert "stalled" in lines[-1]


def test_one_that_left_the_step_never_holds_it_and_ends_with_it(tmp_path):
    """A process that left the step (its parent gone) and holds the output: never waited for,
    and ended with the step (it would write the vault after the lock is gone)."""
    pid_file = tmp_path / "pid"
    script = f"(sleep 30 & echo $! > {pid_file}); sleep 30"
    started = time.monotonic()
    try:
        with pytest.raises(StepEnded, match="stalled"):
            run_watched(["/bin/sh", "-c", script], **FAST)
        assert time.monotonic() - started < 3
        assert gone(int(pid_file.read_text(encoding="utf-8")))
    finally:
        end(pid_file)


def test_a_finished_step_is_not_held_by_one_that_left(tmp_path):
    pid_file = tmp_path / "pid"
    script = f"(sleep 30 & echo $! > {pid_file}); echo done"
    started = time.monotonic()
    try:
        done = run_watched(["/bin/sh", "-c", script], **FAST)
        assert done.stdout.strip() == "done"
        assert time.monotonic() - started < 3
        assert gone(int(pid_file.read_text(encoding="utf-8")))
    finally:
        end(pid_file)


def test_what_is_older_than_the_step_is_never_touched(tmp_path):
    """A process of the worker's group born before the step is not the step's."""
    pid_file = tmp_path / "pid"
    subprocess.run(["/bin/sh", "-c", f"(sleep 30 & echo $! > {pid_file})"], check=True)
    time.sleep(3.5)
    try:
        run_watched(["/bin/sh", "-c", "echo done"], **FAST)
        assert not gone(int(pid_file.read_text(encoding="utf-8")))
    finally:
        end(pid_file)


def test_what_starts_children_fast_ends_with_all_of_them(tmp_path):
    """Children born between a look and the freeze are found on the next look."""
    pids = tmp_path / "pids"
    script = f"for i in $(seq 300); do sleep 30 & echo $! >> {pids}; done; wait"
    started = time.monotonic()
    try:
        with (
            stopped_by(lambda: time.monotonic() - started > 0.05),
            pytest.raises(StepStopped),
        ):
            run_watched(["/bin/sh", "-c", script], stall_s=60, poll_s=0.02)
        left = [int(pid) for pid in pids.read_text(encoding="utf-8").split()]
        assert left
        assert all(gone(pid) for pid in left)
    finally:
        for pid in pids.read_text(encoding="utf-8").split() if pids.exists() else []:
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(pid), signal.SIGKILL)


def test_a_step_asked_for_after_the_job_stopped_never_starts(tmp_path):
    mark = tmp_path / "ran"
    with stopped_by(lambda: True), pytest.raises(StepStopped):
        run_watched(["/bin/sh", "-c", f"touch {mark}"], **FAST)
    assert not mark.exists()


def test_a_step_killed_by_a_signal_while_the_job_stops_is_no_failure():
    """Ctrl-C reaches the worker's whole group: the step dies before the watch looks."""
    calls = iter([False])
    with stopped_by(lambda: next(calls, True)), pytest.raises(StepStopped):
        run_watched(["/bin/sh", "-c", "kill -INT $$; sleep 5"], **FAST)


def test_its_output_is_whole_however_long_it_waits():
    script = (
        "import sys,time\nfor i in range(3):\n"
        " print('x'*100000); sys.stdout.flush(); time.sleep(0.2)\n"
    )
    done = run_watched([sys.executable, "-c", script], stall_s=5, poll_s=0.05)
    assert len(done.stdout.splitlines()) == 3


def test_a_fixed_limit_still_ends_a_download():
    with pytest.raises(StepEnded, match="took more than"):
        run_watched([sys.executable, "-c", busy(5)], timeout=0.3, stall_s=60, poll_s=0.1)


# ---------- The step ends with the worker and with the job (review KBC-190) ----------


def test_the_step_stays_in_the_workers_process_group():
    done = run_watched(["/bin/sh", "-c", "ps -o pgid= -p $$"], **FAST)
    assert int(done.stdout.strip()) == os.getpgrp()


def test_when_launchd_ends_the_worker_the_step_ends_too(tmp_path):
    """launchd kills the worker's process group: the step, in it, never writes after."""
    mark = tmp_path / "written-after"
    worker = (
        f"import sys; sys.path.insert(0, {SRC!r})\n"
        "from transcriber.watched import run_watched\n"
        f"run_watched(['/bin/sh', '-c', 'sleep 1.5; touch {mark}'])\n"
    )
    process = subprocess.Popen([sys.executable, "-c", worker], start_new_session=True)
    time.sleep(0.6)
    os.killpg(process.pid, signal.SIGKILL)
    process.wait()
    time.sleep(1.6)
    assert not mark.exists()


def test_a_stopped_job_ends_its_step_with_all_it_started(tmp_path):
    pid_file = tmp_path / "pid"
    script = f"sleep 30 & echo $! > {pid_file}; wait"
    started = time.monotonic()
    try:
        with (
            stopped_by(lambda: time.monotonic() - started > 0.3),
            pytest.raises(StepStopped, match="stopped"),
        ):
            run_watched(["/bin/sh", "-c", script], stall_s=60, poll_s=0.1)
        assert time.monotonic() - started < 3
        assert gone(int(pid_file.read_text(encoding="utf-8")))
    finally:
        end(pid_file)


def test_the_stop_belongs_to_its_job_only():
    with stopped_by(lambda: True):
        pass
    done = run_watched(["/bin/sh", "-c", "sleep 0.3; echo done"], **FAST)
    assert done.stdout.strip() == "done"


def test_a_stray_is_never_the_worker_nor_above_it():
    """The worker's shell may be as young as the step, with its parent outside the group."""
    me, group = os.getpid(), os.getpgrp()
    shell, orphan, old = 9_000_001, 9_000_002, 9_000_003
    listed = {
        me: (shell, group, 1.0, 0.5),
        shell: (1, group, 1.0, 0.1),
        orphan: (1, group, 0.5, 0.0),
        old: (1, group, 60.0, 0.0),
    }
    assert watched._strays(listed, age_s=0.5) == {orphan}

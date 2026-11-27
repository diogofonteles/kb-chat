"""A long local step runs to its end; only one that stopped working is ended (KBC-190)."""

import os
import signal
import sys
import time

import pytest

from transcriber.watched import StepEnded, cpu_seconds, run_watched

FAST = {"stall_s": 0.6, "poll_s": 0.1}


def busy(seconds: float) -> str:
    return f"import time\nt=time.time()\nwhile time.time()-t<{seconds}: pass\n"


def test_cpu_time_as_ps_writes_it():
    assert cpu_seconds("0:00.01") == pytest.approx(0.01)
    assert cpu_seconds("12:34.56") == pytest.approx(754.56)
    assert cpu_seconds("62:03.45") == pytest.approx(3723.45)
    assert cpu_seconds("1:02:03") == pytest.approx(3723)
    assert cpu_seconds("2-01:00:00") == pytest.approx(176_400)
    assert cpu_seconds("?") is None


def test_a_step_that_keeps_working_runs_past_the_watch():
    done = run_watched([sys.executable, "-c", busy(1.5) + "print('done')"], **FAST)
    assert done.returncode == 0
    assert done.stdout.strip() == "done"


def test_a_parent_that_waits_while_children_work_is_not_ended():
    """kb link waits while one `qmd query` after another does the work."""
    child = f'{sys.executable} -c "{busy(0.35)}"'
    script = f"for i in 1 2 3 4 5; do {child}; sleep 0.2; done; echo done"
    done = run_watched(["/bin/sh", "-c", script], stall_s=1.0, poll_s=0.1)
    assert done.returncode == 0
    assert done.stdout.strip() == "done"


def test_a_step_that_stopped_is_ended_with_all_it_started(tmp_path):
    pid_file = tmp_path / "pid"
    script = f"sleep 30 & echo $! > {pid_file}; wait"
    started = time.monotonic()
    with pytest.raises(StepEnded, match="sh: stalled"):
        run_watched(["/bin/sh", "-c", script], **FAST)
    assert time.monotonic() - started < 3
    grandchild = int(pid_file.read_text(encoding="utf-8"))
    with pytest.raises(ProcessLookupError):
        os.kill(grandchild, 0)


def test_a_fixed_limit_still_ends_a_download():
    with pytest.raises(StepEnded, match="took more than"):
        run_watched([sys.executable, "-c", busy(5)], timeout=0.3, stall_s=60, poll_s=0.1)


def test_without_ps_it_never_ends_a_step_for_not_knowing(monkeypatch):
    from transcriber import watched

    monkeypatch.setattr(watched, "PS", "/nonexistent/ps")
    done = run_watched(["/bin/sh", "-c", "sleep 1; echo done"], stall_s=0.3, poll_s=0.1)
    assert done.stdout.strip() == "done"


def test_its_output_is_whole_however_long_it_waits():
    script = (
        "import sys,time\nfor i in range(3):\n"
        " print('x'*100000); sys.stdout.flush(); time.sleep(0.2)\n"
    )
    done = run_watched([sys.executable, "-c", script], stall_s=5, poll_s=0.05)
    assert len(done.stdout.splitlines()) == 3


def test_no_signal_handler_is_left_behind():
    before = signal.getsignal(signal.SIGTERM)
    run_watched(["/bin/sh", "-c", "true"], **FAST)
    assert signal.getsignal(signal.SIGTERM) == before

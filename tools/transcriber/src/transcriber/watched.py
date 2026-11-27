"""A long local step runs to its end; only one that stopped working is ended (KBC-190).

kb, kb-map and QMD run here for as long as their work takes: a `kb link` over a whole
collection takes more than an hour, and it keeps nothing when it is cut in the middle, so a
fixed limit made it start over at every attempt. What is watched is the work instead: a step
whose processes used no CPU and started none for `STALL_S` is stuck, and it ends with
everything it started.
"""

import contextlib
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Final

# A step with no work for this long is stuck (no CPU in any of its processes, none new).
STALL_S: Final = 20 * 60
POLL_S: Final = 15.0
PS: Final = "/bin/ps"


class StepEnded(Exception):
    """The step was ended: stuck, or past the fixed limit of a download."""


def cpu_seconds(text: str) -> float | None:
    """`ps`'s CPU time ("[dd-][hh:]mm:ss[.ss]") in seconds; None when it is not one."""
    days, _, clock = text.strip().rpartition("-")
    try:
        parts = [float(part) for part in clock.split(":")]
        whole_days = int(days) if days else 0
    except ValueError:
        return None
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + part
    return seconds + whole_days * 86_400


def _group(pgid: int) -> dict[int, float] | None:
    """CPU seconds of each live process of the group; None when `ps` cannot say."""
    try:
        listed = subprocess.run(
            [PS, "-A", "-o", "pid=,pgid=,time="],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if listed.returncode != 0:
        return None
    found: dict[int, float] = {}
    for line in listed.stdout.splitlines():
        fields = line.split()
        if len(fields) != 3 or not fields[0].isdigit() or fields[1] != str(pgid):
            continue
        spent = cpu_seconds(fields[2])
        if spent is not None:
            found[int(fields[0])] = spent
    return found


def _worked(before: dict[int, float], now: dict[int, float]) -> bool:
    """A new process, or more CPU in one already there."""
    return any(pid not in before or spent > before[pid] for pid, spent in now.items())


def _end(process: subprocess.Popen) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, signal.SIGKILL)
    process.communicate()


def run_watched(
    command: list[str],
    *,
    timeout: float | None = None,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    stall_s: float = STALL_S,
    poll_s: float = POLL_S,
) -> subprocess.CompletedProcess:
    """Runs a command in a group of its own until it ends. It is ended, with all it started
    (uv starts kb-map, which starts kb, which starts qmd), only when it has done no work for
    `stall_s`, or, with a `timeout` (downloads only), past it. Raises StepEnded then."""
    name = Path(command[0]).name
    with subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    ) as process:
        started = last_work = time.monotonic()
        seen: dict[int, float] = {}
        while True:
            wait = poll_s
            if timeout is not None:
                wait = max(0.01, min(poll_s, started + timeout - time.monotonic()))
            try:
                # Called again after a timeout, communicate loses none of the output.
                stdout, stderr = process.communicate(timeout=wait)
                break
            except subprocess.TimeoutExpired:
                pass
            now = time.monotonic()
            if timeout is not None and now - started > timeout:
                _end(process)
                raise StepEnded(f"{name}: took more than {timeout:.0f} s")
            group = _group(process.pid)
            # Without ps nothing is known: it is never ended for that.
            if group is None or _worked(seen, group):
                last_work = now
            if group is not None:
                seen = group
            if now - last_work >= stall_s:
                _end(process)
                raise StepEnded(f"{name}: stalled, no work for {stall_s:.0f} s; stopped")
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)

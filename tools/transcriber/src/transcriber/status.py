"""The worker's sign of life for the app (KBC-114 FR-8, ADR 0023 amendment).

`WorkerStatus` holds what the worker is doing (idle, working on a job, waiting for something,
or an error), the job in hand with its progress, the last jobs, counts since it started and
the last error. `StatusReporter` posts it to `POST /api/v1/media-worker/status` when the state
changes and every STATUS_EVERY_S while nothing changes; the API keeps the last one in memory
and shows it to masters. A report that fails is logged and never stops the worker.
"""

import logging
import threading
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version

from .api import ApiError, Unauthorized
from .config import PARAMETERS_VERSION, STATUS_EVERY_S
from .secret import TokenError

log = logging.getLogger("transcriber")

RECENT_JOBS = 10
DETAIL_CHARS = 300
ERROR_CHARS = 500
LABEL_CHARS = 200
VERSION_CHARS = 60


def now_iso() -> str:
    """UTC with milliseconds and "Z", as the API's zod `iso.datetime()` reads it."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def worker_version() -> str:
    try:
        number = package_version("transcriber")
    except PackageNotFoundError:
        number = "0.1.0"
    return f"{number} ({PARAMETERS_VERSION})"[:VERSION_CHARS]


def label_of(job: dict) -> str:
    """What the job is about, in words a master reads."""
    if job.get("kind") == "kb-publish":
        count = len(job.get("items") or [])
        return f"publicando {job.get('topic')} ({count} documentos)"[:LABEL_CHARS]
    if job.get("kind") == "voice-profile":
        return "perfil de voz"
    return str(job.get("title") or job.get("mediaId") or job.get("id"))[:LABEL_CHARS]


class WorkerStatus:
    """Thread-safe: the worker loop, the heartbeat and the reporter read and write it."""

    def __init__(
        self,
        kinds: tuple[str, ...] = (),
        vault_path: str | None = None,
        kb_version: str | None = None,
    ) -> None:
        self._lock = threading.Lock()
        # Empty until the worker first says something: that first state always goes out.
        self._state = ""
        self._detail: str | None = None
        self.kinds: tuple[str, ...] = kinds
        self._vault_path = vault_path
        self._kb_version = kb_version
        self._started_at = now_iso()
        self._job: dict | None = None
        self._progress: dict = {}
        self._recent: list[dict] = []
        self._last_error: dict | None = None
        self._counts = {"done": 0, "failed": 0}
        self._failure: str | None = None

    def set_state(self, state: str, detail: str | None = None) -> bool:
        """True when it changed (what the reporter sends at once)."""
        detail = detail[:DETAIL_CHARS] if detail else None
        with self._lock:
            changed = (state, detail) != (self._state, self._detail)
            self._state, self._detail = state, detail
            return changed

    def error(self, message: str) -> bool:
        with self._lock:
            self._last_error = {"at": now_iso(), "message": message[:ERROR_CHARS]}
        return self.set_state("error", message)

    def start_job(self, job: dict, progress: dict) -> None:
        """`progress` is the job's own dict ({"percent": n}), read whenever a report goes."""
        with self._lock:
            self._job = {
                "id": str(job.get("id")),
                "kind": job.get("kind", "transcribe"),
                "label": label_of(job),
                "startedAt": now_iso(),
            }
            self._progress = progress
            self._failure = None
            self._state, self._detail = "working", None

    def job_failed(self, detail: str) -> None:
        """The job ended by giving itself back to the queue (kb failed, bad audio…)."""
        with self._lock:
            self._failure = detail[:DETAIL_CHARS]
            self._last_error = {"at": now_iso(), "message": detail[:ERROR_CHARS]}

    def finish_job(self, outcome: str = "done", detail: str | None = None) -> None:
        """done | failed | stopped; a failure recorded meanwhile makes it `failed`."""
        with self._lock:
            if self._job is None:
                return
            if outcome == "done" and self._failure is not None:
                outcome, detail = "failed", self._failure
            if outcome == "failed" and detail and self._failure is None:
                self._last_error = {"at": now_iso(), "message": detail[:ERROR_CHARS]}
            if outcome in self._counts:
                self._counts[outcome] += 1
            finished = {
                "id": self._job["id"],
                "kind": self._job["kind"],
                "label": self._job["label"],
                "outcome": outcome,
                "finishedAt": now_iso(),
                "detail": detail[:DETAIL_CHARS] if detail else None,
            }
            self._recent = [finished, *self._recent][:RECENT_JOBS]
            self._job = None
            self._progress = {}
            self._failure = None
            if self._state == "working":
                self._state, self._detail = "idle", None

    def snapshot(self) -> dict:
        """The body of POST /api/v1/media-worker/status."""
        with self._lock:
            current = None
            if self._job is not None:
                percent = self._progress.get("percent")
                current = {
                    **self._job,
                    "progress": int(percent) if isinstance(percent, int | float) else None,
                }
            return {
                "state": self._state or "idle",
                "detail": self._detail,
                "version": worker_version(),
                "kinds": list(self.kinds),
                "startedAt": self._started_at,
                "currentJob": current,
                "recentJobs": [dict(one) for one in self._recent],
                "lastError": dict(self._last_error) if self._last_error else None,
                "counts": dict(self._counts),
                "vaultPath": self._vault_path,
                "kbVersion": self._kb_version,
            }


class StatusReporter:
    """Sends the status: at once when asked (a change), and every `every_s` from a thread."""

    def __init__(self, api, every_s: float = STATUS_EVERY_S) -> None:
        self.api = api
        self.every_s = every_s
        self._send_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._status: WorkerStatus | None = None

    def send(self, status: WorkerStatus) -> bool:
        """Posts it now; False (logged) when the API did not take it."""
        with self._send_lock:
            try:
                self.api.report_status(status.snapshot())
                return True
            except (ApiError, Unauthorized, TokenError) as err:
                log.warning("could not report the status: %s", type(err).__name__)
            except Exception as err:
                log.warning("could not report the status: %s", err)
            return False

    def start(self, status: WorkerStatus) -> None:
        self._status = status
        self._stop.clear()
        self._thread = threading.Thread(target=self._beat, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def _beat(self) -> None:
        while not self._stop.is_set():
            if self._status is not None:
                self.send(self._status)
            self._stop.wait(self.every_s)

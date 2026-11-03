"""The worker protocol over HTTPS (ADR 0022 §3, ADR 0023): the token, never a session."""

import json
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "kb-chat"
SUFFIX_BY_TYPE = {"audio/flac": ".flac", "audio/x-flac": ".flac", "audio/mp4": ".m4a"}


class Unauthorized(Exception):
    """401: the token is invalid or was revoked."""


class ApiError(Exception):
    """Any other unexpected answer (or the API unreachable)."""


class ApiClient:
    """Each call reads the token again, so a re-pair is picked up without a restart."""

    def __init__(
        self,
        base_url: str,
        token: Callable[[], str],
        worker: str,
        timeout_s: float = 30.0,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self.worker = worker
        self._timeout = timeout_s

    def lease(self) -> dict | None:
        status, body = self._post(
            "/api/v1/media-worker/jobs/lease", {"worker": self.worker, "kinds": ["transcribe"]}
        )
        if status == 204:
            return None
        if status != 200:
            raise ApiError(f"lease answered {status}")
        job = json.loads(body)
        if job.get("kind") != "transcribe":
            raise ApiError(f"leased a job of another kind: {job.get('kind')}")
        return job

    def terms(self) -> dict:
        status, body = self._request("GET", "/api/v1/media-worker/terms")
        if status != 200:
            raise ApiError(f"terms answered {status}")
        return json.loads(body)

    def download(self, job: dict, directory: Path) -> Path | None:
        """The job's audio in `directory`; None when the API says it is not ours (404)."""
        query = urllib.parse.urlencode({"leaseId": job["leaseId"]})
        request = self._build("GET", f"{job['audioPath']}?{query}")
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310
                kind = response.headers.get_content_type()
                suffix = SUFFIX_BY_TYPE.get(kind, ".audio")
                with tempfile.NamedTemporaryFile(dir=directory, suffix=suffix, delete=False) as out:
                    shutil.copyfileobj(response, out, length=1024 * 1024)
                    return Path(out.name)
        except urllib.error.HTTPError as err:
            if err.code == 401:
                raise Unauthorized from err
            if err.code == 404:
                return None
            raise ApiError(f"audio answered {err.code}") from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise ApiError(f"audio download failed: {err}") from err

    def heartbeat(self, job: dict, progress: int | None) -> bool:
        return self._on_job(job, "heartbeat", {"progress": progress})

    def upload(self, job: dict, result: dict) -> bool:
        return self._on_job(job, "transcript", result)

    def fail(self, job: dict, failure: str, detail: str) -> bool:
        return self._on_job(job, "fail", {"failure": failure, "detail": detail[:2000]})

    def _on_job(self, job: dict, action: str, body: dict) -> bool:
        """True on 204; False when the lease is no longer ours (409)."""
        payload = {"worker": self.worker, "leaseId": job["leaseId"], **body}
        status, _ = self._post(f"/api/v1/media-worker/jobs/{job['id']}/{action}", payload)
        if status == 204:
            return True
        if status == 409:
            return False
        raise ApiError(f"{action} answered {status}")

    def _post(self, path: str, body: dict) -> tuple[int, bytes]:
        return self._request("POST", path, json.dumps(body).encode("utf-8"))

    def _build(self, method: str, path: str, data: bytes | None = None) -> urllib.request.Request:
        headers = {"authorization": f"Bearer {self._token()}"}
        if method == "POST":
            headers["content-type"] = "application/json"
            headers[CSRF_HEADER] = CSRF_VALUE
        return urllib.request.Request(  # noqa: S310 - the URL is the configured API
            f"{self._base}{path}", data=data, method=method, headers=headers
        )

    def _request(self, method: str, path: str, data: bytes | None = None) -> tuple[int, Any]:
        request = self._build(method, path, data)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310
                return response.status, response.read()
        except urllib.error.HTTPError as err:
            if err.code == 401:
                raise Unauthorized from err
            return err.code, err.read()
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise ApiError(f"{method} {path} failed: {err}") from err

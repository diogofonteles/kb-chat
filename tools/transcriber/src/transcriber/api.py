"""The worker protocol over HTTPS (ADR 0022 §3, ADR 0023): the token, never a session."""

import json
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "kb-chat"
SUFFIX_BY_TYPE = {"audio/flac": ".flac", "audio/x-flac": ".flac", "audio/mp4": ".m4a"}


class Unauthorized(Exception):
    """401: the token is invalid or was revoked."""


class ApiError(Exception):
    """Any other unexpected answer (or the API unreachable)."""


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def check_api_url(url: str) -> str:
    """The API address: HTTPS, or plain HTTP on this machine only (E2E, local validation).

    The token goes in every request: over plain HTTP anyone on the way could read it.
    """
    parts = urllib.parse.urlsplit(url)
    local = parts.hostname in LOCAL_HOSTS
    secure = parts.scheme == "https" or (parts.scheme == "http" and local)
    if secure and parts.hostname:
        return url.rstrip("/")
    raise ValueError(f"Endereço da API recusado: {url}. Use https:// (http:// só para localhost).")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is never followed: urllib would resend the Authorization header to it."""

    def redirect_request(self, *args, **kwargs):
        return None


class ApiClient:
    """The token comes from `token` (cached by the caller); a 401 asks it to read it again."""

    def __init__(
        self,
        base_url: str,
        token: Callable[[], str],
        worker: str,
        timeout_s: float = 30.0,
    ) -> None:
        self._base = check_api_url(base_url)
        self._token = token
        self.worker = worker
        self._timeout = timeout_s
        self._opener = urllib.request.build_opener(_NoRedirect)

    def lease(self, kinds: Sequence[str] = ("transcribe",)) -> dict | None:
        """The oldest job of `kinds` this token may lease; None when the queue has none."""
        status, body = self._post(
            "/api/v1/media-worker/jobs/lease", {"worker": self.worker, "kinds": list(kinds)}
        )
        if status == 204:
            return None
        if status != 200:
            raise ApiError(f"lease answered {status}")
        job = json.loads(body)
        if job.get("kind") not in kinds:
            raise ApiError(f"leased a job of another kind: {job.get('kind')}")
        return job

    def terms(self) -> dict:
        status, body = self._request("GET", "/api/v1/media-worker/terms")
        if status != 200:
            raise ApiError(f"terms answered {status}")
        return json.loads(body)

    def download(self, job: dict, directory: Path, path: str | None = None) -> Path | None:
        """The audio at `path` (the job's own by default); None when it is not ours (404)."""
        query = urllib.parse.urlencode({"leaseId": job["leaseId"]})
        request = self._build("GET", f"{path or job['audioPath']}?{query}")
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                kind = response.headers.get_content_type()
                suffix = SUFFIX_BY_TYPE.get(kind, ".audio")
                with tempfile.NamedTemporaryFile(dir=directory, suffix=suffix, delete=False) as out:
                    shutil.copyfileobj(response, out, length=1024 * 1024)
                    return Path(out.name)
        except urllib.error.HTTPError as err:
            if err.code == 401:
                self._forget_token()
                raise Unauthorized from err
            if err.code == 404:
                return None
            raise ApiError(f"audio answered {err.code}") from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise ApiError(f"audio download failed: {err}") from err

    def heartbeat(
        self, job: dict, progress: int | None, voice_profiles: Sequence[str] = ()
    ) -> list[str] | None:
        """Of the prints held, the ones revoked; None when the lease is no longer ours."""
        held = {"voiceProfiles": list(voice_profiles)} if voice_profiles else {}
        status, body = self._post(
            f"/api/v1/media-worker/jobs/{job['id']}/heartbeat",
            {"worker": self.worker, "leaseId": job["leaseId"], "progress": progress, **held},
        )
        if status == 204:
            return []
        if status == 200:
            return json.loads(body)["revokedVoiceProfiles"]
        if status == 409:
            return None
        raise ApiError(f"heartbeat answered {status}")

    def upload(self, job: dict, result: dict) -> bool:
        return self._on_job(job, "transcript", result)

    def upload_diarization(self, job: dict, result: dict) -> bool:
        """The turns of a diarize job (KBC-064); the API refuses any other field."""
        return self._on_job(job, "diarization", result)

    def voice_profiles(self, job: dict) -> list[dict]:
        """The prints of the job's collection (KBC-071); none when this token has no right."""
        query = urllib.parse.urlencode({"leaseId": job["leaseId"]})
        status, body = self._request(
            "GET", f"/api/v1/media-worker/jobs/{job['id']}/voice-profiles?{query}"
        )
        if status == 404:
            return []
        if status != 200:
            raise ApiError(f"voice profiles answered {status}")
        return json.loads(body)["profiles"]

    def upload_print(self, job: dict, result: dict) -> bool:
        """The print of a `voice-profile` job (KBC-071 FR-2)."""
        return self._on_job(job, "voice-print", result)

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
        # NaN is not JSON: the API would refuse the whole result (json_safe turns it to None).
        return self._request("POST", path, json.dumps(body, allow_nan=False).encode("utf-8"))

    def _forget_token(self) -> None:
        forget = getattr(self._token, "forget", None)
        if forget is not None:
            forget()

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
            with self._opener.open(request, timeout=self._timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as err:
            if err.code == 401:
                self._forget_token()
                raise Unauthorized from err
            if 300 <= err.code < 400:
                raise ApiError(f"{method} {path} was redirected: not followed") from err
            return err.code, err.read()
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise ApiError(f"{method} {path} failed: {err}") from err

"""A fake worker API on a local port: records every call, answers as configured."""

import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import pytest

# This Mac's real transcriber, read before any test moves HOME (compared at the end).
_REAL_HOME = Path(os.path.expanduser("~"))
_REAL_SUPPORT = _REAL_HOME / "Library" / "Application Support" / "nova-alexandria-transcriber"
REAL_CONFIG = _REAL_SUPPORT / "config.json"
REAL_FILES = (
    REAL_CONFIG,
    _REAL_SUPPORT / "vault-sync.json",
    _REAL_HOME / "Library" / "LaunchAgents" / "br.com.nova-alexandria.transcriber.plist",
)
_REAL_POPEN = subprocess.Popen
_FORBIDDEN = ("security", "launchctl")


def _fingerprint(path: Path) -> tuple[bool, bytes]:
    try:
        return True, path.read_bytes()
    except OSError:
        return False, b""


@pytest.fixture(scope="session", autouse=True)
def real_config_untouched():
    """Fails the run if any test wrote this Mac's real config, sync state or LaunchAgent."""
    before = {path: _fingerprint(path) for path in REAL_FILES}
    yield
    changed = [str(path) for path in REAL_FILES if _fingerprint(path) != before[path]]
    assert changed == [], f"a test changed {changed}"


class EmptyKeys:
    """No kb key stored: what a test that does not care about the keys sees."""

    def read(self, name: str) -> None:
        return None

    def save(self, name: str, value: str) -> None:
        raise AssertionError("a test stored a key without its own fake Keychain")

    def delete(self, name: str) -> None:
        pass


@pytest.fixture(autouse=True)
def isolated_mac(tmp_path_factory, monkeypatch):
    """Every test: a HOME of its own, the config under it, and no real Keychain or launchctl."""
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    from transcriber import cli

    config = home / "Library" / "Application Support" / "nova-alexandria-transcriber"
    monkeypatch.setattr(cli, "CONFIG_FILE", config / "config.json")
    monkeypatch.setattr(cli, "SYNC_STATE_FILE", config / "vault-sync.json")
    # The kb's AI keys (KBC-117): an empty Keychain of its own, never this Mac's.
    monkeypatch.setattr(cli, "keys_of", EmptyKeys)

    # The shell of whoever runs the tests (the owner's vault, host, token file) stays out.
    for name in [one for one in os.environ if one.startswith("KB_CHAT_")]:
        monkeypatch.delenv(name)
    # ...and so do its AI keys (KBC-117): a test never sees nor stores the owner's.
    for name in ("OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)

    class GuardedPopen(_REAL_POPEN):
        """Every child process goes through Popen (run, check_output, call): checked here."""

        def __init__(self, args, *rest, **kwargs):
            first = args[0] if isinstance(args, (list, tuple)) else str(args).split()[0]
            program = Path(str(first)).name
            if program in _FORBIDDEN:
                raise AssertionError(f"{program} is never in a test: use a fake")
            super().__init__(args, *rest, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", GuardedPopen)
    return home


TOKEN = "t" * 43
JOB = {
    "id": "11111111-1111-4111-8111-111111111111",
    "leaseId": "22222222-2222-4222-8222-222222222222",
    "kind": "transcribe",
    "mediaId": "33333333-3333-4333-8333-333333333333",
    "attempt": 1,
    "leaseMs": 60000,
    "durationMs": 10000,
    "audioPath": "/api/v1/media-worker/jobs/11111111-1111-4111-8111-111111111111/audio",
}


class FakeApi:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict | None, dict]] = []
        self.jobs: list[dict] = [dict(JOB)]
        self.status: dict[str, int] = {}
        self.terms = {"version": 1, "terms": ["Hoasca", "Mestre Gabriel", "Caiano"]}
        self.token = TOKEN
        self.profiles: list[dict] = []
        self.revoked: set[str] = set()

    def answer(self, handler: BaseHTTPRequestHandler, method: str) -> None:
        url = urlparse(handler.path)
        length = int(handler.headers.get("content-length") or 0)
        body = json.loads(handler.rfile.read(length)) if length else None
        self.calls.append((method, url.path, body, dict(handler.headers)))
        if handler.headers.get("authorization") != f"Bearer {self.token}":
            return self._send(handler, 401, b'{"error":{"code":"UNAUTHENTICATED"}}')
        action = url.path.rsplit("/", 1)[-1]
        forced = self.status.get(action)
        if forced:
            return self._send(handler, forced, b"{}")
        if action == "lease":
            if not self.jobs:
                return self._send(handler, 204, b"")
            return self._send(handler, 200, json.dumps(self.jobs.pop(0)).encode())
        if action == "terms":
            return self._send(handler, 200, json.dumps(self.terms).encode())
        if action == "heartbeat":
            hits = [one for one in body.get("voiceProfiles", []) if one in self.revoked]
            if hits:
                return self._send(handler, 200, json.dumps({"revokedVoiceProfiles": hits}).encode())
        if action == "voice-profiles":
            return self._send(handler, 200, json.dumps({"profiles": self.profiles}).encode())
        if action == "audio" or "/audio/" in url.path:
            return self._send(handler, 200, b"fake-flac", "audio/flac")
        return self._send(handler, 204, b"")

    @staticmethod
    def _send(handler, status: int, payload: bytes, kind: str = "application/json") -> None:
        handler.send_response(status)
        handler.send_header("content-type", kind)
        handler.send_header("content-length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)

    def bodies(self, action: str) -> list[dict]:
        return [body for _, path, body, _ in self.calls if path.endswith(f"/{action}")]


@pytest.fixture
def fake_api():
    api = FakeApi()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            api.answer(self, "GET")

        def do_POST(self):
            api.answer(self, "POST")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    api.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield api
    server.shutdown()
    server.server_close()


class FakeModel:
    """mlx_whisper.transcribe's shape: records each call, returns one segment per chunk."""

    def __init__(self, on_call=None) -> None:
        self.calls: list[dict] = []
        self.on_call = on_call

    def __call__(self, audio: np.ndarray, **kwargs) -> dict:
        self.calls.append({"samples": len(audio), **kwargs})
        if self.on_call:
            self.on_call(len(self.calls))
        seconds = len(audio) / 16000
        return {
            "text": " Existia um rei.",
            "segments": [
                {
                    "start": np.float64(0.0),
                    "end": np.float64(min(seconds, 2.0)),
                    "text": " Existia um rei.",
                    "tokens": np.array([50365, 2111]),
                    "temperature": 0.0,
                    "avg_logprob": np.float32(-0.25),
                    "compression_ratio": 1.2,
                    "no_speech_prob": 0.01,
                    "words": [{"word": " Existia", "start": 0.0, "end": 0.9, "probability": 0.92}],
                }
            ],
            "language": "pt",
        }

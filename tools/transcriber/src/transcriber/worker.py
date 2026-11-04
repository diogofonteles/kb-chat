"""The loop: lease one job, fetch its audio, transcribe it or separate its voices, upload.

A lost lease (409) or a shutdown stops the job between chunks and uploads nothing; the
lease then expires and the API puts the job back in the queue (ADR 0022 §2). One job at a
time: a transcription and a separation never run together on this Mac (KBC-064 BR-5).
"""

import logging
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .api import ApiClient, ApiError, Unauthorized
from .audio import InvalidAudio
from .config import (
    DIARIZE_PARAMETERS,
    DIARIZE_PARAMETERS_VERSION,
    ERROR_BACKOFF_S,
    HEARTBEAT_S,
    PARAMETERS,
    PARAMETERS_VERSION,
    POLL_S,
    UNAUTHORIZED_BACKOFF_S,
)
from .diarize import Diarizer, separate
from .secret import TokenError
from .transcribe import Stopped, TokenCounter, WhisperModel, build_prompt, estimate_tokens
from .transcribe import transcribe_track as run_track
from .vad import SpeechFinder
from .voiceprint import (
    Embedder,
    Profile,
    match_voices,
    mean_print,
    spans_of,
    window_vectors,
    wipe,
)

REVOKED = "Token revogado; pareie de novo."
log = logging.getLogger("transcriber")


class _JobStop:
    """Set by a shutdown or a lost lease: either one stops the job."""

    def __init__(self, shutdown: threading.Event) -> None:
        self._shutdown = shutdown
        self.lease_lost = threading.Event()

    def is_set(self) -> bool:
        return self._shutdown.is_set() or self.lease_lost.is_set()


@dataclass
class Worker:
    api: ApiClient
    model: WhisperModel
    find_speech: SpeechFinder
    decode: Callable[[Path], np.ndarray]
    stop: threading.Event = field(default_factory=threading.Event)
    heartbeat_s: float = HEARTBEAT_S
    poll_s: float = POLL_S
    unauthorized_backoff_s: float = UNAUTHORIZED_BACKOFF_S
    error_backoff_s: float = ERROR_BACKOFF_S
    count_tokens: TokenCounter = estimate_tokens
    # Voice separation (KBC-064): without an engine, the worker never asks for it.
    diarizer: Diarizer | None = None
    # Voice prints (KBC-071): without a speaker model, none is ever fetched or made.
    embedder: Embedder | None = None

    @property
    def kinds(self) -> tuple[str, ...]:
        kinds = ("transcribe", "diarize") if self.diarizer else ("transcribe",)
        return (*kinds, "voice-profile") if self.embedder else kinds

    def run(self, *, once: bool = False, exit_when_idle: bool = False) -> int:
        """Runs until stopped; `once` handles at most one job, `exit_when_idle` stops at 204."""
        log.info(
            "transcriber started (parameters %s, jobs: %s)",
            PARAMETERS_VERSION,
            ", ".join(self.kinds),
        )
        while not self.stop.is_set():
            outcome = self.step()
            if outcome == "job" and once:
                break
            if outcome == "idle":
                if exit_when_idle or once:
                    break
                self.stop.wait(self.poll_s)
            elif outcome == "revoked":
                self.stop.wait(self.unauthorized_backoff_s)
            elif outcome == "error":
                self.stop.wait(self.error_backoff_s)
        log.info("transcriber stopped")
        return 0

    def step(self) -> str:
        """One lease attempt: 'job', 'idle', 'revoked' or 'error'."""
        try:
            job = self.api.lease(self.kinds)
        except (Unauthorized, TokenError) as err:
            log.error(REVOKED if isinstance(err, Unauthorized) else str(err))
            return "revoked"
        except ApiError as err:
            log.warning("could not lease a job: %s", err)
            return "error"
        return "idle" if job is None else self._run_job(job)

    def _run_job(self, job: dict) -> str:
        """Processes one job; 'job', or 'revoked'/'error' when it could not finish."""
        try:
            self.process(job)
        except (Unauthorized, TokenError) as err:
            log.error(REVOKED if isinstance(err, Unauthorized) else str(err))
            return "revoked"
        except ApiError as err:
            log.warning("job %s: the API failed: %s", job["id"], err)
            return "error"
        # One bad job must not stop the Mac's worker: it is given back, the loop goes on.
        except Exception as err:
            log.exception("job %s: unexpected failure", job["id"])
            self._report_crash(job, err)
            return "error"
        return "job"

    def _report_crash(self, job: dict, err: Exception) -> None:
        """Gives the job back as retryable; the lease would expire anyway if this fails."""
        try:
            self.api.fail(job, "conversion-failed", f"{type(err).__name__}: {err}")
        except Exception:
            log.warning("job %s: could not report the failure", job["id"])

    def process(self, job: dict) -> None:
        stop = _JobStop(self.stop)
        progress = {"percent": 0}
        done = threading.Event()
        beats = threading.Thread(target=self._beat, args=(job, progress, stop, done), daemon=True)
        beats.start()
        try:
            with tempfile.TemporaryDirectory(prefix="transcriber-") as work:
                handler = {
                    "diarize": self._diarize,
                    "voice-profile": self._voice_profile,
                }.get(job["kind"], self._transcribe)
                handler(job, Path(work), progress, stop)
        finally:
            done.set()
            beats.join(timeout=5)

    def _transcribe(self, job: dict, work: Path, progress: dict, stop: _JobStop) -> None:
        terms = self.api.terms()
        pcm = self._audio_of(job, work)
        if pcm is None:
            return
        started = time.monotonic()
        try:
            result = run_track(
                pcm,
                model=self.model,
                prompt=build_prompt(terms["terms"], count=self.count_tokens),
                find_speech=self.find_speech,
                stop=stop,
                on_progress=lambda percent: progress.__setitem__("percent", percent),
            )
        except Stopped:
            reason = "lease lost" if stop.lease_lost.is_set() else "shutdown"
            log.warning("job %s stopped (%s): nothing uploaded", job["id"], reason)
            return
        except Exception as err:
            log.exception("job %s: transcription failed", job["id"])
            self.api.fail(job, "conversion-failed", f"{type(err).__name__}: {err}")
            return
        elapsed_ms = int((time.monotonic() - started) * 1000)
        self._upload(job, terms, result, elapsed_ms, stop)

    def _diarize(self, job: dict, work: Path, progress: dict, stop: _JobStop) -> None:
        """Separates the voices of the job's audio and uploads only the turns (BR-1)."""
        if self.diarizer is None:
            raise RuntimeError("leased a separation without a diarization engine")
        pcm = self._audio_of(job, work)
        if pcm is None:
            return
        progress["percent"] = 10
        started = time.monotonic()
        try:
            turns = separate(pcm, diarizer=self.diarizer, voices=job.get("voices"), scratch=work)
        except Exception as err:
            log.exception("job %s: voice separation failed", job["id"])
            self.api.fail(job, "conversion-failed", f"{type(err).__name__}: {err}")
            return
        progress["percent"] = 100
        if stop.is_set():
            log.warning("job %s stopped before the upload: nothing uploaded", job["id"])
            return
        body = {
            "engine": self.diarizer.engine,
            "model": self.diarizer.model,
            "parametersVersion": DIARIZE_PARAMETERS_VERSION,
            "parameters": DIARIZE_PARAMETERS,
            "requestedVoices": job.get("voices"),
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "raw": {"turns": turns},
        }
        matches = self._matches(job, pcm, turns)
        if matches:
            body["voiceMatches"] = matches
        if stop.is_set():
            log.warning("job %s stopped before the upload: nothing uploaded", job["id"])
            return
        if self.api.upload_diarization(job, body):
            voices = len({turn["voice"] for turn in turns})
            log.info("job %s: %d voices, %d turns", job["id"], voices, len(turns))
        else:
            log.warning("job %s: the lease was lost before the upload: dropped", job["id"])

    def _matches(self, job: dict, pcm: np.ndarray, turns: list[dict]) -> list[dict]:
        """The closest profile per voice; a failure here never costs the separation."""
        if self.embedder is None:
            return []
        try:
            profiles = self._profiles_of(job)
            if not profiles:
                return []
            try:
                return match_voices(pcm, turns, profiles, self.embedder)
            finally:
                wipe(one.embedding for one in profiles)
        except ApiError as err:
            log.warning("job %s: no voice comparison: %s", job["id"], err)
        except Exception as err:
            # The type only: no message of a numeric library near a print goes to a log.
            log.warning("job %s: no voice comparison: %s", job["id"], type(err).__name__)
        return []

    def _profiles_of(self, job: dict) -> list[Profile]:
        """The prints of the job's collection on this model; they live in memory only."""
        model = self.embedder.model if self.embedder else None
        return [
            Profile(one["id"], np.asarray(one["embedding"], dtype=np.float64))
            for one in self.api.voice_profiles(job)
            if one["model"] == model
        ]

    def _voice_profile(self, job: dict, work: Path, progress: dict, stop: _JobStop) -> None:
        """Calculates the print of a voice a person named, and uploads only that (FR-2)."""
        if self.embedder is None:
            raise RuntimeError("leased a voice profile without a speaker model")
        vectors: list[np.ndarray] = []
        try:
            for index, source in enumerate(job["sources"]):
                pcm = self._audio_of(job, work, source["audioPath"])
                if pcm is None:
                    return
                spans = spans_of(source["spans"])
                vectors.append(window_vectors(pcm, spans, self.embedder))
                progress["percent"] = int((index + 1) * 90 / len(job["sources"]))
                if stop.is_set():
                    log.warning("job %s stopped: nothing uploaded", job["id"])
                    return
            self._upload_print(job, vectors)
        except ValueError as err:
            self.api.fail(job, "conversion-failed", str(err))
        finally:
            wipe(vectors)

    def _upload_print(self, job: dict, vectors: list[np.ndarray]) -> None:
        if self.embedder is None:
            raise RuntimeError("leased a voice profile without a speaker model")
        voice_print = mean_print(vectors)
        body = {
            "model": self.embedder.model,
            "embedding": [round(float(value), 7) for value in voice_print],
        }
        wipe([voice_print])
        if self.api.upload_print(job, body):
            log.info("job %s: voice print stored", job["id"])
        else:
            log.warning("job %s: the lease was lost before the upload: dropped", job["id"])

    def _audio_of(self, job: dict, work: Path, path: str | None = None) -> np.ndarray | None:
        """The job's audio as 16 kHz PCM; None when it is not ours or cannot be decoded."""
        audio = self.api.download(job, work, path)
        if audio is None:
            log.warning("job %s: its audio is not ours (404): dropped", job["id"])
            return None
        try:
            return self.decode(audio)
        except InvalidAudio as err:
            log.error("job %s: the audio cannot be decoded", job["id"])
            self.api.fail(job, "invalid-audio", str(err))
            return None

    def _upload(self, job: dict, terms: dict, result, elapsed_ms: int, stop: _JobStop) -> None:
        if stop.is_set():
            log.warning("job %s stopped before the upload: nothing uploaded", job["id"])
            return
        body = {
            "provider": "mlx-whisper",
            "model": PARAMETERS["model"],
            "parametersVersion": PARAMETERS_VERSION,
            "parameters": PARAMETERS,
            "termsVersion": terms["version"],
            "vad": result.vad,
            "speechRatio": result.speech_ratio,
            "elapsedMs": elapsed_ms,
            "raw": result.raw,
        }
        if self.api.upload(job, body):
            log.info(
                "job %s transcribed: %d chunks, vad %s, %.1f s",
                job["id"],
                len(result.raw["chunks"]),
                result.vad,
                elapsed_ms / 1000,
            )
        else:
            log.warning("job %s: the lease was lost before the upload: dropped", job["id"])

    def _beat(self, job: dict, progress: dict, stop: _JobStop, done: threading.Event) -> None:
        while not done.wait(self.heartbeat_s):
            try:
                held = self.api.heartbeat(job, progress["percent"])
            except Unauthorized:
                log.error(REVOKED)
                held = False
            except ApiError as err:
                log.warning("job %s: heartbeat failed: %s", job["id"], err)
                continue
            if not held:
                log.warning("job %s: lease lost, stopping", job["id"])
                stop.lease_lost.set()
                return

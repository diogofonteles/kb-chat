"""Decoding with ffmpeg to 16 kHz mono float32, as the pilot did."""

import shutil
import subprocess
from pathlib import Path

import numpy as np

from .config import SAMPLE_RATE


class InvalidAudio(Exception):
    """ffmpeg could not decode the file: a permanent failure of the job."""


def ffmpeg_bin() -> str:
    found = shutil.which("ffmpeg")
    if not found:
        raise RuntimeError("ffmpeg is not on PATH (brew install ffmpeg)")
    return found


def decode_pcm16k(path: Path) -> np.ndarray:
    command = [ffmpeg_bin(), "-nostdin", "-v", "error", "-i", str(path)]
    command += ["-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"]
    done = subprocess.run(command, capture_output=True, check=False)
    if done.returncode != 0:
        raise InvalidAudio(done.stderr.decode("utf-8", "replace").strip()[-1000:])
    pcm = np.frombuffer(done.stdout, np.int16).astype(np.float32) / 32768.0
    if pcm.size == 0:
        raise InvalidAudio("the file decoded to no audio")
    return pcm

"""The transcription parameters of the pilot (ADR 0023 §3), versioned in this one file.

Change a value here and bump PARAMETERS_VERSION: the API stores both with every transcript,
so a later re-transcription knows which set produced each version.
"""

from typing import Final

PARAMETERS_VERSION: Final = "2026-10-28.1"

MODEL: Final = "mlx-community/whisper-large-v3-turbo"
SAMPLE_RATE: Final = 16_000

PARAMETERS: Final[dict] = {
    "model": MODEL,
    "language": "pt",
    "word_timestamps": True,
    # Fallback temperatures, never a fixed 0 (the pilot's loops got worse with 0 only).
    "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    "condition_on_previous_text": False,
    "vad": {
        "engine": "silero-vad 6.2",
        "threshold": 0.5,
        "min_speech_duration_ms": 250,
        "min_silence_duration_ms": 1000,
        "speech_pad_ms": 300,
        "max_speech_duration_s": 28,
    },
    # Speech segments are merged into chunks no longer than this (whisper's window is 30 s).
    "chunk_max_s": 28.0,
    # Under this share of speech the track is transcribed whole, without VAD (BR-4).
    "min_speech_ratio": 0.40,
    # The term list goes in every chunk's initial_prompt, within whisper's prompt budget.
    "prompt_max_tokens": 224,
}

HEARTBEAT_S: Final = 15.0
# This long after the last answered heartbeat was sent, a job drops what it holds of a voice
# print: it cannot know of a revocation (KBC-071 BR-2). It allows one missed heartbeat, and it
# keeps the 1 minute of the consent with the API out of reach or answering late.
PRINT_ACK_S: Final = 40.0
POLL_S: Final = 30.0
# `--exit-when-idle` (KBC-114): the next stage of an audio is queued within seconds of the
# last one; after this grace with nothing, the worker exits until the API starts it again.
IDLE_GRACE_S: Final = 30.0
# ...and it exits after this many lease errors in a row instead of waiting in memory.
MAX_IDLE_ERRORS: Final = 3
# The sign of life to the app while nothing changes (KBC-114 FR-8); a change goes at once.
STATUS_EVERY_S: Final = 30.0
UNAUTHORIZED_BACKOFF_S: Final = 600.0
ERROR_BACKOFF_S: Final = 60.0

KEYCHAIN_SERVICE: Final = "nova-alexandria-transcriber"
KEYCHAIN_ACCOUNT: Final = "transcriber"

# Voice separation (KBC-064, ADR 0029 §1). Bump DIARIZE_PARAMETERS_VERSION with any change:
# the API stores both with every separation, next to its raw turns.
DIARIZE_PARAMETERS_VERSION: Final = "2026-11-03.1"

DIARIZE_PARAMETERS: Final[dict] = {
    "engine": "senko",
    # github.com/narcotic-sh/senko at this commit (MIT): measured best on our pt-BR audio.
    "senko_commit": "1bcb090",
    # Senko's merged segments (gaps <= 4 s of one voice joined, turns <= 0.78 s dropped).
    "segments": "merged",
    # One voice per instant: where two turns overlap, the later one takes over.
    "exclusive": True,
    # At most this many voices (BR-4): more are joined by the cosine of their centroids,
    # in memory; the number a person announces caps it too.
    "max_voices": 10,
    # Under 20 min Senko clusters spectrally and takes the announced number directly.
    "announced_voices": "spectral oracle + centroid join",
}

# The checkpoint runs on the Mac that handles biometric data: this commit, never the latest.
VOICE_MODEL_REVISION: Final = "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286"

# Voice profiles (KBC-071, ADR 0032). The recipe measured in KBC-063, not calibrated: 2
# speakers and 3 decisions cannot show a false-positive rate. The threshold itself is the API's.
VOICE_PARAMETERS: Final[dict] = {
    "model": "speechbrain/spkrec-ecapa-voxceleb",
    "window_s": 1.5,
    "hop_s": 0.75,
    # A voice needs this much speech to be compared at all.
    "min_speech_s": 10.0,
    # The closest profile must beat the next by this much (it kept out a false positive).
    "margin": 0.1,
}

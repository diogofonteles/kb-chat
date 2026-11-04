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
POLL_S: Final = 30.0
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

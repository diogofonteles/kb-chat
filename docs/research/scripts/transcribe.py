"""Local transcription with mlx-whisper large-v3-turbo (pt, word timestamps).

Usage:
  python transcribe.py <wav> <out_json>

Writes the mlx-whisper result (segments with words) plus the wall time. Stays on the Mac.
"""

import json
import sys
import time

import mlx_whisper
import soundfile as sf

MODEL = "mlx-community/whisper-large-v3-turbo"


def main() -> None:
    wav, out = sys.argv[1], sys.argv[2]
    dur = sf.info(wav).duration
    t0 = time.time()
    res = mlx_whisper.transcribe(wav, path_or_hf_repo=MODEL, language="pt", word_timestamps=True)
    wall = time.time() - t0
    res["_timing"] = {"wall_s": round(wall, 1), "duration_s": round(dur, 1), "machine_s_per_audio_hour": round(wall / dur * 3600, 1)}
    with open(out, "w") as f:
        json.dump(res, f, ensure_ascii=False)
    print(out, res["_timing"])


if __name__ == "__main__":
    main()

"""Diarization with Senko (MIT, github.com/narcotic-sh/senko): pyannote-3.0 VAD/segmentation in CoreML + CAM++.

Usage:
  python diarize_senko.py <wav> <out_prefix>

Writes <out_prefix>.json (merged segments, speaking time per speaker, timings) and <out_prefix>.npz
(speaker centroids, CAM++ 192-d) for the recognition step. Runs fully local.
"""

import json
import os
import sys
import time

import numpy as np
import soundfile as sf
from senko import Diarizer


def main() -> None:
    wav, out = sys.argv[1], sys.argv[2]
    dur = sf.info(wav).duration
    t_load = time.time()
    diarizer = Diarizer(device="auto", warmup=True, quiet=True)
    load_s = time.time() - t_load
    t0 = time.time()
    res = diarizer.diarize(wav)
    total = time.time() - t0
    segs = res["merged_segments"]
    talk: dict[str, float] = {}
    for s in segs:
        talk[s["speaker"]] = talk.get(s["speaker"], 0.0) + s["end"] - s["start"]
    talk = dict(sorted(talk.items(), key=lambda kv: -kv[1]))
    cents = res["speaker_centroids"]
    names = list(talk.keys())
    result = {
        "wav": os.path.basename(wav),
        "duration_s": round(dur, 1),
        "speakers": len(talk),
        "speaking_time_s": {k: round(v, 1) for k, v in talk.items()},
        "vad_speech_s": round(sum(e - s for s, e in res["vad"]), 1),
        "timing_s": {k: round(float(v), 2) for k, v in res["timing_stats"].items()},
        "model_load_s": round(load_s, 2),
        "machine_s_per_audio_hour": round(total / dur * 3600, 1),
        "segments": [{"start": round(s["start"], 2), "end": round(s["end"], 2), "speaker": s["speaker"]} for s in segs],
    }
    np.savez(out + ".npz", names=np.array(names), cents=np.stack([np.asarray(cents[n]) for n in names]))
    with open(out + ".json", "w") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    print(json.dumps({k: v for k, v in result.items() if k != "segments"}, indent=1))


if __name__ == "__main__":
    main()

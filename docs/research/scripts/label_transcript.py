"""Attach a speaker label to each Whisper segment and pick verification samples for the owner.

Each segment gets the diarization cluster with the largest time overlap (word-level would be finer; segment-level
is enough for spot checks). For each cluster, 3 samples spread over the recording (segments >= 3 s, mostly one
speaker) with start-end and first words.

Usage:
  python label_transcript.py <transcript.json> <diarization.json> [--samples 3] [--words 12]
Prints a markdown table; writes nothing (transcripts stay in the research dir).
"""

import argparse
import json


def fmt(t: float) -> str:
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("diarization")
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--words", type=int, default=12)
    a = ap.parse_args()
    tx = json.load(open(a.transcript))
    dz = json.load(open(a.diarization))
    labelled = []
    for seg in tx["segments"]:
        ov: dict[str, float] = {}
        for d in dz["segments"]:
            o = min(seg["end"], d["end"]) - max(seg["start"], d["start"])
            if o > 0:
                ov[d["speaker"]] = ov.get(d["speaker"], 0.0) + o
        if not ov:
            continue
        spk = max(ov, key=ov.get)
        purity = ov[spk] / max(seg["end"] - seg["start"], 1e-6)
        labelled.append({**seg, "speaker": spk, "purity": purity})
    print(f"| cluster | início–fim | primeiras palavras |\n|---|---|---|")
    for spk in dz["speaking_time_s"]:
        cand = [s for s in labelled if s["speaker"] == spk and s["end"] - s["start"] >= 3 and s["purity"] >= 0.8]
        if not cand:
            cand = [s for s in labelled if s["speaker"] == spk]
        if not cand:
            continue
        n = len(cand)
        picks = [cand[int(i * (n - 1) / max(a.samples - 1, 1))] for i in range(min(a.samples, n))]
        seen = set()
        for s in picks:
            if s["start"] in seen:
                continue
            seen.add(s["start"])
            words = " ".join(s["text"].split()[: a.words])
            print(f"| {spk} | {fmt(s['start'])}–{fmt(s['end'])} | {words}… |")
    total = {}
    for s in labelled:
        total[s["speaker"]] = total.get(s["speaker"], 0) + 1
    print(f"\nsegments per cluster: {total}")


if __name__ == "__main__":
    main()

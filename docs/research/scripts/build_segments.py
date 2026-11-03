"""Numbered, speaker-labelled segments for the track proposal step.

Speaker label per Whisper segment = Senko group with the largest overlap; name only where the senko+ecapa recipe
recognised the group at T (default 0.4, margin 0.1, from recognize_speakers.py output), else "Voz 1", "Voz 2"...
numbered by speaking time. Empty segments are dropped; ids are renumbered from 1.

Usage:
  python build_segments.py <out_dir> <name> [--tag t0.3] [--t 0.4]
Writes <out_dir>/segs_<name>.json (stays in the research dir; never in the repo).
"""

import argparse
import json
import os


def labels_for(out: str, name: str, tag: str, t: float) -> dict[str, str]:
    rec = json.load(open(os.path.join(out, f"recognition_{tag}.json")))
    rows = [r for r in next(x for x in rec if x["recipe"] == "senko+ecapa")["rows"] if r["test"] == name]
    talk = json.load(open(os.path.join(out, f"senko_{name}.json")))["speaking_time_s"]
    names, n = {}, 0
    for spk in talk:  # already sorted by speaking time
        row = next((r for r in rows if r["cluster"] == spk), None)
        dec = row["decisions"].get(str(t), "não sei") if row else "não sei"
        if dec.startswith("é o "):
            names[spk] = dec[len("é o ") :]
        else:
            n += 1
            names[spk] = f"Voz {n}"
    return names


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("name")
    ap.add_argument("--tag", default="t0.3")
    ap.add_argument("--t", type=float, default=0.4)
    a = ap.parse_args()
    out = os.path.expanduser(a.out_dir)
    tx = json.load(open(os.path.join(out, f"tx_{a.name}.json")))
    dz = json.load(open(os.path.join(out, f"senko_{a.name}.json")))
    names = labels_for(out, a.name, a.tag, a.t)
    segs = []
    for seg in tx["segments"]:
        text = seg["text"].strip()
        if not text:
            continue
        ov: dict[str, float] = {}
        for d in dz["segments"]:
            o = min(seg["end"], d["end"]) - max(seg["start"], d["start"])
            if o > 0:
                ov[d["speaker"]] = ov.get(d["speaker"], 0.0) + o
        spk = max(ov, key=ov.get) if ov else (segs[-1]["spk"] if segs else next(iter(names)))
        segs.append({"id": len(segs) + 1, "start": round(seg["start"], 2), "end": round(seg["end"], 2), "spk": spk, "voz": names[spk], "texto": text})
    with open(os.path.join(out, f"segs_{a.name}.json"), "w") as f:
        json.dump({"name": a.name, "labels": names, "segments": segs}, f, ensure_ascii=False, indent=0)
    print(a.name, names, len(segs), "segments")


if __name__ == "__main__":
    main()

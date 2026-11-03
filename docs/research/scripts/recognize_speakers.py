"""Speaker recognition test (KBC-063 FR-5): profile from the reference recording, recognition in the test one.

Profile = mean of the L2-normalised embeddings of the dominant cluster (most speaking time) of the reference
recording; the name comes from the reference title. In each test recording, every cluster centroid is compared
(cosine) with BOTH profiles; decision "é o <nome>" if sim >= T and margin to the other profile >= 0.1.

Three recipes, from the outputs of diarize_ecapa.py / diarize_senko.py:
  ecapa        ECAPA windows + ECAPA clustering (baseline)
  senko        Senko clusters + Senko CAM++ centroids
  senko+ecapa  Senko clusters, ECAPA embeddings of the windows that fall inside each Senko cluster

Usage:
  python recognize_speakers.py <out_dir> <ecapa_tag> [--min-test-s 10]
  e.g. python recognize_speakers.py ~/dev/personal/kb-chat-research/out t0.3
"""

import argparse
import json
import os

import numpy as np

PAIRS = {"Mestre José Luiz": ("joseluiz_ref", "joseluiz_test"), "Mestre Monteiro": ("monteiro_ref", "monteiro_test")}
THRESHOLDS = [0.4, 0.5, 0.6, 0.7]
MARGIN = 0.1


def unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


def ecapa_clusters(out: str, name: str, tag: str) -> dict[str, tuple[np.ndarray, float]]:
    d = np.load(os.path.join(out, f"ecapa_{name}_{tag}.npz"))
    meta = json.load(open(os.path.join(out, f"ecapa_{name}_{tag}.json")))
    res = {}
    for lab in np.unique(d["labels"]):
        key = f"C{lab}"
        res[key] = (unit(d["emb"][d["labels"] == lab].mean(0)), meta["speaking_time_s"].get(key, 0.0))
    return res


def senko_clusters(out: str, name: str) -> dict[str, tuple[np.ndarray, float]]:
    d = np.load(os.path.join(out, f"senko_{name}.npz"))
    meta = json.load(open(os.path.join(out, f"senko_{name}.json")))
    return {str(n): (unit(c), meta["speaking_time_s"][str(n)]) for n, c in zip(d["names"], d["cents"])}


def senko_ecapa_clusters(out: str, name: str, tag: str) -> dict[str, tuple[np.ndarray, float]]:
    d = np.load(os.path.join(out, f"ecapa_{name}_{tag}.npz"))
    meta = json.load(open(os.path.join(out, f"senko_{name}.json")))
    segs = meta["segments"]
    owner = []
    for s, e in d["windows"]:
        best, best_ov = None, 0.0
        for g in segs:
            ov = min(e, g["end"]) - max(s, g["start"])
            if ov > best_ov:
                best, best_ov = g["speaker"], ov
        owner.append(best if best_ov >= 0.5 * (e - s) else None)
    owner = np.array(owner, dtype=object)
    res = {}
    for spk, talk in meta["speaking_time_s"].items():
        mask = owner == spk
        if mask.sum() >= 2:
            res[spk] = (unit(d["emb"][mask].mean(0)), talk)
    return res


def run(recipe: str, loader, min_test_s: float) -> dict:
    profiles = {}
    for person, (ref, _) in PAIRS.items():
        cl = loader(ref)
        dom = max(cl, key=lambda k: cl[k][1])
        profiles[person] = {"vec": cl[dom][0], "cluster": dom, "talk_s": cl[dom][1]}
    rows = []
    for person, (_, test) in PAIRS.items():
        for key, (vec, talk) in sorted(loader(test).items(), key=lambda kv: -kv[1][1]):
            sims = {p: float(vec @ profiles[p]["vec"]) for p in profiles}
            row = {"test": test, "cluster": key, "talk_s": talk, "sims": {p: round(v, 3) for p, v in sims.items()}}
            row["decisions"] = {}
            for t in THRESHOLDS:
                best = max(sims, key=sims.get)
                other = min(sims, key=sims.get)
                ok = talk >= min_test_s and sims[best] >= t and sims[best] - sims[other] >= MARGIN
                row["decisions"][str(t)] = f"é o {best}" if ok else "não sei"
            rows.append(row)
    prof_cross = float(profiles["Mestre José Luiz"]["vec"] @ profiles["Mestre Monteiro"]["vec"])
    return {
        "recipe": recipe,
        "profiles": {p: {"cluster": v["cluster"], "talk_s": v["talk_s"]} for p, v in profiles.items()},
        "profile_cross_sim": round(prof_cross, 3),
        "rows": rows,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("ecapa_tag")
    ap.add_argument("--min-test-s", type=float, default=10.0)
    a = ap.parse_args()
    out = os.path.expanduser(a.out_dir)
    results = [
        run("ecapa", lambda n: ecapa_clusters(out, n, a.ecapa_tag), a.min_test_s),
        run("senko", lambda n: senko_clusters(out, n), a.min_test_s),
        run("senko+ecapa", lambda n: senko_ecapa_clusters(out, n, a.ecapa_tag), a.min_test_s),
    ]
    with open(os.path.join(out, f"recognition_{a.ecapa_tag}.json"), "w") as f:
        json.dump(results, f, indent=1, ensure_ascii=False)
    for r in results:
        print(f"\n### {r['recipe']}  profiles={r['profiles']}  profile×profile={r['profile_cross_sim']}")
        print("| teste | cluster | fala (s) | sim José Luiz | sim Monteiro | " + " | ".join(f"T={t}" for t in THRESHOLDS) + " |")
        for row in r["rows"]:
            s = row["sims"]
            dec = " | ".join(row["decisions"][str(t)] for t in THRESHOLDS)
            print(f"| {row['test']} | {row['cluster']} | {row['talk_s']} | {s['Mestre José Luiz']} | {s['Mestre Monteiro']} | {dec} |")


if __name__ == "__main__":
    main()

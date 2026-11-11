"""Full cosine matrix between every ECAPA cluster centroid (>= --min-s of speech) of the 4 recordings.

Shows how close the same voice is across recordings and how far other voices are, i.e. what a threshold
has to separate. Uses ECAPA embeddings with either ECAPA clusters (--source ecapa) or Senko clusters (--source senko).

Usage:
  python cluster_matrix.py <out_dir> <ecapa_tag> [--source ecapa|senko] [--min-s 10]
"""

import argparse
import os

import numpy as np
from recognize_speakers import ecapa_clusters, senko_ecapa_clusters

NAMES = ["joseluiz_ref", "joseluiz_test", "monteiro_ref", "monteiro_test"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("ecapa_tag")
    ap.add_argument("--source", default="ecapa")
    ap.add_argument("--min-s", type=float, default=10.0)
    a = ap.parse_args()
    out = os.path.expanduser(a.out_dir)
    keys, vecs = [], []
    for n in NAMES:
        cl = ecapa_clusters(out, n, a.ecapa_tag) if a.source == "ecapa" else senko_ecapa_clusters(out, n, a.ecapa_tag)
        for k, (v, talk) in sorted(cl.items(), key=lambda kv: -kv[1][1]):
            if talk >= a.min_s:
                keys.append(f"{n}:{k} ({talk:.0f}s)")
                vecs.append(v)
    m = np.stack(vecs) @ np.stack(vecs).T
    print("| | " + " | ".join(str(i) for i in range(len(keys))) + " |")
    print("|---" * (len(keys) + 1) + "|")
    for i, k in enumerate(keys):
        print(f"| {i} {k} | " + " | ".join(f"{m[i, j]:.2f}" for j in range(len(keys))) + " |")


if __name__ == "__main__":
    main()

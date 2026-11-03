"""Baseline diarization: Silero VAD + SpeechBrain ECAPA on sliding windows + agglomerative clustering
(average linkage, cosine-similarity threshold) + clusters under --min-cluster-s absorbed into the nearest big one.
Device mps (identical embeddings to cpu, cos >= 0.99999, about 50x faster on this Mac).

Usage:
  python diarize_ecapa.py <wav> <out_prefix> [--threshold 0.30] [--min-cluster-s 10] [--win 1.5] [--hop 0.75]

Writes <out_prefix>.npz (window times, L2-normalised embeddings, labels) and <out_prefix>.json
(merged segments, speaking time per cluster, timings). Nothing leaves the machine; the
ECAPA weights are downloaded once from Hugging Face (speechbrain/spkrec-ecapa-voxceleb).
"""

import argparse
import json
import os
import time

import numpy as np
import soundfile as sf
import torch
from silero_vad import get_speech_timestamps, load_silero_vad
from sklearn.cluster import AgglomerativeClustering
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
MODEL_DIR = os.path.expanduser("~/dev/personal/kb-chat-research/models/spkrec-ecapa-voxceleb")


def speech_regions(wav: np.ndarray) -> list[tuple[float, float]]:
    model = load_silero_vad()
    stamps = get_speech_timestamps(
        torch.from_numpy(wav), model, sampling_rate=SR, min_speech_duration_ms=300, min_silence_duration_ms=300
    )
    return [(s["start"] / SR, s["end"] / SR) for s in stamps]


def make_windows(regions, win: float, hop: float) -> list[tuple[float, float]]:
    windows = []
    for start, end in regions:
        if end - start < 0.5:
            continue
        if end - start <= win:
            windows.append((start, end))
            continue
        t = start
        while t + win <= end:
            windows.append((t, t + win))
            t += hop
        if windows[-1][1] < end - hop / 2:
            windows.append((end - win, end))
    return windows


def embed(wav: np.ndarray, windows, device: str) -> np.ndarray:
    encoder = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb", savedir=MODEL_DIR, run_opts={"device": device}
    )
    n = int(1.5 * SR)
    out = []
    batch = 64
    for i in range(0, len(windows), batch):
        chunk = windows[i : i + batch]
        sig = torch.zeros(len(chunk), n)
        lens = torch.zeros(len(chunk))
        for j, (s, e) in enumerate(chunk):
            seg = wav[int(s * SR) : int(e * SR)][:n]
            sig[j, : len(seg)] = torch.from_numpy(seg)
            lens[j] = len(seg) / n
        with torch.no_grad():
            emb = encoder.encode_batch(sig.to(device), lens.to(device)).squeeze(1).cpu().numpy()
        out.append(emb)
    emb = np.concatenate(out)
    return emb / np.linalg.norm(emb, axis=1, keepdims=True)


def cluster(emb: np.ndarray, threshold: float) -> np.ndarray:
    # threshold is a cosine SIMILARITY; sklearn wants a cosine DISTANCE.
    algo = AgglomerativeClustering(
        n_clusters=None, metric="cosine", linkage="average", distance_threshold=1.0 - threshold
    )
    return algo.fit_predict(emb)


def absorb_small(emb: np.ndarray, labels: np.ndarray, hop: float, min_cluster_s: float) -> np.ndarray:
    """Clusters with less than min_cluster_s of speech join the most similar big cluster (by centroid)."""
    counts = np.bincount(labels)
    big = [c for c in range(len(counts)) if counts[c] * hop >= min_cluster_s]
    if not big:
        big = [int(np.argmax(counts))]
    cents = np.stack([emb[labels == c].mean(0) for c in big])
    cents /= np.linalg.norm(cents, axis=1, keepdims=True)
    out = labels.copy()
    small = ~np.isin(labels, big)
    if small.any():
        out[small] = np.array(big)[np.argmax(emb[small] @ cents.T, axis=1)]
    return out


def merge(windows, labels, hop: float, max_gap: float = 0.5):
    """Each window owns its central hop; adjacent same-label pieces merge if the gap is small."""
    pieces = []
    for (s, e), lab in zip(windows, labels):
        mid = (s + e) / 2
        pieces.append([max(s, mid - hop / 2), min(e, mid + hop / 2), int(lab)])
    pieces.sort()
    segs = []
    for p in pieces:
        if segs and segs[-1][2] == p[2] and p[0] - segs[-1][1] <= max_gap:
            segs[-1][1] = max(segs[-1][1], p[1])
        else:
            segs.append(p)
    return [{"start": round(s, 2), "end": round(e, 2), "speaker": f"C{lab}"} for s, e, lab in segs]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("out_prefix")
    ap.add_argument("--threshold", type=float, default=0.30)
    ap.add_argument("--win", type=float, default=1.5)
    ap.add_argument("--hop", type=float, default=0.75)
    ap.add_argument("--min-cluster-s", type=float, default=10.0)
    ap.add_argument("--device", default="mps")
    args = ap.parse_args()

    wav, sr = sf.read(args.wav, dtype="float32")
    assert sr == SR and wav.ndim == 1, "expects 16 kHz mono"
    dur = len(wav) / SR
    t0 = time.time()
    regions = speech_regions(wav)
    t_vad = time.time() - t0
    windows = make_windows(regions, args.win, args.hop)
    t1 = time.time()
    emb = embed(wav, windows, args.device)
    t_emb = time.time() - t1
    t2 = time.time()
    raw = cluster(emb, args.threshold)
    labels = absorb_small(emb, raw, args.hop, args.min_cluster_s)
    # Relabel clusters by speaking time (C0 = most windows).
    order = np.argsort(-np.bincount(labels))
    remap = {old: new for new, old in enumerate(order)}
    labels = np.array([remap[l] for l in labels])
    segs = merge(windows, labels, args.hop)
    t_clu = time.time() - t2
    total = time.time() - t0

    talk = {}
    for s in segs:
        talk[s["speaker"]] = talk.get(s["speaker"], 0.0) + s["end"] - s["start"]
    result = {
        "wav": os.path.basename(args.wav),
        "duration_s": round(dur, 1),
        "threshold_cos_sim": args.threshold,
        "speech_s": round(sum(e - s for s, e in regions), 1),
        "n_windows": len(windows),
        "min_cluster_s": args.min_cluster_s,
        "raw_clusters": int(len(set(raw.tolist()))),
        "speaking_time_s": {k: round(v, 1) for k, v in sorted(talk.items(), key=lambda kv: -kv[1])},
        "timing_s": {"vad": round(t_vad, 2), "embed": round(t_emb, 2), "cluster_merge": round(t_clu, 2), "total": round(total, 2)},
        "machine_s_per_audio_hour": round(total / dur * 3600, 1),
        "segments": segs,
    }
    np.savez(args.out_prefix + ".npz", windows=np.array(windows), emb=emb, labels=labels)
    with open(args.out_prefix + ".json", "w") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    print(json.dumps({k: v for k, v in result.items() if k != "segments"}, indent=1))


if __name__ == "__main__":
    main()

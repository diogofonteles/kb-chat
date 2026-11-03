"""Render the track proposals of several engines side by side, blind (Proposta 1/2/3), for the owner's judgement.

The engine → "Proposta N" mapping is shuffled with a fixed seed and printed only in a key section meant for the
very end of the results file. Output: markdown on stdout.

Usage:
  python blind_proposals.py <out_dir> <seed> <name>:<title> [<name>:<title> ...] --tags local,qwen3-235b-a22b-2507,deepseek-v4-flash
"""

import argparse
import json
import os
import random


def fmt(t: float) -> str:
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def first_words(segs: list[dict], first_id: int, n: int = 10) -> str:
    words: list[str] = []
    for s in segs:
        if s["id"] >= first_id:
            words += s["texto"].split()
            if len(words) >= n:
                break
    return " ".join(words[:n]).rstrip(",.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("seed", type=int)
    ap.add_argument("recordings", nargs="+")
    ap.add_argument("--tags", required=True)
    a = ap.parse_args()
    out = os.path.expanduser(a.out_dir)
    tags = a.tags.split(",")
    order = tags[:]
    random.Random(a.seed).shuffle(order)
    for rec in a.recordings:
        name, title = rec.split(":", 1)
        print(f"### {title}\n")
        for n, tag in enumerate(order, 1):
            d = json.load(open(os.path.join(out, f"tracks_{name}_{tag}.json")))
            print(f"#### Proposta {n} ({len(d['tracks'])} faixas)\n")
            segs = json.load(open(os.path.join(out, f"segs_{name}.json")))["segments"]
            by_id = {s["id"]: s for s in segs}
            covered = {i for t in d["tracks"] for i in range(t["primeiro_id"], t["ultimo_id"] + 1)}
            missing = [s["id"] for s in segs if s["id"] not in covered]
            if missing:
                gap = f"{fmt(by_id[missing[0]]['start'])}–{fmt(by_id[missing[-1]]['end'])}"
                print(f"Sem proposta válida de {gap} (a resposta para esse trecho veio inválida duas vezes).\n")
            print("| # | Início–fim | Título | Tipo | Pergunta → resposta | Primeiras palavras | Nota do título (1–5) | Limite errado? |")
            print("| --- | --- | --- | --- | --- | --- | --- | --- |")
            for i, t in enumerate(d["tracks"], 1):
                kind = "Pergunta e resposta" if t["tipo"] == "pergunta_resposta" else "Exposição"
                who = f"{t.get('quem_pergunta')} → {t.get('quem_responde')}" if t["tipo"] == "pergunta_resposta" else f"fala: {t.get('quem_responde')}"
                print(f"| {i} | {fmt(t['start'])}–{fmt(t['end'])} | {t['titulo']} | {kind} | {who} | \"{first_words(segs, t['primeiro_id'])}…\" | | |")
            print()
    print("<!-- key -->")
    print("| Proposta | Abordagem |\n| --- | --- |")
    for n, tag in enumerate(order, 1):
        print(f"| Proposta {n} | {tag} |")


if __name__ == "__main__":
    main()

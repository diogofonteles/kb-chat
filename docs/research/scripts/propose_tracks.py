"""Propose listening tracks (question + answer = one track; the rest = "Exposição") from a speaker-labelled
transcript, with a local MLX model or a cheap model on OpenRouter. Same prompt for every engine.

Input: <out_dir>/segs_<name>.json from build_segments.py (numbered segments, voice labels).
Windows: segments grouped by start time in windows of --window-min minutes. Fixed context = collection name
("UDV") and the voice labels (the recording title is NOT given); dynamic context = the tracks of the previous
window, and the first track of a window may continue the last one of the previous window.
Validation per window: JSON with "faixas"; ids exist; tracks in order, contiguous, covering the window, no
overlap; each track >= 5 s (a continuation is checked after merging); one retry with the error on failure.

Usage:
  python propose_tracks.py <out_dir> <name> --engine local [--model mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit]
  python propose_tracks.py <out_dir> <name> --engine openrouter --model qwen/qwen3-235b-a22b-2507
OpenRouter key: OPENROUTER_API_KEY environment variable, used only in the request header (never printed/written).
Writes <out_dir>/tracks_<name>_<engine-tag>.json (stays in the research dir).
"""

import argparse
import json
import os
import re
import time
import urllib.request

MIN_TRACK_S = 5.0
COST_CAP_USD = 0.45

SYSTEM = """Você organiza gravações do acervo da UDV (União do Vegetal) em faixas para ouvir.
Recebe uma janela da transcrição automática em segmentos numerados no formato `[id] mm:ss Voz: texto`.

Regras:
1. Uma faixa de pergunta e resposta ("pergunta_resposta") é a pergunta mais a resposta inteira. Pergunta de continuação da mesma pessoa sobre o mesmo assunto fica na mesma faixa.
2. Trechos sem pergunta (fala corrida, relato, leitura, abertura, agradecimento) são faixas "exposicao". Divida uma exposição longa só quando o assunto muda claramente; prefira poucas faixas (em geral de 1 minuto ou mais) a muitas.
3. As faixas cobrem todos os segmentos da janela, em ordem, sem buracos e sem sobreposição: a primeira começa no primeiro id da janela, cada faixa começa no id seguinte ao último id da anterior, a última termina no último id da janela.
4. Cada faixa tem pelo menos 5 segundos.
5. Use só os ids dos segmentos; não escreva horários.
6. Vozes: use os rótulos exatamente como aparecem (por exemplo "Mestre José Luiz", "Voz 1"); não invente nomes. Em "exposicao", "quem_pergunta" é null e "quem_responde" é quem fala.
7. Título em português do Brasil, curto (até 60 caracteres) e específico: diga o assunto concreto (fatos, pessoas, lugares citados), sem inventar nada que não esteja no texto. Em pergunta e resposta, o título resume o tema da pergunta. A transcrição automática pode ter palavras erradas; não as copie para o título quando o sentido estiver claro. Não traduza nem "corrija" termos do acervo: União do Vegetal, UDV, vegetal, Mestre Gabriel, mestre, conselheiro, discípulo, sessão, preparo, estrela de mestre.
8. "continua_faixa_anterior" é true só na primeira faixa da janela e só quando ela continua a última faixa da janela anterior (mesmo assunto, mesma pergunta); nas outras é false.

Responda só com JSON, sem texto antes ou depois, neste formato:
{"faixas": [{"primeiro_id": 1, "ultimo_id": 12, "tipo": "pergunta_resposta", "quem_pergunta": "Voz 1", "quem_responde": "Voz 2", "titulo": "...", "continua_faixa_anterior": false}]}"""


def fmt(t: float) -> str:
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def make_windows(segs: list[dict], minutes: float) -> list[list[dict]]:
    wins: list[list[dict]] = []
    for s in segs:
        k = int(s["start"] // (minutes * 60))
        while len(wins) <= k:
            wins.append([])
        wins[k].append(s)
    return [w for w in wins if w]


def user_prompt(win: list[dict], idx: int, total: int, voices: list[str], prev: list[dict]) -> str:
    lines = [
        "Acervo: UDV.",
        "Vozes nesta gravação: " + ", ".join(voices) + ".",
    ]
    if prev:
        lines.append("Faixas da janela anterior (para dar continuidade):")
        for t in prev:
            lines.append(f"- ids {t['primeiro_id']}–{t['ultimo_id']} ({t['tipo']}): {t['titulo']}")
    else:
        lines.append("Esta é a primeira janela da gravação.")
    lines.append(f"Janela {idx + 1} de {total}, segmentos {win[0]['id']} a {win[-1]['id']}:")
    lines += [f"[{s['id']}] {fmt(s['start'])} {s['voz']}: {s['texto']}" for s in win]
    return "\n".join(lines)


def parse(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("sem JSON na resposta")
    return json.loads(text[start : end + 1])


def validate(data: dict, win: list[dict], first_window: bool) -> list[str]:
    errs = []
    by_id = {s["id"]: s for s in win}
    tracks = data.get("faixas")
    if not isinstance(tracks, list) or not tracks:
        return ["campo 'faixas' ausente ou vazio"]
    expected = win[0]["id"]
    for i, t in enumerate(tracks):
        a, b = t.get("primeiro_id"), t.get("ultimo_id")
        if not isinstance(a, int) or not isinstance(b, int) or a not in by_id or b not in by_id:
            errs.append(f"faixa {i + 1}: ids inexistentes na janela ({a}, {b})")
            continue
        if a > b:
            errs.append(f"faixa {i + 1}: primeiro_id > ultimo_id")
        if a != expected:
            errs.append(f"faixa {i + 1}: deveria começar no id {expected}, começa em {a} (buraco ou sobreposição)")
        expected = b + 1
        if t.get("tipo") not in ("pergunta_resposta", "exposicao"):
            errs.append(f"faixa {i + 1}: tipo inválido {t.get('tipo')!r}")
        if not isinstance(t.get("titulo"), str) or not t["titulo"].strip():
            errs.append(f"faixa {i + 1}: sem título")
        cont = bool(t.get("continua_faixa_anterior")) and i == 0 and not first_window
        if not cont and by_id[b]["end"] - by_id[a]["start"] < MIN_TRACK_S:
            errs.append(f"faixa {i + 1}: menos de {MIN_TRACK_S:.0f} s")
    if expected != win[-1]["id"] + 1:
        errs.append(f"a última faixa deveria terminar no id {win[-1]['id']}")
    return errs


class Local:
    def __init__(self, model: str):
        from mlx_lm import load

        t0 = time.time()
        self.model, self.tok = load(model)
        self.load_s = time.time() - t0

    def __call__(self, messages: list[dict]) -> tuple[str, dict]:
        from mlx_lm import generate
        from mlx_lm.sample_utils import make_sampler

        prompt = self.tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        n_in = len(self.tok.encode(prompt))
        text = generate(self.model, self.tok, prompt=prompt, max_tokens=3000, sampler=make_sampler(temp=0.2))
        return text, {"prompt_tokens": n_in, "completion_tokens": len(self.tok.encode(text)), "cost": 0.0}


class OpenRouter:
    load_s = 0.0

    def __init__(self, model: str):
        self.model = model

    def __call__(self, messages: list[dict]) -> tuple[str, dict]:
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": 3000,
            "response_format": {"type": "json_object"},
            "usage": {"include": True},
            "provider": {"data_collection": "deny"},
        }
        if "deepseek" in self.model:
            body["reasoning"] = {"enabled": False}
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"], "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.load(r)
        u = d.get("usage", {})
        return d["choices"][0]["message"]["content"] or "", {
            "prompt_tokens": u.get("prompt_tokens", 0),
            "completion_tokens": u.get("completion_tokens", 0),
            "cost": float(u.get("cost") or 0.0),
            "provider": d.get("provider"),
        }


def merge(all_tracks: list[dict], new: list[dict]) -> None:
    for i, t in enumerate(new):
        if i == 0 and all_tracks and t.get("continua_faixa_anterior"):
            all_tracks[-1]["ultimo_id"] = t["ultimo_id"]
            all_tracks[-1]["janelas"] += 1
        else:
            all_tracks.append({**t, "janelas": 1})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("name")
    ap.add_argument("--engine", choices=["local", "openrouter"], required=True)
    ap.add_argument("--model", default="mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit")
    ap.add_argument("--window-min", type=float, default=6.0)
    ap.add_argument("--spent", type=float, default=0.0, help="API spend so far in this test (cap guard)")
    a = ap.parse_args()
    out = os.path.expanduser(a.out_dir)
    data = json.load(open(os.path.join(out, f"segs_{a.name}.json")))
    segs = data["segments"]
    voices = sorted(set(data["labels"].values()))
    llm = Local(a.model) if a.engine == "local" else OpenRouter(a.model)
    wins = make_windows(segs, a.window_min)
    tracks: list[dict] = []
    log = []
    spent = a.spent
    t0 = time.time()
    prev: list[dict] = []
    for i, win in enumerate(wins):
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user_prompt(win, i, len(wins), voices, prev)}]
        entry = {"window": i + 1, "ids": [win[0]["id"], win[-1]["id"]], "attempts": []}
        result = None
        for attempt in range(2):
            if spent > COST_CAP_USD:
                raise SystemExit(f"cost cap reached: {spent:.4f}")
            ts = time.time()
            text, usage = llm(messages)
            spent += usage["cost"]
            try:
                parsed = parse(text)
                errs = validate(parsed, win, i == 0)
            except (ValueError, json.JSONDecodeError) as e:
                parsed, errs = None, [f"JSON inválido: {e}"]
            entry["attempts"].append({"wall_s": round(time.time() - ts, 2), **usage, "errors": errs})
            if not errs:
                result = parsed["faixas"]
                break
            messages += [
                {"role": "assistant", "content": text},
                {"role": "user", "content": "A resposta tem problemas: " + "; ".join(errs) + ". Corrija e responda de novo só com o JSON completo da janela."},
            ]
        entry["valid"] = result is not None
        entry["valid_first_try"] = entry["valid"] and len(entry["attempts"]) == 1
        log.append(entry)
        if result is None:
            prev = []
            continue
        merge(tracks, result)
        prev = result
    wall = time.time() - t0
    by_id = {s["id"]: s for s in segs}
    for t in tracks:
        t["start"], t["end"] = by_id[t["primeiro_id"]]["start"], by_id[t["ultimo_id"]]["end"]
        t["primeiras_palavras"] = " ".join(by_id[t["primeiro_id"]]["texto"].split()[:10])
    final_errs = [f"faixa {i + 1} < {MIN_TRACK_S:.0f} s" for i, t in enumerate(tracks) if t["end"] - t["start"] < MIN_TRACK_S]
    dur_h = (segs[-1]["end"]) / 3600
    usage_all = [x for e in log for x in e["attempts"]]
    summary = {
        "name": a.name,
        "engine": a.engine,
        "model": a.model,
        "windows": len(wins),
        "window_min": a.window_min,
        "valid_windows": sum(e["valid"] for e in log),
        "valid_first_try": sum(e["valid_first_try"] for e in log),
        "final_errors": final_errs,
        "tracks": len(tracks),
        "prompt_tokens": sum(x["prompt_tokens"] for x in usage_all),
        "completion_tokens": sum(x["completion_tokens"] for x in usage_all),
        "cost_usd": round(sum(x["cost"] for x in usage_all), 6),
        "model_load_s": round(llm.load_s, 1),
        "wall_s": round(wall, 1),
        "audio_h": round(dur_h, 4),
        "wall_s_per_audio_hour": round(wall / dur_h, 1),
        "cost_usd_per_audio_hour": round(sum(x["cost"] for x in usage_all) / dur_h, 5),
    }
    tag = a.engine if a.engine == "local" else a.model.split("/")[-1]
    with open(os.path.join(out, f"tracks_{a.name}_{tag}.json"), "w") as f:
        json.dump({"summary": summary, "windows": log, "tracks": tracks}, f, ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()

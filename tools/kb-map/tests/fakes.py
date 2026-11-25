"""A deterministic stand-in for the model, driven by the request payloads (recorded answers).

`Model` answers every task the way a well-behaved model would on the fixture corpus; a test
overrides one behaviour (forget sections, answer bad positions) to prove the validation.
"""

from collections.abc import Callable
from typing import Any

from kb_map.providers import Request
from kb_map.providers.fake import FakeProvider
from kb_map.textutil import fold

ENTITY_NAMES = ("Caibalion", "Hermes Trismegisto", "Mestre Laércio")
SUBJECTS = {
    "ritmo": ("Ritmo", ["lei do ritmo", "fluxo e refluxo", "pêndulo", "maré cósmica"]),
    "polaridade": ("Polaridade", ["lei da polaridade", "opostos"]),
    "vibracao": ("Vibração", ["lei da vibração", "frequência"]),
}


def subject_of(text: str) -> str | None:
    folded = fold(text)
    if "ritmo" in folded or "fluxo e refluxo" in folded or "pendulo" in folded:
        return "ritmo"
    if "polaridade" in folded or "opostos" in folded:
        return "polaridade"
    if "vibracao" in folded or "vibra" in folded:
        return "vibracao"
    return None


def _first_sentence(text: str) -> str:
    plain = text.strip().lstrip("#").strip()
    if plain.startswith("["):
        plain = plain.split("]", 1)[-1]
    if plain.startswith(" **"):
        plain = plain.split(":**", 1)[-1]
    return plain.split(".")[0].strip()


def _sentences(text: str) -> list[str]:
    first = _first_sentence(text)
    rest = text.split(".", 1)[1] if "." in text else ""
    return [first, *(part.strip() for part in rest.split(".") if part.strip())]


class Model:
    def __init__(self) -> None:
        self.section_every_anchors = 3
        self.forget_in_dossier: set[str] = set()
        self.fill_forgets = False
        self.refine_key: Callable[[str], str | None] = subject_of
        self.refine_names: dict[str, tuple[str, list[str]]] = SUBJECTS
        self.mixed_statement = True

    # ---- sections ----------------------------------------------------------------------------

    def sections(self, request: Request) -> dict[str, Any]:
        payload = request.payload
        must = set(payload["must_start_at"])
        author = payload["document"]["author"] or "Autor"
        groups: list[list[dict[str, Any]]] = []
        anchors = 0
        for block in payload["blocks"]:
            new = not groups or block["start"] in must or "heading" in block
            if block.get("at"):
                if anchors % self.section_every_anchors == 0:
                    new = True
                anchors += 1
            if new:
                groups.append([block])
            else:
                groups[-1].append(block)
        sections = []
        for group in groups:
            text = " ".join(block["text"] for block in group)
            heading = next((b["heading"] for b in group if "heading" in b), "")
            if fold(text).startswith("sumario") or fold(heading) == "sumario":
                sections.append(
                    {
                        "start": group[0]["start"],
                        "end": group[-1]["end"],
                        "status": "fora-do-mapa",
                        "reason": "sumário",
                    }
                )
                continue
            propositions = []
            for block in group:
                if "heading" in block and len(group) > 1:
                    continue
                said_by = block.get("speaker") or author
                if "o Caibalion diz" in block["text"]:
                    said_by = "O Caibalion"
                for sentence in _sentences(block["text"]):
                    propositions.append({"text": sentence, "speaker": said_by})
            sections.append(
                {
                    "start": group[0]["start"],
                    "end": group[-1]["end"],
                    "status": "ok",
                    "context": f"{payload['document']['title']}: {heading or 'trecho'}",
                    "propositions": propositions,
                    "entities": [n for n in ENTITY_NAMES if n in text],
                    "speaker": group[0].get("speaker") or author,
                }
            )
        return {"sections": sections}

    # ---- tree --------------------------------------------------------------------------------

    def assign(self, request: Request) -> dict[str, Any]:
        candidates = request.payload["subjects"]
        out = []
        for section in request.payload["sections"]:
            text = " ".join([section["context"], *section["propositions"]])
            key = subject_of(text)
            chosen = []
            for candidate in candidates:
                name = fold(candidate["id"])
                if key and (name == key or name.endswith(key)):
                    chosen.append(candidate["id"])
            if not chosen and key:
                chosen = [c["id"] for c in candidates if c["id"] == "sete-principios"]
            if chosen:
                out.append({"key": section["key"], "subjects": chosen})
            else:
                out.append(
                    {
                        "key": section["key"],
                        "subjects": [],
                        "closest": candidates[0]["id"],
                        "proposal": {
                            "name": "Culinária",
                            "description": "Receitas",
                            "criterion": "",
                            "synonyms": [],
                        },
                    }
                )
        return {"assignments": out}

    def refine(self, request: Request) -> dict[str, Any]:
        groups: dict[str, list[str]] = {}
        for section in request.payload["sections"]:
            text = " ".join([section["context"], *section["propositions"]])
            key = self.refine_key(text)
            if key:
                groups.setdefault(key, []).append(section["key"])
        children = []
        for key, keys in groups.items():
            name, synonyms = self.refine_names[key]
            children.append(
                {
                    "name": name,
                    "description": f"O princípio: {name}",
                    "criterion": f"Trata de {name}",
                    "synonyms": synonyms,
                    "sections": keys,
                }
            )
        return {"children": children}

    # ---- dossiers ----------------------------------------------------------------------------

    def dossier(self, request: Request) -> dict[str, Any]:
        sections = [
            s for s in request.payload["sections"] if s["key"] not in self.forget_in_dossier
        ]
        statements = [{"text": s["propositions"][0], "cites": [s["key"]]} for s in sections]
        main = [s["key"] for s in sections if s["group"] == "mestre-laercio"]
        others = [s["key"] for s in sections if s["group"] != "mestre-laercio"]
        if self.mixed_statement and main and others:
            statements.append({"text": "Todos concordam.", "cites": [main[0], others[0]]})
        return {
            "aspects": [
                {
                    "name": "Definição",
                    "sections": [s["key"] for s in sections],
                    "central": [s["key"] for s in sections[:1]],
                    "statements": statements,
                }
            ],
            "agreements": (
                [{"text": "Ambos ligam o tema ao todo.", "cites": [main[0], others[0]]}]
                if main and others
                else []
            ),
            "divergences": [],
        }

    def dossier_fill(self, request: Request) -> dict[str, Any]:
        if self.fill_forgets:
            return {"placements": [], "statements": []}
        return {
            "placements": [
                {"key": s["key"], "aspect": "Outros aspectos"} for s in request.payload["sections"]
            ],
            "statements": [
                {"aspect": "Outros aspectos", "text": s["propositions"][0], "cites": [s["key"]]}
                for s in request.payload["sections"]
            ],
        }

    def provider(self, usd_per_call: float = 0.0) -> FakeProvider:
        return FakeProvider(
            {
                "sections": self.sections,
                "assign": self.assign,
                "refine": self.refine,
                "dossier": self.dossier,
                "dossier-fill": self.dossier_fill,
            },
            usd_per_call=usd_per_call,
        )

"""A short description of an image by a cheap vision model on OpenRouter (BR-4: marked).

The model is `kb.toml` `[vision] model` when set, else `--vision-model`, else the default
below (a cheap multimodal model). The key is the same OpenRouter key the map uses, read from
the environment or the Keychain, only ever in the request header. Every call goes through the
run's ledger, so `--max-usd` caps descriptions as it caps the map.
"""

import base64
import json
import mimetypes
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..providers import BudgetExceeded, Ledger
from ..providers.openrouter import ENDPOINT
from .converters import ConversionFailed

DEFAULT_VISION_MODEL = "google/gemini-2.5-flash-lite"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
TIMEOUT_S = 120
PROMPT = (
    "Descreva esta imagem em português do Brasil, em até 120 palavras, para um acervo de "
    "estudos esotéricos: o que ela mostra (diagrama, tabela, mandala, foto, página), os "
    "elementos e rótulos visíveis e como se relacionam. Não interprete além do que se vê."
)

Opener = Callable[[urllib.request.Request, float], Any]


def _open(request: urllib.request.Request, timeout: float) -> Any:
    return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 (fixed https URL)


def vision_model(kb_config: dict[str, Any], given: str | None) -> str:
    if given:
        return given
    vision = kb_config.get("vision", {}) if isinstance(kb_config, dict) else {}
    model = vision.get("model") if isinstance(vision, dict) else None
    return str(model) if model else DEFAULT_VISION_MODEL


@dataclass
class VisionDescriber:
    model: str
    key: Callable[[], str]
    ledger: Ledger | None = None
    opener: Opener = _open

    def __call__(self, path: Path) -> tuple[str, float]:
        ledger = self.ledger
        ceiling = ledger.max_usd if ledger is not None else None
        if ledger is not None and ceiling is not None and ledger.spent_usd >= ceiling:
            raise BudgetExceeded(
                f"budget reached before describing {path.name}: run again to resume"
            )
        data = path.read_bytes()
        if len(data) > MAX_IMAGE_BYTES:
            raise ConversionFailed(f"{path.name} is too large to describe")
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        image = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
        body = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": PROMPT},
                        {"type": "image_url", "image_url": {"url": image}},
                    ],
                }
            ],
            "max_tokens": 400,
            "temperature": 0,
            "usage": {"include": True},
        }
        request = urllib.request.Request(  # noqa: S310 (fixed https URL)
            ENDPOINT, data=json.dumps(body).encode("utf-8"), method="POST"
        )
        request.add_header("Content-Type", "application/json")
        request.add_header("Authorization", f"Bearer {self.key()}")
        request.add_header("X-Title", "kb-map")
        try:
            with self.opener(request, TIMEOUT_S) as response:
                answer = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raise ConversionFailed(f"the vision model answered HTTP {err.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as err:
            raise ConversionFailed(f"the vision model failed: {type(err).__name__}") from None
        try:
            text = str(answer["choices"][0]["message"]["content"] or "")
        except (KeyError, IndexError, TypeError):
            raise ConversionFailed("the vision model answered without a message") from None
        usd = float((answer.get("usage") or {}).get("cost") or 0.0)
        if self.ledger is not None:
            self.ledger.spent_usd += max(usd, 0.0)
            self.ledger.calls += 1
            self.ledger.models.add(str(answer.get("model") or self.model))
        return text.strip(), usd

"""The real converters and kb, built from the vault; tests replace both hooks below."""

import argparse
import shutil
from collections.abc import Callable

from ..providers import Ledger
from ..providers.keys import openrouter_key
from ..vault import Vault
from .converters import (
    ConverterSet,
    DataPage,
    DoclingConverter,
    ImageConverter,
    MarkItDownConverter,
    PlainText,
)
from .ingest import KbIngestCli, KbIngestPort
from .vision import VisionDescriber, vision_model
from .web import FirecrawlConverter, JinaConverter

# Tests (and other tools) set these to hand every command scripted converters and a fake kb.
converter_factory: Callable[[argparse.Namespace, Vault, Ledger], ConverterSet] | None = None
ingest_factory: Callable[[argparse.Namespace, Vault], KbIngestPort] | None = None


class KbMissing(Exception):
    """kb is not on PATH: convert hands every document to `kb ingest`."""


def build_converters(args: argparse.Namespace, vault: Vault, ledger: Ledger) -> ConverterSet:
    if converter_factory is not None:
        return converter_factory(args, vault, ledger)
    docling = DoclingConverter()
    describe = None
    if not getattr(args, "no_describe", False):
        model = vision_model(vault.kb_config(), getattr(args, "vision_model", None))
        describe = VisionDescriber(model=model, key=openrouter_key, ledger=ledger)
    return ConverterSet(
        pdf=docling,
        image=ImageConverter(ocr=docling, describe=describe),
        office=MarkItDownConverter(),
        data=DataPage(),
        text=PlainText(),
        links=(FirecrawlConverter(), JinaConverter()),
    )


def build_ingest(args: argparse.Namespace, vault: Vault) -> KbIngestPort:
    if ingest_factory is not None:
        return ingest_factory(args, vault)
    binary = shutil.which("kb")
    if not binary:
        raise KbMissing("kb is not on PATH: install it, or run convert on the owner's Mac")
    return KbIngestCli(vault.root, binary)

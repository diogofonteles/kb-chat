"""`kb-map convert <topic> <file|url>...`: a source into the topic, original kept (KBC-148 FR-1).

Each source is converted (Docling, MarkItDown, Firecrawl/Jina, or kept as it is), its original
stored in `raw/_originals/<sha256>.<ext>`, the Markdown handed to `kb ingest file`, and the
provenance keys added to the document kb wrote. `--json` prints one JSON object per source
(the Mac's doc-ingest job reads it). Exit 0 when every source ended converted or duplicate,
1 when one failed or went to review, 3 when the budget stopped the run.
"""

import argparse
import json

from ..convert.factory import build_converters, build_ingest
from ..convert.pipeline import Converting, Naming, Outcome
from ..convert.sources import UnsupportedSource, source_of
from ..log import append_log
from ..providers import BudgetExceeded, Ledger
from ._common import add_topic, open_topic

NAME = "convert"
HELP = "convert files or links into a topic: structured Markdown, original kept, kb ingest"
OK_STATES = ("converted", "duplicate")


def add_conversion_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--max-usd",
        type=float,
        default=None,
        help="hard budget in US$ for image descriptions (the only paid step)",
    )
    parser.add_argument("--vision-model", help="the image description model (OpenRouter)")
    parser.add_argument(
        "--no-describe", action="store_true", help="images: OCR only, no generated description"
    )


def register(sub) -> None:
    parser = sub.add_parser(NAME, help=HELP, description=HELP)
    add_topic(parser)
    parser.add_argument("sources", nargs="+", metavar="file|url")
    parser.add_argument("--name", help="the file's name as sent (an upload's), one source only")
    parser.add_argument("--title", help="the document's title (default: the file's or page's)")
    parser.add_argument("--origin", help="author or origin, the first part of the name")
    parser.add_argument("--year", help="the year, the last part of the name")
    parser.add_argument("--source-path", help="where the original came from (default: its path)")
    parser.add_argument("--budget", type=float, default=None, help="kb ingest's own --budget (US$)")
    parser.add_argument("--json", action="store_true", help="one JSON object per source")
    add_conversion_options(parser)
    parser.set_defaults(run=run)


def run(args: argparse.Namespace) -> int:
    if args.name and len(args.sources) != 1:
        raise SystemExit("kb-map: --name names one source only")
    ctx = open_topic(args)
    ledger = Ledger(_NoModel(), max_usd=args.max_usd)
    converting = Converting(
        vault=ctx.vault,
        topic=ctx.topic,
        converters=build_converters(args, ctx.vault, ledger),
        ingest=build_ingest(args, ctx.vault),
        queue=ctx.queue,
        budget_usd=args.budget,
    )
    naming = Naming(args.title, args.origin, args.year, args.source_path)
    outcomes: list[Outcome] = []
    stopped: BudgetExceeded | None = None
    try:
        for given in args.sources:
            try:
                source = source_of(given, args.name)
            except UnsupportedSource as err:
                outcomes.append(Outcome("failed", given, detail=str(err)))
            else:
                outcomes.append(converting.convert(source, naming))
            _print(outcomes[-1], args.json)
    except BudgetExceeded as err:
        stopped = err
    finally:
        ctx.queue.save()
    _log(ctx, outcomes, ledger)
    if stopped:
        raise stopped
    return 0 if all(outcome.state in OK_STATES for outcome in outcomes) else 1


def _print(outcome: Outcome, as_json: bool) -> None:
    if as_json:
        print(json.dumps(outcome.as_json(), ensure_ascii=False), flush=True)
        return
    target = f" -> {outcome.doc}" if outcome.doc else ""
    detail = f" ({outcome.detail})" if outcome.detail else ""
    print(f"{outcome.state:10} {outcome.source}{target}{detail}", flush=True)


def _log(ctx, outcomes: list[Outcome], ledger: Ledger) -> None:
    done = [outcome for outcome in outcomes if outcome.state in ("converted", "review")]
    if not done:
        return
    lines = "\n".join(f"- {o.doc} ({o.state}) from {o.source}" for o in done)
    append_log(ctx.layout, "convert", f"kb-map convert: {len(done)} documents", lines)


class _NoModel:
    """The ledger's provider slot: conversion asks no text model, only the vision describer."""

    name = "vision"

    def ask(self, request):  # pragma: no cover - never called
        raise AssertionError("convert asks no text model")

"""`kb-map sections <topic>`: each source cut into sections with propositions (KBC-139)."""

import argparse
import json

from ..extract import DocOutcome, extract_document
from ..log import append_log
from ..providers import BudgetExceeded
from ._common import add_provider, add_topic, make_ledger, open_topic

NAME = "sections"
HELP = "cut sources into sections with context, propositions, entities and speaker"


def register(sub) -> None:
    parser = sub.add_parser(NAME, help=HELP, description=HELP)
    add_topic(parser)
    parser.add_argument("--doc", action="append", default=[], help="only this source (repeatable)")
    parser.add_argument("--force", action="store_true", help="extract again even when unchanged")
    add_provider(parser)
    parser.set_defaults(run=run)


def run(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    ledger = make_ledger(args, ctx.vault)
    docs = [ctx.topic.doc_id_of(doc) for doc in args.doc] if args.doc else ctx.topic.documents()
    outcomes: list[DocOutcome] = []
    stopped: BudgetExceeded | None = None
    try:
        for doc in docs:
            outcome = extract_document(ctx.topic, ledger, ctx.queue, doc, force=args.force)
            outcomes.append(outcome)
            detail = f" ({outcome.detail})" if outcome.detail else ""
            print(f"{outcome.state:9} {doc}{detail}")
    except BudgetExceeded as err:
        stopped = err
    finally:
        ctx.queue.save()
    counts = {
        state: sum(1 for o in outcomes if o.state == state)
        for state in ("written", "unchanged", "review", "empty")
    }
    summary = ", ".join(f"{n} {state}" for state, n in counts.items() if n) or "nothing to do"
    left = len(docs) - len(outcomes)
    if left:
        summary += f", {left} left for the next run"
    if counts["written"] or counts["review"] or stopped:
        append_log(ctx.layout, "map", f"kb-map sections: {summary}", ledger.summary())
    print(f"kb-map sections: {summary} · {ledger.summary()}")
    print(json.dumps({"spentUsd": round(ledger.spent_usd, 6)}), flush=True)
    if stopped:
        raise stopped
    return 0

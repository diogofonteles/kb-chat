"""`kb-map reconvert <topic>`: the collection's plain texts again from their originals (FR-2).

For each source converted outside the app (`source_path` → `_convert/ready/…/<file>.pdf.txt`),
the original is found by its path and then by its name in the folders it came from (`--from`,
default `<vault>/_extract`), converted, compared with the text it would replace (BR-3: at
least 80 % of the useful characters, else nothing changes and the case goes to review), and
the body is swapped. The document's id, kb's keys, the owner's keys and `source_path` stay;
only the body and the provenance keys change (BR-2). kb reclassifies what changed on its next
`kb classify`.

Resumable by construction: a document converted by the current converter version is
"current" and skipped, one in review with the same body waits for `--retry`, and each
document is written atomically, so a stopped run (Ctrl-C, `--limit`, `--max-usd`) just runs
again. `--dry-run` converts nothing and lists what would change.
"""

import argparse
from collections import Counter
from pathlib import Path

from ..convert.factory import build_converters
from ..convert.pipeline import OriginalFinder, Outcome, Reconverting
from ..log import append_log
from ..providers import BudgetExceeded, Ledger
from ._common import add_topic, open_topic
from .convert import _NoModel, add_conversion_options

NAME = "reconvert"
HELP = "reconvert the topic's plain-text sources from their originals (resumable, --dry-run)"
DEFAULT_FROM = "_extract"


def register(sub) -> None:
    parser = sub.add_parser(NAME, help=HELP, description=HELP)
    add_topic(parser)
    parser.add_argument(
        "--from",
        dest="from_dirs",
        action="append",
        default=[],
        help=f"a folder with originals (repeatable; default <vault>/{DEFAULT_FROM})",
    )
    parser.add_argument("--doc", action="append", default=[], help="only this source")
    parser.add_argument("--limit", type=int, default=None, help="convert at most this many")
    parser.add_argument("--dry-run", action="store_true", help="list what would change")
    parser.add_argument("--retry", action="store_true", help="try again the cases in review")
    add_conversion_options(parser)
    parser.set_defaults(run=run)


def run(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    dirs = [Path(one).expanduser() for one in args.from_dirs] or [ctx.vault.root / DEFAULT_FROM]
    dirs = [one if one.is_absolute() else ctx.vault.root / one for one in dirs]
    ledger = Ledger(_NoModel(), max_usd=args.max_usd)
    reconverting = Reconverting(
        vault=ctx.vault,
        topic=ctx.topic,
        converters=build_converters(args, ctx.vault, ledger),
        finder=OriginalFinder(ctx.vault, dirs),
        queue=ctx.queue,
        retry=args.retry,
    )
    docs = [ctx.topic.doc_id_of(doc) for doc in args.doc] if args.doc else ctx.topic.documents()
    counts: Counter[str] = Counter()
    replaced: list[Outcome] = []
    converted = 0
    stopped: BudgetExceeded | None = None
    try:
        for doc_id in docs:
            if not reconverting.candidate(doc_id):
                continue
            state, original, detail = reconverting.plan(doc_id)
            if state != "convert" or args.dry_run:
                shown = "would-convert" if state == "convert" else state
                counts[shown] += 1
                if state not in ("skip", "current"):
                    _print(shown, doc_id, original, detail)
                continue
            if args.limit is not None and converted >= args.limit:
                counts["left"] += 1
                continue
            if original is None:  # plan() gives "convert" only with an original
                continue
            outcome = reconverting.reconvert(doc_id, original)
            converted += 1
            counts[outcome.state] += 1
            _print(outcome.state, doc_id, original, outcome.detail)
            if outcome.state == "replaced":
                replaced.append(outcome)
    except BudgetExceeded as err:
        stopped = err
    finally:
        ctx.queue.save()
    summary = ", ".join(f"{n} {state}" for state, n in sorted(counts.items())) or "nothing to do"
    if replaced:
        lines = "\n".join(f"- {o.doc} from {o.original} ({o.detail})" for o in replaced)
        append_log(ctx.layout, "convert", f"kb-map reconvert: {summary}", lines)
    prefix = "kb-map reconvert (dry run)" if args.dry_run else "kb-map reconvert"
    print(f"{prefix}: {summary}")
    if replaced:
        print(f"next: kb classify {ctx.topic.slug} (kb judges the changed bodies again)")
    if stopped:
        raise stopped
    return 0


def _print(state: str, doc_id: str, original: Path | None, detail: str) -> None:
    where = f" <- {original}" if original else ""
    extra = f" ({detail})" if detail else ""
    print(f"{state:14} {doc_id}{where}{extra}", flush=True)

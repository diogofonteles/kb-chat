"""`kb-map dossier <topic>`: dossiers as wiki articles, entity pages, affects, index (KBC-141)."""

import argparse

from ..dossier import compile_dossiers
from ..entities import MIN_MENTIONS, compile_entities, write_affects
from ..index_md import write_index
from ..log import append_log
from ..providers import BudgetExceeded
from ..sectionsdb import load_sections
from ..titles import page_titles
from ..tree import Tree
from ._common import add_provider, add_topic, make_ledger, open_topic

NAME = "dossier"
HELP = "compile each node's dossier into its wiki article, plus entity pages and the index"


def register(sub) -> None:
    parser = sub.add_parser(NAME, help=HELP, description=HELP)
    add_topic(parser)
    parser.add_argument("--node", help="only this node id")
    parser.add_argument("--force", action="store_true", help="compile again even when current")
    parser.add_argument(
        "--min-mentions", type=int, default=MIN_MENTIONS, help="sections for an entity page"
    )
    add_provider(parser)
    parser.set_defaults(run=run)


def run(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    tree = Tree.load(ctx.layout)
    if not tree.nodes:
        print("kb-map: no tree yet: run `kb-map tree build` first")
        return 1
    if args.node and args.node not in tree.nodes:
        print(f"kb-map: no node {args.node!r}")
        return 1
    ledger = make_ledger(args, ctx.vault)
    try:
        report = compile_dossiers(ctx.layout, ledger, ctx.queue, args.node, args.force)
    except BudgetExceeded:
        ctx.queue.save()
        raise
    refs = load_sections(ctx.layout)
    titles = page_titles(ctx.layout, tree)
    pages, entities = compile_entities(ctx.layout, refs, tree, titles, args.min_mentions)
    write_affects(ctx.layout, refs, titles, entities)
    ctx.queue.save()
    write_index(ctx.layout, tree, titles, refs, ctx.queue)
    all_pages = report.pages + pages
    refused = [p for p in all_pages if p.state == "refused"]
    for page in refused:
        print(f"refused  {page.path.relative_to(ctx.topic.dir)} ({page.reason})")
    for node_id in report.review:
        print(f"review   {node_id} (see map/review-queue.json)")
    changed = sum(1 for p in all_pages if p.state in ("created", "updated"))
    summary = (
        f"{len(report.written)} dossiers compiled, {len(report.unchanged)} current, "
        f"{len(report.review)} to review, {changed} pages written, {len(refused)} refused"
    )
    append_log(ctx.layout, "compile", f"kb-map dossier: {summary}", ledger.summary())
    print(f"kb-map dossier: {summary} · {ledger.summary()}")
    return 1 if report.review or refused else 0

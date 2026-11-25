"""`kb-map tree build|review|apply <topic>`: the subject tree and the owner's review (KBC-140)."""

import argparse
from pathlib import Path

import yaml

from ..index_md import write_index
from ..log import append_log
from ..providers import BudgetExceeded
from ..sectionsdb import load_sections
from ..titles import page_titles
from ..tree import MAX_SIZE, MIN_SIZE, Tree, TreeBuilder, apply_corrections
from ..tree_review import write_review
from ._common import Context, add_provider, add_topic, make_ledger, open_topic

NAME = "tree"
HELP = "build the subject tree, write the owner's review file, apply the owner's corrections"


def register(sub) -> None:
    parser = sub.add_parser(NAME, help=HELP, description=HELP)
    actions = parser.add_subparsers(dest="action", required=True, metavar="<action>")
    build = actions.add_parser("build", help="group the sections into the tree and place them")
    add_topic(build)
    build.add_argument("--min-size", type=int, default=MIN_SIZE, help="fewest sections per node")
    build.add_argument("--max-size", type=int, default=MAX_SIZE, help="most sections per node")
    build.add_argument("--seed", type=int, default=0, help="seed for sampling large nodes")
    add_provider(build)
    build.set_defaults(run=run_build)
    review = actions.add_parser("review", help="write map/tree-review.md for the owner")
    add_topic(review)
    review.set_defaults(run=run_review)
    apply = actions.add_parser("apply", help="apply a corrections file and fix it for rebuilds")
    add_topic(apply)
    apply.add_argument("corrections", type=Path, help="YAML (or JSON) list of corrections")
    apply.set_defaults(run=run_apply)


def _refresh(ctx: Context) -> None:
    tree = Tree.load(ctx.layout)
    write_review(ctx.layout, tree, ctx.queue)
    write_index(
        ctx.layout, tree, page_titles(ctx.layout, tree), load_sections(ctx.layout), ctx.queue
    )


def run_build(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    ledger = make_ledger(args, ctx.vault)
    builder = TreeBuilder(
        ctx.topic,
        ledger,
        ctx.queue,
        min_size=args.min_size,
        max_size=args.max_size,
        seed=args.seed,
    )
    try:
        report = builder.build()
    except BudgetExceeded:
        ctx.queue.save()
        raise
    ctx.queue.save()
    _refresh(ctx)
    summary = (
        f"{report.nodes} nodes, {report.sections} sections ({report.assigned_now} placed now), "
        f"{report.review} to review, {len(report.unplaced)} unplaced, "
        f"{report.splits} splits, {report.merges} merges"
    )
    append_log(ctx.layout, "map", f"kb-map tree build: {summary}", ledger.summary())
    print(f"kb-map tree build: {summary} · {ledger.summary()}")
    print(f"review: {ctx.layout.tree_review_file}")
    return 0


def run_review(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    _refresh(ctx)
    print(ctx.layout.tree_review_file)
    return 0


def run_apply(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    try:
        corrections = yaml.safe_load(args.corrections.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as err:
        print(f"kb-map: cannot read {args.corrections}: {err}")
        return 1
    if not isinstance(corrections, list):
        print("kb-map: the corrections file must be a list")
        return 1
    done, refused = apply_corrections(ctx.topic, corrections)
    _refresh(ctx)
    for line in done:
        print(f"done     {line}")
    for line in refused:
        print(f"refused  {line}")
    if done:
        append_log(
            ctx.layout,
            "map",
            f"kb-map tree apply: {len(done)} owner corrections",
            "\n".join(f"- {d}" for d in done),
        )
    return 1 if refused else 0

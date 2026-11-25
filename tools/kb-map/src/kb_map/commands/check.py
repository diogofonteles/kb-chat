"""`kb-map check <topic>`: the map is complete and current, or exit 1 naming each problem."""

import argparse

from ..check import run_check
from ._common import add_topic, open_topic

NAME = "check"
HELP = "prove the map complete and current (no model call); exit 1 listing each problem"


def register(sub) -> None:
    parser = sub.add_parser(NAME, help=HELP, description=HELP)
    add_topic(parser)
    parser.add_argument(
        "--allow-pending", action="store_true", help="do not fail on sources with no sections yet"
    )
    parser.set_defaults(run=run)


def run(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    if not ctx.layout.has_map():
        print(f"kb-map check: {ctx.topic.slug} has no map")
        return 0
    problems = run_check(ctx.topic, allow_pending=args.allow_pending)
    for problem in problems:
        print(problem)
    print(f"kb-map check: {ctx.topic.slug}: {len(problems)} problems")
    return 1 if problems else 0

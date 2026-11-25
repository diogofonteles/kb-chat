"""`kb-map paths <topic>`: the topic-relative paths kb-map owns, one per line.

`deploy/scripts/sync-vault.sh` holds exactly these back when `kb-map check` fails, so the map
in production stays the previous one while the rest of the vault is sent.
"""

import argparse

from ._common import add_topic, open_topic

NAME = "paths"
HELP = "list the topic-relative paths kb-map owns (map/, index.md, generated wiki pages)"


def register(sub) -> None:
    parser = sub.add_parser(NAME, help=HELP, description=HELP)
    add_topic(parser)
    parser.set_defaults(run=run)


def run(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    for path in ctx.layout.owned_paths():
        print(path)
    return 0

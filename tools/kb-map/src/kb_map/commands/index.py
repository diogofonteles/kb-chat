"""`kb-map index <topic>`: regenerate the topic's index.md from the tree."""

import argparse

from ..index_md import write_index
from ..sectionsdb import load_sections
from ..titles import page_titles
from ..tree import Tree
from ._common import add_topic, open_topic

NAME = "index"
HELP = "regenerate <topic>/index.md, the catalog of the compiled wiki"


def register(sub) -> None:
    parser = sub.add_parser(NAME, help=HELP, description=HELP)
    add_topic(parser)
    parser.set_defaults(run=run)


def run(args: argparse.Namespace) -> int:
    ctx = open_topic(args)
    tree = Tree.load(ctx.layout)
    page = write_index(
        ctx.layout, tree, page_titles(ctx.layout, tree), load_sections(ctx.layout), ctx.queue
    )
    print(f"{page.state} {page.path}" + (f" ({page.reason})" if page.reason else ""))
    return 1 if page.state == "refused" else 0

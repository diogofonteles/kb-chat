"""`kb-map <command> ...`: every subcommand is a module of `kb_map.commands` (see there)."""

import argparse
import sys
from collections.abc import Sequence

from . import __version__
from .commands import register_all
from .convert.factory import KbMissing
from .providers import BudgetExceeded, ProviderError
from .providers.keys import KeyMissing
from .vault import VaultError

EXIT_FAILED = 1
EXIT_BUDGET = 3


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="kb-map",
        description="The collection map: sections, subject tree and compiled wiki (ADR 0039).",
    )
    root.add_argument("--version", action="version", version=f"kb-map {__version__}")
    root.add_argument(
        "--vault",
        help="vault root with kb.toml (default: KB_VAULT, else the nearest kb.toml above)",
    )
    sub = root.add_subparsers(dest="command", required=True, metavar="<command>")
    register_all(sub)
    return root


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return int(args.run(args) or 0)
    except BudgetExceeded as err:
        print(f"kb-map: {err}", file=sys.stderr)
        return EXIT_BUDGET
    except (VaultError, ProviderError, KeyMissing, KbMissing) as err:
        print(f"kb-map: {err}", file=sys.stderr)
        return EXIT_FAILED

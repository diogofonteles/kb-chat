"""The subcommands, one module each, found here and registered in one place: `register_all`.

To add a subcommand (`convert`, `update`, `lint`, ...), add `commands/<name>.py` with:

    NAME = "<name>"            # the word after `kb-map`
    HELP = "<one line>"

    def register(sub) -> None:  # sub: the argparse subparsers object
        parser = sub.add_parser(NAME, help=HELP)
        ...                     # helpers for --provider/--max-usd/topic in `_common`
        parser.set_defaults(run=run)

    def run(args) -> int: ...   # exit code; raise BudgetExceeded/VaultError freely

Nothing else changes: modules are discovered by name (those starting with `_` are helpers), so
parallel work on different subcommands never touches a shared file.
"""

import argparse
import importlib
import pkgutil


def register_all(sub: "argparse._SubParsersAction[argparse.ArgumentParser]") -> list[str]:
    names = []
    for module in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
        if module.name.startswith("_"):
            continue
        command = importlib.import_module(f"{__name__}.{module.name}")
        command.register(sub)
        names.append(command.NAME)
    return names

"""Arguments and setup shared by subcommands: the topic, the provider and the budget."""

import argparse
from collections.abc import Callable
from dataclasses import dataclass

from ..layout import MapLayout, ReviewQueue
from ..providers import DEFAULT_PROVIDER, PROVIDER_NAMES, Ledger, Provider, build_provider
from ..vault import Topic, Vault

# Tests (and other tools) replace this to hand every command a scripted provider.
provider_factory: Callable[[argparse.Namespace, Vault], Provider] | None = None


def add_topic(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("topic", help="topic slug (a folder of the vault with topic.yaml)")


def add_provider(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--provider",
        choices=PROVIDER_NAMES,
        default=DEFAULT_PROVIDER,
        help="openrouter (kb.toml [generation] model and fallback, the default), claude or codex",
    )
    parser.add_argument("--model", help="override the provider's model")
    parser.add_argument(
        "--max-usd",
        type=float,
        default=None,
        help="hard budget for this run in US$: the run stops before a call that would pass it",
    )


@dataclass
class Context:
    vault: Vault
    topic: Topic
    layout: MapLayout
    queue: ReviewQueue


def open_topic(args: argparse.Namespace) -> Context:
    vault = Vault.locate(args.vault)
    topic = vault.topic(args.topic)
    layout = MapLayout(topic)
    return Context(vault, topic, layout, ReviewQueue(layout))


def make_ledger(args: argparse.Namespace, vault: Vault) -> Ledger:
    if provider_factory is not None:
        provider = provider_factory(args, vault)
    else:
        provider = build_provider(args.provider, vault.kb_config(), args.model)
    if args.max_usd is not None and args.max_usd < 0:
        raise SystemExit("kb-map: --max-usd must be zero or more")
    return Ledger(provider, max_usd=args.max_usd)

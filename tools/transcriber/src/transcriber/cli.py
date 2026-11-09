"""`transcriber pair` stores the token; `transcriber run` runs the worker loop."""

import argparse
import getpass
import json
import logging
import os
import signal
import socket
import sys
import threading
from pathlib import Path

from .secret import CachedToken, TokenError, load_token, save_keychain

CONFIG_FILE = (
    Path.home() / "Library" / "Application Support" / "nova-alexandria-transcriber" / "config.json"
)
# What the automatic sync left pending, and when it last ran (KBC-100 FR-4).
SYNC_STATE_FILE = CONFIG_FILE.parent / "vault-sync.json"
# This checkout's sync script (tools/transcriber/src/transcriber → the repository's root).
SYNC_SCRIPT = Path(__file__).resolve().parents[4] / "deploy" / "scripts" / "sync-vault.sh"


def load_config(path: Path = CONFIG_FILE) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def save_config(config: dict, path: Path = CONFIG_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def pair(args: argparse.Namespace) -> int:
    from .api import check_api_url

    try:
        api_url = check_api_url(args.api_url)
    except ValueError as err:
        print(str(err), file=sys.stderr)
        return 2
    token = getpass.getpass("Cole o token: ").strip()
    if len(token) < 32:
        print("Esse não parece o token mostrado na tela Transcritores.", file=sys.stderr)
        return 1
    try:
        save_keychain(token)
    except TokenError as err:
        print(str(err), file=sys.stderr)
        return 1
    saved = {"api_url": api_url, "name": args.name or socket.gethostname()}
    if args.vault:
        saved["vault_path"] = str(Path(args.vault).expanduser())
    if args.sync_host:
        saved["sync_host"] = args.sync_host
    save_config(saved)
    print("Pareado. Rode `uv run --project tools/transcriber transcriber run` ou carregue o plist.")
    return 0


def run(args: argparse.Namespace) -> int:
    from .api import ApiClient
    from .audio import decode_pcm16k, ffmpeg_bin
    from .diarize import senko_or_none
    from .status import StatusReporter, WorkerStatus
    from .vad import silero_speech
    from .voiceprint import ecapa_or_none
    from .worker import Worker

    config = load_config()
    api_url = os.environ.get("KB_CHAT_API_URL") or config.get("api_url")
    name = os.environ.get("KB_CHAT_TRANSCRIBER_NAME") or config.get("name") or socket.gethostname()
    if not api_url:
        print(
            "Sem endereço da API: pareie com `transcriber pair --api-url <url>`.", file=sys.stderr
        )
        return 2
    try:
        api = ApiClient(api_url, CachedToken(load_token), name[:100])
        load_token()
        ffmpeg_bin()
    except (TokenError, RuntimeError, ValueError) as err:
        print(str(err), file=sys.stderr)
        return 2
    vault = os.environ.get("KB_CHAT_VAULT") or config.get("vault_path")
    publisher = publisher_of(args, vault)
    kb = publisher.kb if publisher else None
    model, count = _mlx()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    worker = Worker(
        api=api,
        model=model,
        find_speech=silero_speech,
        decode=decode_pcm16k,
        stop=stop,
        count_tokens=count,
        # KBC-064: separates voices too when the `diarize` extra (Senko) is installed and
        # not turned off; the API still gives it a separation only if marked in Transcritores.
        diarizer=None if args.no_diarize else senko_or_none(),
        # KBC-071: only with the `voiceprint` extra; the API gives prints only to a token
        # marked for them, and nothing is marked by default (ADR 0032).
        embedder=None if args.no_voice_profiles else ecapa_or_none(),
        # KBC-099: with a vault and kb on this Mac; the API gives track documents only to a
        # transcriber marked "Publica no acervo" in Transcritores, and kb spends on its key.
        publisher=publisher,
        # KBC-114: what this Mac is doing, shown to masters in the app.
        status=WorkerStatus(
            vault_path=str(publisher.vault) if publisher else None,
            kb_version=getattr(publisher.kb, "version", lambda: None)() if publisher else None,
        ),
        reporter=StatusReporter(api),
    )
    if args.poll:
        worker.poll_s = args.poll
    worker.sync = vault_sync_of(args, config, kb)
    return worker.run(once=args.once, exit_when_idle=args.exit_when_idle)


def publisher_of(args: argparse.Namespace, vault: str | None):
    """Publishing is on by default (KBC-114 BR-7): a vault and kb on PATH are enough, with no
    mark on this Mac; `--no-kb-publish` keeps it out. The API still gives kb-publish jobs only
    to a transcriber marked "Publica no acervo", which a new pairing is by default."""
    from .kb_publish import KbPublisher, kb_or_none

    kb = None if args.no_kb_publish else kb_or_none(vault)
    return KbPublisher(kb.vault, kb) if kb else None


def vault_sync_of(args: argparse.Namespace, config: dict, kb, state_file: Path = SYNC_STATE_FILE):
    """The automatic sync with production (KBC-100 FR-4): only with kb and a host to send to."""
    from .vault_sync import VaultSync

    host = args.sync_host or os.environ.get("KB_CHAT_SYNC_HOST") or config.get("sync_host")
    if kb is None or not host or args.no_sync:
        return None
    script = Path(args.sync_script).expanduser() if args.sync_script else SYNC_SCRIPT
    sync = VaultSync(script=script, host=host, vault=kb.vault, state_file=state_file)
    # What a previous run published and did not send is still pending; a restart alone is not.
    sync.load()
    return sync


def service_of(**kwargs):
    """This Mac's LaunchAgent, with the real launchctl (KBC-114)."""
    from .service import LaunchctlCli, Service

    return Service(home=Path.home(), uid=os.getuid(), launchctl=LaunchctlCli(), **kwargs)


def service(args: argparse.Namespace) -> int:
    """`transcriber service install|uninstall|status`: the worker kept on by launchd."""
    from .service import ServiceError, describe

    agent = service_of()
    try:
        if args.action == "install":
            config = load_config(CONFIG_FILE)
            vault = args.vault or os.environ.get("KB_CHAT_VAULT") or config.get("vault_path")
            if vault:
                vault = str(Path(vault).expanduser())
            if args.vault:
                save_config({**config, "vault_path": vault}, CONFIG_FILE)
            extras = args.extra if args.extra is not None else ["diarize"]
            path = agent.install(vault=vault, extras=extras, load=not args.no_load)
            print(f"Serviço instalado: {path}")
            if not vault:
                print("Sem vault: este Mac não publica no acervo (use --vault).")
        elif args.action == "uninstall":
            agent.uninstall()
            print("Serviço removido.")
        else:
            print("\n".join(describe(agent.status())))
    except ServiceError as err:
        print(str(err), file=sys.stderr)
        return 1
    return 0


def _mlx():
    """mlx-whisper and its tokenizer (Apple silicon only)."""
    try:
        import mlx_whisper
        from mlx_whisper.tokenizer import get_tokenizer
    except ImportError as err:
        raise SystemExit("mlx-whisper needs a Mac with Apple silicon") from err
    tokenizer = get_tokenizer(True, num_languages=100, language="pt", task="transcribe")
    return mlx_whisper.transcribe, lambda text: len(tokenizer.encode(" " + text.strip()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="transcriber", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pairing = commands.add_parser("pair", help="store the token shown on the Transcritores screen")
    pairing.add_argument("--api-url", required=True)
    pairing.add_argument("--name")
    pairing.add_argument(
        "--vault", help="the kb vault on this Mac, for 'Publica no acervo' (KBC-099)"
    )
    pairing.add_argument(
        "--sync-host",
        help="user@host of production: the vault is synced there by itself (KBC-100)",
    )
    pairing.set_defaults(handler=pair)
    running = commands.add_parser("run", help="lease and transcribe jobs until stopped")
    running.add_argument("--once", action="store_true", help="at most one job, then exit")
    running.add_argument(
        "--exit-when-idle", action="store_true", help="exit when the queue is empty"
    )
    running.add_argument("--poll", type=float, help="seconds between leases when idle (30)")
    running.add_argument(
        "--no-diarize", action="store_true", help="never lease voice separations (KBC-064)"
    )
    running.add_argument(
        "--no-voice-profiles", action="store_true", help="never handle voice prints (KBC-071)"
    )
    running.add_argument(
        "--no-kb-publish",
        action="store_true",
        help="never write track documents into the vault nor run kb (KBC-099)",
    )
    running.add_argument(
        "--sync-host", help="user@host of production, over the paired one (KBC-100)"
    )
    running.add_argument("--sync-script", help="sync-vault.sh to run (this checkout's)")
    running.add_argument(
        "--no-sync",
        action="store_true",
        help="never sync the vault with production by itself (KBC-100)",
    )
    running.set_defaults(handler=run)
    background = commands.add_parser(
        "service", help="keep the worker on in the background with launchd (KBC-114)"
    )
    background.add_argument("action", choices=("install", "uninstall", "status"))
    background.add_argument("--vault", help="the kb vault on this Mac (KB_CHAT_VAULT)")
    background.add_argument(
        "--extra",
        action="append",
        help="uv extras to run with (repeatable; default: diarize)",
    )
    background.add_argument(
        "--no-load", action="store_true", help="only write the plist, do not load it"
    )
    background.set_defaults(handler=service)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())

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
    save_config({"api_url": api_url, "name": args.name or socket.gethostname()})
    print("Pareado. Rode `uv run --project tools/transcriber transcriber run` ou carregue o plist.")
    return 0


def run(args: argparse.Namespace) -> int:
    from .api import ApiClient
    from .audio import decode_pcm16k, ffmpeg_bin
    from .diarize import senko_or_none
    from .vad import silero_speech
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
    )
    if args.poll:
        worker.poll_s = args.poll
    return worker.run(once=args.once, exit_when_idle=args.exit_when_idle)


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
    running.set_defaults(handler=run)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())

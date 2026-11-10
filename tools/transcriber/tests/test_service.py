"""The transcriber as a macOS LaunchAgent (KBC-114 AC-10): a fake launchctl, a temporary HOME.

Nothing here runs the real launchctl nor touches ~/Library of this Mac.
"""

import plistlib
from pathlib import Path

import pytest

from transcriber.cli import main
from transcriber.service import LABEL, Service, ServiceError

REPO = Path("/Users/o/kb-chat")
RUNNING = """gui/501/br.com.nova-alexandria.transcriber = {
	active count = 1
	path = /Users/o/Library/LaunchAgents/br.com.nova-alexandria.transcriber.plist
	state = running
	program = /opt/homebrew/bin/uv
	pid = 4242
	last exit code = (never exited)
}
"""
STOPPED = """gui/501/br.com.nova-alexandria.transcriber = {
	state = not running
	last exit code = 1
}
"""


class FakeLaunchctl:
    """Records each call; `print` answers as the service is (loaded or not)."""

    def __init__(self, loaded: str | None = None) -> None:
        self.calls: list[list[str]] = []
        self.loaded = loaded

    def run(self, args: list[str]) -> tuple[int, str]:
        self.calls.append(args)
        if args[0] == "print":
            if self.loaded is None:
                return 113, f'Could not find service "{LABEL}" in domain for user gui: 501'
            return 0, self.loaded
        if args[0] == "bootstrap":
            self.loaded = RUNNING
        if args[0] == "bootout":
            if self.loaded is None:
                return 3, "Boot-out failed: 3: No such process"
            self.loaded = None
        return 0, ""


TOOLS = {
    "uv": "/opt/homebrew/bin/uv",
    "kb": "/Users/o/.local/bin/kb",
    "ffmpeg": "/usr/local/bin/ffmpeg",
}


def service(home: Path, launchctl: FakeLaunchctl, tools=TOOLS, sleep=lambda _: None) -> Service:
    return Service(home=home, uid=501, launchctl=launchctl, repo=REPO, which=tools.get, sleep=sleep)


def read_plist(home: Path) -> dict:
    with (home / "Library" / "LaunchAgents" / f"{LABEL}.plist").open("rb") as file:
        return plistlib.load(file)


def test_ac10_install_writes_the_agent_and_bootstraps_it(tmp_path):
    launchctl = FakeLaunchctl()
    service(tmp_path, launchctl).install(vault="/Users/o/vault", extras=["diarize"])
    plist = read_plist(tmp_path)
    assert plist["Label"] == LABEL
    assert plist["ProgramArguments"] == [
        "/opt/homebrew/bin/uv",
        "run",
        "--project",
        "/Users/o/kb-chat/tools/transcriber",
        "--extra",
        "diarize",
        "transcriber",
        "run",
        "--exit-when-idle",
    ]
    assert plist["WorkingDirectory"] == "/Users/o/kb-chat"
    # The owner: on only when needed, off right after (2026-11-09). At login it runs once to
    # drain what waits, then exits; the API starts it again when a job comes (launchctl
    # kickstart). launchd never keeps it running.
    assert plist["RunAtLoad"] is True
    assert "KeepAlive" not in plist
    logs = tmp_path / "Library" / "Logs" / "nova-alexandria-transcriber"
    assert plist["StandardOutPath"] == str(logs / "service.log")
    assert plist["StandardErrorPath"] == str(logs / "service.log")
    assert logs.is_dir()
    env = plist["EnvironmentVariables"]
    assert env["KB_CHAT_VAULT"] == "/Users/o/vault"
    assert env["HOME"] == str(tmp_path)
    path = env["PATH"].split(":")
    assert path[:3] == ["/opt/homebrew/bin", "/Users/o/.local/bin", "/usr/local/bin"]
    assert len(path) == len(set(path))
    assert {"/usr/bin", "/bin"} <= set(path)
    assert launchctl.calls == [
        ["print", f"gui/501/{LABEL}"],
        ["bootstrap", "gui/501", str(tmp_path / "Library" / "LaunchAgents" / f"{LABEL}.plist")],
        # KBC-117: done only when launchd shows it.
        ["print", f"gui/501/{LABEL}"],
    ]


def test_ac10_the_plist_never_holds_a_token(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_CHAT_TRANSCRIBER_TOKEN", "nat_" + "x" * 43)
    service(tmp_path, FakeLaunchctl()).install(vault="/Users/o/vault", extras=[])
    text = (tmp_path / "Library" / "LaunchAgents" / f"{LABEL}.plist").read_text(encoding="utf-8")
    assert "nat_" not in text
    assert "TOKEN" not in text.upper().replace("KB_CHAT_VAULT", "")


def test_ac10_installing_again_boots_the_old_one_out_first(tmp_path):
    launchctl = FakeLaunchctl(loaded=RUNNING)
    service(tmp_path, launchctl).install(vault=None, extras=[])
    assert [call[0] for call in launchctl.calls] == [
        "print",
        "bootout",
        "print",
        "bootstrap",
        "print",
    ]
    assert "KB_CHAT_VAULT" not in read_plist(tmp_path)["EnvironmentVariables"]


def test_ac10_no_load_only_writes_the_file(tmp_path):
    launchctl = FakeLaunchctl()
    service(tmp_path, launchctl).install(vault=None, extras=[], load=False)
    assert read_plist(tmp_path)["Label"] == LABEL
    assert launchctl.calls == []


def test_ac10_install_refuses_without_uv(tmp_path):
    with pytest.raises(ServiceError, match="uv"):
        service(tmp_path, FakeLaunchctl(), tools={}).install(vault=None, extras=[])
    assert not (tmp_path / "Library" / "LaunchAgents").exists()


def test_ac10_a_bootstrap_that_fails_says_why(tmp_path):
    class Refusing(FakeLaunchctl):
        def run(self, args):
            self.calls.append(args)
            if args[0] == "bootstrap":
                return 5, "Bootstrap failed: 5: Input/output error"
            return super().run(args)

    with pytest.raises(ServiceError, match="Input/output error"):
        service(tmp_path, Refusing()).install(vault=None, extras=[])


def test_ac10_uninstall_boots_out_and_removes_the_file(tmp_path):
    launchctl = FakeLaunchctl()
    agent = service(tmp_path, launchctl)
    agent.install(vault=None, extras=[])
    agent.uninstall()
    assert launchctl.calls[-1] == ["bootout", f"gui/501/{LABEL}"]
    assert not (tmp_path / "Library" / "LaunchAgents" / f"{LABEL}.plist").exists()
    # Not loaded nor installed: uninstalling again is fine.
    agent.uninstall()


def test_ac10_status_reads_launchctl_print(tmp_path):
    agent = service(tmp_path, FakeLaunchctl(loaded=RUNNING))
    agent.install(vault=None, extras=[], load=False)
    running = agent.status()
    assert running["installed"] is True
    assert running["loaded"] is True
    assert running["running"] is True
    assert running["pid"] == 4242
    stopped = service(tmp_path, FakeLaunchctl(loaded=STOPPED)).status()
    assert stopped["running"] is False
    assert stopped["lastExit"] == "1"
    absent = service(tmp_path / "other", FakeLaunchctl()).status()
    assert absent == {
        "installed": False,
        "loaded": False,
        "running": False,
        "pid": None,
        "lastExit": None,
        "log": str(
            tmp_path / "other" / "Library" / "Logs" / "nova-alexandria-transcriber" / "service.log"
        ),
    }


def test_ac10_the_cli_installs_with_the_vault_and_keeps_it_in_the_config(
    tmp_path, monkeypatch, capsys
):
    launchctl = FakeLaunchctl()
    made: list[Service] = []
    config = tmp_path / "config.json"

    def factory(**kwargs):
        made.append(service(tmp_path, launchctl))
        return made[-1]

    monkeypatch.setattr("transcriber.cli.service_of", factory)
    monkeypatch.setattr("transcriber.cli.CONFIG_FILE", config)
    assert main(["service", "install", "--vault", "/Users/o/vault"]) == 0
    env = read_plist(tmp_path)
    # The owner: optional parts are installed by themselves when needed: `uv run` syncs the
    # extras before it starts the worker, so voices and voice prints never wait for a person.
    assert env["ProgramArguments"][4:8] == ["--extra", "diarize", "--extra", "voiceprint"]
    assert env["ProgramArguments"][8:] == ["transcriber", "run", "--exit-when-idle"]
    assert env["EnvironmentVariables"]["KB_CHAT_VAULT"] == "/Users/o/vault"
    assert '"vault_path": "/Users/o/vault"' in config.read_text(encoding="utf-8")
    assert main(["service", "status"]) == 0
    out = capsys.readouterr().out
    assert "rodando (pid 4242)" in out
    assert main(["service", "uninstall"]) == 0
    assert launchctl.calls[-1][0] == "bootout"


def test_the_owners_label_and_log_as_installed_by_hand_on_his_mac(tmp_path):
    """The coordinator installed `br.com.nova-alexandria.transcriber` by hand (2026-11-09):
    the same label, so installing updates it instead of adding a second agent."""
    assert LABEL == "br.com.nova-alexandria.transcriber"
    service(tmp_path, FakeLaunchctl()).install(vault="/Users/o/vault", extras=[])
    plist = read_plist(tmp_path)
    log = str(tmp_path / "Library" / "Logs" / "nova-alexandria-transcriber" / "service.log")
    assert plist["StandardOutPath"] == log
    assert plist["StandardErrorPath"] == log


def test_installing_over_the_hand_made_agent_replaces_it_once(tmp_path):
    agents = tmp_path / "Library" / "LaunchAgents"
    agents.mkdir(parents=True)
    (agents / f"{LABEL}.plist").write_bytes(plistlib.dumps({"Label": LABEL, "Old": True}))
    launchctl = FakeLaunchctl(loaded=RUNNING)
    service(tmp_path, launchctl).install(vault="/Users/o/vault", extras=[])
    assert sorted(path.name for path in agents.iterdir()) == [f"{LABEL}.plist"]
    assert "Old" not in read_plist(tmp_path)
    ops = [call[0] for call in launchctl.calls]
    assert ops.index("bootout") < ops.index("bootstrap")
    assert ops.count("bootstrap") == 1


def test_an_agent_left_under_the_old_label_is_taken_out_never_doubled(tmp_path):
    old = "com.nova-alexandria.transcriber"
    agents = tmp_path / "Library" / "LaunchAgents"
    agents.mkdir(parents=True)
    (agents / f"{old}.plist").write_bytes(plistlib.dumps({"Label": old}))
    launchctl = FakeLaunchctl()
    service(tmp_path, launchctl).install(vault="/Users/o/vault", extras=[])
    assert not (agents / f"{old}.plist").exists()
    assert ["bootout", f"gui/501/{old}"] in launchctl.calls
    assert (agents / f"{LABEL}.plist").is_file()


class RacingLaunchctl(FakeLaunchctl):
    """launchd as the owner's Mac showed it (KBC-117 (2)): a bootout returns at once, the old
    agent stays in `print` for a few polls, and a bootstrap meanwhile fails with error 5."""

    def __init__(self, loaded: str | None = RUNNING, lingers: int = 3, refusals: int = 0):
        super().__init__(loaded=loaded)
        self.lingers = lingers
        self.dying = 0
        self.refusals = refusals

    def run(self, args: list[str]) -> tuple[int, str]:
        if args[0] == "bootout" and self.loaded is not None:
            self.calls.append(args)
            self.dying = self.lingers
            return 0, ""
        if args[0] == "print" and self.dying > 0:
            self.calls.append(args)
            self.dying -= 1
            answer = self.loaded or ""
            if self.dying == 0:
                self.loaded = None
            return 0, answer
        if args[0] == "bootstrap" and (self.dying > 0 or self.refusals > 0):
            self.calls.append(args)
            self.refusals = max(0, self.refusals - 1)
            return 5, "Bootstrap failed: 5: Input/output error"
        return super().run(args)


def test_kbc117_install_waits_for_the_bootout_before_it_bootstraps(tmp_path):
    launchctl = RacingLaunchctl(lingers=3)
    slept: list[float] = []
    agent = service(tmp_path, launchctl, sleep=slept.append)
    agent.install(vault=None, extras=[])
    ops = [call[0] for call in launchctl.calls]
    assert ops[:2] == ["print", "bootout"]
    # print until the old one is gone (3 lingering answers, then "not found"), one bootstrap,
    # and a print that sees the new one.
    assert ops[2:] == ["print", "print", "print", "print", "bootstrap", "print"]
    assert slept and sum(slept) <= 10
    assert agent.status()["loaded"] is True


def test_kbc117_a_bootstrap_refused_once_is_tried_again(tmp_path):
    launchctl = RacingLaunchctl(loaded=None, refusals=1)
    service(tmp_path, launchctl, sleep=lambda _: None).install(vault=None, extras=[])
    assert [call[0] for call in launchctl.calls].count("bootstrap") == 2
    assert launchctl.loaded == RUNNING


def test_kbc117_an_old_agent_that_never_goes_fails_the_install_bounded(tmp_path):
    launchctl = RacingLaunchctl(lingers=10_000)
    slept: list[float] = []
    with pytest.raises(ServiceError, match="não saiu do launchd"):
        service(tmp_path, launchctl, sleep=slept.append).install(vault=None, extras=[])
    assert sum(slept) <= 10.5
    assert "bootstrap" not in [call[0] for call in launchctl.calls]


def test_kbc117_a_bootstrap_that_keeps_failing_says_not_loaded(tmp_path, monkeypatch, capsys):
    """The CLI never says "Carregado: sim" after a failed bootstrap (KBC-117 (2))."""
    launchctl = RacingLaunchctl(loaded=None, refusals=99)
    monkeypatch.setattr(
        "transcriber.cli.service_of",
        lambda **kwargs: service(tmp_path, launchctl, sleep=lambda _: None),
    )
    assert main(["service", "install"]) == 1
    captured = capsys.readouterr()
    assert "Input/output error" in captured.err
    assert "Carregado no launchd: não" in captured.out
    assert "Carregado no launchd: sim" not in captured.out
    assert [call[0] for call in launchctl.calls].count("bootstrap") == 3


def test_kbc117_install_reports_what_launchd_has_after_it(tmp_path, monkeypatch, capsys):
    launchctl = RacingLaunchctl(lingers=2)
    monkeypatch.setattr(
        "transcriber.cli.service_of",
        lambda **kwargs: service(tmp_path, launchctl, sleep=lambda _: None),
    )
    assert main(["service", "install"]) == 0
    assert "Carregado no launchd: sim" in capsys.readouterr().out

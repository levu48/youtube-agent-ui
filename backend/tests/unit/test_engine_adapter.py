import asyncio
import json
from pathlib import Path

import pytest

from app.engine import commands
from app.engine.errors import classify, engine_error_line, redact
from app.engine.runner import EngineCLI, EngineUnavailable

ROOT = Path("/tmp/projects/demo")


def spec(**kw):
    base = dict(idea="A valid documentary idea", language="vi", duration_seconds=180)
    base.update(kw)
    return commands.CreateSpec(**base)


def test_create_args_use_single_elements_and_no_draft():
    argv = commands.create_args(ROOT, spec(audience="Mọi người", tone="--force"))
    assert argv[0] == "create"
    assert f"--project-root={ROOT}" in argv
    assert "--draft-provider=none" in argv
    # A hostile value stays inside its own --opt=value element.
    assert "--tone=--force" in argv
    assert "--force" not in argv
    commands.assert_allowlisted(argv)


@pytest.mark.parametrize(
    "bad",
    [
        dict(idea="hi"),
        dict(idea="ok idea\x00 with nul"),
        dict(idea="x" * 2001),
        dict(language="fr"),
        dict(duration_seconds=59),
        dict(duration_seconds=3601),
        dict(duration_seconds=True),
        dict(guidance="g" * 4001),
    ],
)
def test_create_args_reject_invalid(bad):
    with pytest.raises(commands.ArgumentError):
        commands.create_args(ROOT, spec(**bad))


def test_root_must_be_absolute():
    with pytest.raises(commands.ArgumentError):
        commands.create_args(Path("relative/p"), spec())


def test_draft_args_allowlist():
    argv = commands.draft_args(ROOT, provider="ollama", model="qwen3:8b", from_stage="script")
    assert argv == [
        "draft",
        f"--project-root={ROOT}",
        "--provider=ollama",
        "--model=qwen3:8b",
        "--from-stage=script",
    ]
    assert commands.draft_args(ROOT, provider="fixture", model=None, from_stage="outline") == [
        "draft",
        f"--project-root={ROOT}",
        "--provider=fixture",
        "--from-stage=outline",
    ]


@pytest.mark.parametrize(
    "kw",
    [
        dict(provider="openai", model="x", from_stage="outline"),
        dict(provider="ollama", model="qwen3:8b; rm -rf /", from_stage="outline"),
        dict(provider="ollama", model="-force", from_stage="outline"),
        dict(provider="ollama", model=None, from_stage="outline"),
        dict(provider="ollama", model="qwen3:8b", from_stage="render"),
    ],
)
def test_draft_args_reject(kw):
    with pytest.raises(commands.ArgumentError):
        commands.draft_args(ROOT, **kw)


@pytest.mark.parametrize(
    "argv",
    [
        ["render", "--project-root=/x"],
        ["draft", "--project-root=/x", "--force"],
        ["draft", "--project-root=/x", "--replace-edits"],
        ["draft", "positional"],
        [],
    ],
)
def test_assert_allowlisted_rejects(argv):
    with pytest.raises(commands.ArgumentError):
        commands.assert_allowlisted(argv)


@pytest.mark.parametrize("slug", ["", "-x", "UPPER", "a/b", "../x", "a" * 64, "a b", "ä"])
def test_bad_slugs(slug):
    with pytest.raises(commands.ArgumentError):
        commands.check_slug(slug)


def test_exit_mapping():
    assert classify(0).code == "ok"
    assert classify(7).code == "provider_unavailable"
    assert classify(9).code == "engine_conflict"
    assert classify(16).expected_gate
    assert not classify(10).expected_gate
    assert classify(130).code == "interrupted"
    assert classify(-9).code == "terminated"
    assert classify(42).code == "engine_error_42"


def test_redaction():
    text = "api_key=sk-abcdefghijklmnopqrstu Bearer abcdefghijkl http://u:p@host/x \x1b[31mred"
    out = redact(text)
    assert "sk-abc" not in out and "abcdefghijkl" not in out and "u:p@" not in out
    assert "\x1b" not in out
    assert redact("x" * 5000).endswith("chars]")


def test_engine_error_line():
    assert engine_error_line("log\nerror: cannot reach Ollama") == "cannot reach Ollama"
    assert engine_error_line("interrupted") == "interrupted"
    assert engine_error_line("nothing") is None


async def test_runner_runs_fake_engine(fake_cli, tmp_root):
    res = await fake_cli.run(["--version"], timeout=10)
    assert res.ok and "fake" in res.stdout
    res = await fake_cli.run(commands.production_status_args(tmp_root / "p"), timeout=10)
    assert json.loads(res.stdout)["stages"]


async def test_runner_missing_engine(tmp_root):
    cli = EngineCLI(["/nonexistent/uv", "run", "ytagent"], tmp_root, {})
    with pytest.raises(EngineUnavailable):
        await cli.run(["--version"], timeout=5)
    cli = EngineCLI(["/bin/sh"], tmp_root / "missing-repo", {})
    with pytest.raises(EngineUnavailable):
        await cli.run(["--version"], timeout=5)


async def test_runner_rejects_non_allowlisted(fake_cli):
    with pytest.raises(commands.ArgumentError):
        await fake_cli.run(["render", "--project-root=/x"], timeout=5)


async def test_runner_timeout(tmp_root):
    cli = EngineCLI(["/bin/sleep"], tmp_root, {})
    # /bin/sleep receives "--version" and fails fast on macOS; use a real wait instead:
    cli = EngineCLI(["/usr/bin/python3", "-c", "import time; time.sleep(5)"], tmp_root, {})
    res = await cli.run(["--version"], timeout=0.3)
    assert res.timed_out and not res.ok
    await asyncio.sleep(0)


def test_draft_approve_args_are_single_elements_and_explicit():
    from pathlib import Path as _P

    from app.engine.commands import ArgumentError, assert_allowlisted, draft_approve_args

    root = _P("/tmp/projects/x")
    argv = draft_approve_args(root, reviewer="--force", comment="--replace-edits; rm -rf /")
    assert argv == [
        "draft-approve",
        f"--project-root={root}",
        "--reviewer=--force",
        "--comment=--replace-edits; rm -rf /",
    ]
    assert_allowlisted(argv)  # values are part of one element, never separate flags
    assert draft_approve_args(root, reviewer="  Lê Thị B  ")[2] == "--reviewer=Lê Thị B"
    for bad in ("", "  ", "a\nb", "a\tb", "x" * 201, "nul\x00"):
        with pytest.raises(ArgumentError):
            draft_approve_args(root, reviewer=bad)
    with pytest.raises(ArgumentError):
        draft_approve_args(root, reviewer="ok", comment="x" * 2001)


def test_draft_approve_expect_revision_is_validated():
    from pathlib import Path as _P

    from app.engine.commands import ArgumentError, assert_allowlisted, draft_approve_args

    root = _P("/tmp/projects/x")
    argv = draft_approve_args(root, reviewer="A", expect_revision="a" * 64)
    assert argv[-2:] == [f"--expect-revision={'a' * 64}", "--json"]
    assert_allowlisted(argv)
    for bad in ("", "A" * 64, "a" * 63, "a" * 64 + "\n", "--force", "a" * 63 + "g"):
        with pytest.raises(ArgumentError):
            draft_approve_args(root, reviewer="A", expect_revision=bad)


def test_draft_edit_args_carry_no_user_text():
    from pathlib import Path as _P

    from app.engine.commands import ArgumentError, assert_allowlisted, draft_edit_args

    root = _P("/tmp/projects/x")
    argv = draft_edit_args(root, expect_revision="b" * 64)
    assert argv == [
        "draft-edit",
        f"--project-root={root}",
        f"--expect-revision={'b' * 64}",
        "--json",
    ]
    assert_allowlisted(argv)
    assert draft_edit_args(root, expect_revision="b" * 64, dry_run=True)[-1] == "--dry-run"
    for bad in ("", "B" * 64, "b" * 65, "--force", None, "b" * 63 + "\n"):
        with pytest.raises(ArgumentError):
            draft_edit_args(root, expect_revision=bad)  # type: ignore[arg-type]


async def test_runner_passes_stdin_as_data(tmp_path):
    import sys as _sys

    from app.engine.runner import EngineCLI

    cli = EngineCLI(
        [_sys.executable, "-c", "import sys; sys.stdout.write(sys.stdin.read()[::-1])"],
        tmp_path,
        {},
    )
    res = await cli.run(["draft-check", "--json"], timeout=10, stdin="Đã sửa; $(rm -rf /)".encode())
    assert res.stdout == "Đã sửa; $(rm -rf /)"[::-1]

from pathlib import Path

import bootstrap


def test_runtime_hash_covers_requirements_and_lock(
    tmp_path: Path, monkeypatch
) -> None:
    requirements = tmp_path / "requirements.txt"
    constraints = tmp_path / "requirements.lock.txt"
    requirements.write_text("requests>=2\n", encoding="utf-8")
    constraints.write_text("requests==2.34.2\n", encoding="utf-8")
    monkeypatch.setattr(bootstrap, "REQUIREMENTS", requirements)
    monkeypatch.setattr(bootstrap, "CONSTRAINTS", constraints)

    original = bootstrap.requirements_hash()
    constraints.write_text("requests==2.34.3\n", encoding="utf-8")
    assert bootstrap.requirements_hash() != original

    changed_lock = bootstrap.requirements_hash()
    requirements.write_text("requests>=2.31\n", encoding="utf-8")
    assert bootstrap.requirements_hash() != changed_lock


def test_runtime_install_uses_exact_constraints(
    tmp_path: Path, monkeypatch
) -> None:
    runtime = tmp_path / "runtime"
    python = runtime / "python"
    runtime.mkdir()
    python.touch()
    commands: list[list[str]] = []

    monkeypatch.setattr(
        bootstrap, "managed_python", lambda create_root=False: (runtime, python)
    )
    monkeypatch.setattr(
        bootstrap.subprocess,
        "run",
        lambda command, **kwargs: commands.append(command),
    )
    monkeypatch.setattr(
        bootstrap,
        "dependency_report",
        lambda _python: {"ok": True, "missing": []},
    )

    assert bootstrap.ensure_runtime() == python
    assert commands == [
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--only-binary=:all:",
            "-r",
            str(bootstrap.REQUIREMENTS),
            "-c",
            str(bootstrap.CONSTRAINTS),
        ]
    ]
    assert (runtime / "requirements.sha256").read_text(encoding="ascii") == (
        bootstrap.requirements_hash()
    )


def test_lock_is_exact_and_keeps_pywin32_windows_only() -> None:
    lines = [
        line
        for line in bootstrap.CONSTRAINTS.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    ]
    assert all("==" in line for line in lines)
    assert 'pywin32==312; platform_system == "Windows"' in lines
    locked = {line.split("==", 1)[0].lower().replace("_", "-") for line in lines}
    direct = {
        line.split(">=", 1)[0].lower().replace("_", "-")
        for line in bootstrap.REQUIREMENTS.read_text(
            encoding="utf-8"
        ).splitlines()
        if line and not line.startswith("#")
    }
    assert direct <= locked

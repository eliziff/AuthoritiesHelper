"""Launch AuthoritiesHelper in a versioned managed Python runtime."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
import venv
from pathlib import Path

from shared_legal_data import app_state, isolated_process_env


APP_ROOT = Path(__file__).resolve().parent
REQUIREMENTS = APP_ROOT / "requirements.txt"
CONSTRAINTS = APP_ROOT / "requirements.lock.txt"
IMPORTS = {
    "docx": "python-docx",
    "fitz": "PyMuPDF",
    "requests": "requests",
}


def dependency_report(python: Path | None = None) -> dict:
    if python is not None:
        probe = (
            "import importlib.util,json;"
            f"print(json.dumps({{name: bool(importlib.util.find_spec(name)) "
            f"for name in {list(IMPORTS)!r}}}))"
        )
        completed = subprocess.run(
            [str(python), "-c", probe],
            check=False,
            capture_output=True,
            text=True,
            env=isolated_process_env(),
        )
        if completed.returncode:
            return {"ok": False, "error": completed.stderr.strip()}
        modules = json.loads(completed.stdout)
    else:
        modules = {name: bool(importlib.util.find_spec(name)) for name in IMPORTS}
    return {
        "ok": all(modules.values()),
        "modules": modules,
        "missing": [IMPORTS[name] for name, found in modules.items() if not found],
    }


def requirements_hash() -> str:
    return hashlib.sha256(
        REQUIREMENTS.read_bytes() + b"\0" + CONSTRAINTS.read_bytes()
    ).hexdigest()


def managed_python(*, create_root: bool = False) -> tuple[Path, Path]:
    runtime = (
        app_state("authorities-helper", create=create_root)
        / "runtime"
        / f"python-{sys.version_info.major}.{sys.version_info.minor}"
    )
    python = (
        runtime / "Scripts" / "python.exe"
        if sys.platform == "win32"
        else runtime / "bin" / "python"
    )
    return runtime, python


def ensure_runtime(*, stdio: bool = False) -> Path:
    runtime, python = managed_python(create_root=True)
    marker = runtime / "requirements.sha256"
    wanted = requirements_hash()
    if not python.is_file():
        runtime.parent.mkdir(parents=True, exist_ok=True)
        venv.EnvBuilder(with_pip=True, clear=False).create(runtime)
    installed = (
        marker.read_text(encoding="ascii").strip() if marker.is_file() else ""
    )
    if installed != wanted:
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--only-binary=:all:",
                "-r",
                str(REQUIREMENTS),
                "-c",
                str(CONSTRAINTS),
            ],
            check=True,
            stdout=sys.stderr if stdio else None,
            stderr=sys.stderr if stdio else None,
            env=isolated_process_env(
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "NO_PROXY",
                "PIP_*",
            ),
        )
        temporary = marker.with_suffix(".new")
        temporary.write_text(wanted, encoding="ascii")
        temporary.replace(marker)
    report = dependency_report(python)
    if not report["ok"]:
        raise RuntimeError(
            "Managed runtime is incomplete: " + ", ".join(report["missing"])
        )
    return python


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Report the current and managed runtime without launching.",
    )
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--stdio", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--inbox", type=Path, help=argparse.SUPPRESS)
    options = parser.parse_args(argv)
    if options.check:
        runtime, python = managed_python()
        print(
            json.dumps(
                {
                    "current": dependency_report(),
                    "managed": dependency_report(python)
                    if python.is_file()
                    else {"ok": False, "state": "not-installed"},
                    "managedPython": str(python),
                },
                indent=2,
            )
        )
        return 0
    if options.stdio and options.inbox is None:
        parser.error("--stdio requires --inbox")
    python = (
        Path(sys.executable)
        if options.stdio and dependency_report()["ok"]
        else ensure_runtime(stdio=options.stdio)
    )
    command = [
        str(python),
        "-X",
        "utf8",
        str(APP_ROOT / "toa_web.py"),
    ]
    if options.stdio:
        command.extend(["--stdio", "--inbox", str(options.inbox)])
    else:
        command.extend(["--port", str(options.port)])
    if options.no_browser and not options.stdio:
        command.append("--no-browser")
    return subprocess.call(
        command,
        env=isolated_process_env(
            "CODEX_HOME",
            "LEGALPDF_*",
            "MIKE_DOCX_*",
            "OPEN_LEGAL_DATA_HOME",
            "PYTHONPATH",
            "TESSDATA_PREFIX",
            "TOA_*",
        ),
    )


if __name__ == "__main__":
    raise SystemExit(main())

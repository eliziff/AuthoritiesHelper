"""Versioned, atomic persistence for lightweight GUI projects."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


PROJECT_FORMAT = "table-of-authorities-project"
PROJECT_VERSION = 1


def save_project_file(path: str | Path, payload: dict[str, Any]) -> Path:
    target = Path(path)
    project = dict(payload)
    project["format"] = PROJECT_FORMAT
    project["version"] = PROJECT_VERSION
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f"{target.name}.part")
    try:
        partial.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def load_project_file(path: str | Path) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if (
        not isinstance(payload, dict)
        or payload.get("format") != PROJECT_FORMAT
        or int(payload.get("version", 0)) != PROJECT_VERSION
    ):
        raise ValueError("This is not a supported Table of Authorities project file.")
    return payload

"""Compile the bundled legal grammar corpus with Python regex semantics."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

CORPUS = Path(__file__).with_name("data") / "legal-grammar-tables" / "grammar-corpus.json"
_NAMED_GROUP = re.compile(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>")
_DEF_REF = re.compile(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}")
_FLAGS = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}


@lru_cache(maxsize=1)
def _corpus() -> dict:
    value = json.loads(CORPUS.read_text(encoding="utf-8"))
    if value.get("format") != "legal-grammar-corpus:v1":
        raise ValueError(f"{CORPUS}: unsupported grammar corpus")
    return value


def _expand(source: str, defs: dict[str, str]) -> str:
    for _ in range(11):
        expanded = _DEF_REF.sub(lambda match: defs[match.group(1)], source)
        if expanded == source:
            return source
        source = expanded
    raise ValueError("grammar fragments form a cycle")


@lru_cache(maxsize=None)
def table_entry(entry_id: str) -> re.Pattern[str]:
    for table in _corpus()["tables"].values():
        for entry in table["entries"]:
            if entry["id"] == entry_id:
                source = _expand(entry["pattern"], table.get("defs", {}))
                flags = sum(_FLAGS[flag] for flag in entry.get("flags", ""))
                return re.compile(_NAMED_GROUP.sub(r"(?P<\1>", source), flags)
    raise KeyError(f"unknown grammar entry {entry_id}")


def table_definition(table_name: str, name: str) -> str:
    table = _corpus()["tables"][table_name]
    return _expand(table["defs"][name], table["defs"])

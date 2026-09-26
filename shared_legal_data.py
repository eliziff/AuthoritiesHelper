"""Thin path bridge to the sibling OpenLegalData package.

Packaged builds include ``open_legal_data``. A source checkout also discovers
the workspace sibling automatically. The small fallback keeps this standalone
repository usable when it is cloned by itself while preserving the same path
contract.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


_SYSTEM_ENV = {
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "PATHEXT",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "REQUESTS_CA_BUNDLE",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
}


def isolated_process_env(*allow: str) -> dict[str, str]:
    """Return a child environment without unrelated parent credentials."""
    exact = {name.upper() for name in allow if not name.endswith("*")}
    prefixes = tuple(name[:-1].upper() for name in allow if name.endswith("*"))
    return {
        name: value
        for name, value in os.environ.items()
        if (upper := name.upper()) in _SYSTEM_ENV
        or upper in exact
        or upper.startswith(prefixes)
    }


def _load_shared_paths():
    try:
        from open_legal_data import paths
        return paths
    except ModuleNotFoundError:
        sibling_src = Path(__file__).resolve().parent.parent / "OpenLegalData" / "src"
        if sibling_src.is_dir() and str(sibling_src) not in sys.path:
            sys.path.insert(0, str(sibling_src))
        try:
            from open_legal_data import paths
            return paths
        except ModuleNotFoundError:
            return None


_PATHS = _load_shared_paths()


def data_root(*, create: bool = False) -> Path:
    if _PATHS is not None:
        return _PATHS.data_root(create=create)
    override = os.environ.get("OPEN_LEGAL_DATA_HOME", "").strip()
    if override:
        root = Path(override).expanduser()
    elif sys.platform == "win32":
        root = (
            Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
            / "OpenLegalProducts"
            / "LegalData"
        )
    elif sys.platform == "darwin":
        root = (
            Path.home()
            / "Library"
            / "Application Support"
            / "OpenLegalProducts"
            / "LegalData"
        )
    else:
        root = (
            Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
            / "OpenLegalProducts"
            / "LegalData"
        )
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def provider_directory(provider: str, *, create: bool = False) -> Path:
    if _PATHS is not None:
        return _PATHS.provider_directory(provider, create=create)
    target = data_root(create=create) / "providers" / provider
    if create:
        target.mkdir(parents=True, exist_ok=True)
    return target


def provider_cache(provider: str, *, create: bool = False) -> Path:
    if _PATHS is not None:
        return _PATHS.provider_cache(provider, create=create)
    target = data_root(create=create) / "cache" / provider
    if create:
        target.mkdir(parents=True, exist_ok=True)
    return target


def app_state(app: str, *, create: bool = False) -> Path:
    if _PATHS is not None:
        return _PATHS.app_state(app, create=create)
    target = data_root(create=create) / "apps" / app
    if create:
        target.mkdir(parents=True, exist_ok=True)
    return target


def a2aj_status() -> dict:
    if _PATHS is None:
        return {"state": "missing", "available": False}
    from open_legal_data.a2aj import status

    return status()


class SharedA2AJCorpus:
    """API-shaped adapter over the canonical stdlib-SQLite A2AJ database."""

    def fetch(self, citation: str, doc_type: str, **_kwargs):
        from open_legal_data.a2aj import A2AJUnavailable, exact

        language = str(_kwargs.get("language") or "en")
        try:
            document = exact(
                citation,
                doc_type="laws" if doc_type == "laws" else "cases",
                language="fr" if language == "fr" else "en",
                max_chars=10_000_000,
            )
        except A2AJUnavailable:
            document = None
        if not document:
            return {"status": 200, "json": {"results": []}, "error": "", "local": True}
        actual_language = document["language"]
        record = {
            "dataset": document.get("dataset"),
            f"citation_{actual_language}": document.get("citation"),
            f"citation2_{actual_language}": document.get("alternateCitation"),
            f"name_{actual_language}": document.get("name"),
            f"document_date_{actual_language}": document.get("date"),
            f"source_url_{actual_language}": document.get("url"),
            f"unofficial_text_{actual_language}": document.get("text"),
            f"unofficial_sections_{actual_language}": document.get("sections"),
            "upstream_license": document.get("upstreamLicense"),
        }
        return {
            "status": 200,
            "json": {"results": [record]},
            "error": "",
            "local": True,
        }

    def search_exact_name(self, _name: str, _doc_type: str):
        return {"status": 200, "json": {"results": []}, "error": "", "local": True}

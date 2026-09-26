"""One local web UI for both standalone and Mike-hosted use.

The browser never receives host filesystem paths. Every uploaded file and
background job lives below the shared AuthoritiesHelper application-data
directory, and every operation delegates to the existing CLI with an argv
list (never a shell command).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.parse import parse_qs, quote, unquote, urlsplit

from shared_legal_data import app_state, isolated_process_env


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
CLI_PATH = BASE_DIR / "toa_maker.py"
DOCX_LIMIT = 64 * 1024 * 1024
PDF_LIMIT = 256 * 1024 * 1024
JSON_LIMIT = 16 * 1024 * 1024
MAX_RUNNING_JOBS = 2
JOB_RE = re.compile(r"^[0-9a-f]{32}$")
FILE_RE = re.compile(r"^[0-9a-f]{32}$")
PROJECT_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)
LOOPBACK_NAMES = {"127.0.0.1", "::1", "localhost"}
CANONICAL_OUTPUT_KEYS = {
    "book": ("book_of_authorities_pdf",),
    "table": ("annotated_docx",),
    "both": ("book_of_authorities_pdf", "annotated_docx"),
}

BUILD_OPTIONS = {
    "pdf_mode": {"auto", "originals", "render", "none"},
    "tab_style": {"numeric", "alpha"},
    "output_mode": {"book", "table", "both"},
    "table_delivery": {"native_marks", "native_append", "linked_append", "pdf_append"},
    "table_location": {"pages", "pinpoints", "combined"},
    "highlight_style": {"none", "margin", "paragraph", "text", "sidelined"},
    "scanned_pdf_policy": {"page_margin", "cited_pages", "full"},
}
COURT_PROFILE_DATA = json.loads((WEB_DIR / "court-profiles.json").read_text(encoding="utf-8"))
COURT_PROFILE_BY_ID = {
    str(profile["id"]): profile for profile in COURT_PROFILE_DATA["profiles"]
}
COURT_PROFILES = set(COURT_PROFILE_BY_ID)
DEFAULT_SETTINGS: dict[str, Any] = {
    "setup_version": 0,
    "offline": False,
    "enrich_spans": True,
    "prompt_for_scanned_pdfs": True,
    "pdf_mode": "auto",
    "tab_style": "numeric",
    "output_mode": "book",
    "table_delivery": "native_append",
    "table_location": "pages",
    "highlight_style": "margin",
    "scanned_pdf_policy": "page_margin",
    "court_profile": "general",
}

_RUNNING: set[str] = set()
_RUNNING_LOCK = threading.Lock()
_STATE_LOCK = threading.RLock()


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, payload: Any) -> None:
    with _STATE_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        for attempt in range(5):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 4:
                    temporary.unlink(missing_ok=True)
                    raise
                time.sleep(0.01 * (attempt + 1))


def _read_json(path: Path, default: Any) -> Any:
    with _STATE_LOCK:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return default


def _job_path(root: Path, job_id: str) -> Path:
    if not JOB_RE.fullmatch(job_id):
        raise RequestError(HTTPStatus.NOT_FOUND, "Job not found.")
    path = (root / "jobs" / job_id).resolve()
    if not path.is_dir() or path.parent != (root / "jobs").resolve():
        raise RequestError(HTTPStatus.NOT_FOUND, "Job not found.")
    return path


def _safe_child(root: Path, relative: str) -> Path:
    """Resolve a URL-style relative path without Windows traversal tricks."""
    if not relative or "\\" in relative or "\x00" in relative:
        raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid file path.")
    parts = PurePosixPath(unquote(relative)).parts
    if any(part in {"", ".", ".."} or ":" in part for part in parts):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid file path.")
    base = root.resolve()
    candidate = base.joinpath(*parts).resolve()
    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid file path.") from exc
    return candidate


def _clean_name(value: str, fallback: str) -> str:
    name = value.replace("\\", "/").rsplit("/", 1)[-1].strip()
    name = re.sub(r"[\x00-\x1f<>:\"/\\|?*]+", "-", name).strip(" .")
    return name[:180] or fallback


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")[:100] or "manual-book"


def _project_id(query: dict[str, list[str]]) -> str:
    value = query.get("project", [""])[0].strip()
    if value and not PROJECT_RE.fullmatch(value):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid project.")
    return value.lower()


def _new_job(root: Path, input_name: str = "", project_id: str = "") -> tuple[str, Path]:
    job_id = uuid.uuid4().hex
    path = root / "jobs" / job_id
    path.mkdir(parents=True)
    (path / "outputs").mkdir()
    (path / "manual" / "files").mkdir(parents=True)
    (path / "manual" / "outputs").mkdir()
    _write_json(
        path / "job.json",
        {
            "id": job_id,
            "created_at": _utc_now(),
            "input_name": input_name,
            "project_id": project_id,
            "state": "ready",
            "operation": "",
            "progress": 0,
            "message": "Ready",
            "log": [],
        },
    )
    _write_json(path / "manual" / "state.json", {"book_title": "Book of Authorities", "entries": []})
    return job_id, path


def _input_document(job: Path) -> Path:
    name = _read_json(job / "job.json", {}).get("input_file", "input.docx")
    if name not in {"input.docx", "input.pdf"} or not (job / name).is_file():
        raise RequestError(
            HTTPStatus.CONFLICT,
            "Import and review a Word document or PDF first.",
        )
    return job / name


def _update_job(path: Path, **changes: Any) -> dict[str, Any]:
    with _STATE_LOCK:
        payload = _read_json(path / "job.json", {})
        payload.update(changes)
        payload["updated_at"] = _utc_now()
        _write_json(path / "job.json", payload)
        return payload


def _latest_manifest_path(job: Path) -> Path | None:
    manifests = list((job / "outputs").rglob("*.toa-manifest.json"))
    return max(manifests, key=lambda path: path.stat().st_mtime) if manifests else None


def _job_public(path: Path) -> dict[str, Any]:
    payload = _read_json(path / "job.json", {})
    manifest_path = (
        None if payload.get("operation") == "manual book" else _latest_manifest_path(path)
    )
    if payload.get("output_mode") not in CANONICAL_OUTPUT_KEYS and manifest_path:
        output_mode = _read_json(manifest_path, {}).get("output_mode")
        if output_mode in CANONICAL_OUTPUT_KEYS:
            payload["output_mode"] = output_mode
    payload.pop("log", None)
    payload["message"] = _public_status(payload)
    payload["has_review"] = (path / "review.json").is_file()
    payload["has_manifest"] = (
        payload.get("operation") != "manual book"
        and not (payload.get("state") == "running" and payload.get("operation") == "build")
        and manifest_path is not None
    )
    payload["files"] = [] if payload.get("state") == "running" else _output_files(path)
    return payload


def _output_files(job: Path) -> list[dict[str, Any]]:
    """Return assembled user deliverables, never build internals or tab PDFs."""
    rows: list[dict[str, Any]] = []
    paths: set[Path] = set()
    state = _read_json(job / "job.json", {})
    manifest_path = (
        None if state.get("operation") == "manual book" else _latest_manifest_path(job)
    )
    if manifest_path:
        manifest = _read_json(manifest_path, {})
        outputs = manifest.get("outputs", {}) if isinstance(manifest, dict) else {}
        if isinstance(outputs, dict):
            output_mode = str(manifest.get("output_mode") or "book")
            for key in CANONICAL_OUTPUT_KEYS.get(output_mode, ()):
                value = outputs.get(key)
                if isinstance(value, str) and value:
                    paths.add(Path(value))
    else:
        manual_output = state.get("manual_output")
        if isinstance(manual_output, str) and manual_output:
            paths.add(Path(manual_output))
        else:
            manual_outputs = list((job / "manual" / "outputs").glob("*.pdf"))
            if manual_outputs:
                paths.add(max(manual_outputs, key=lambda path: path.stat().st_mtime))
    root = job.resolve()
    for path in sorted(paths):
        try:
            resolved = path.resolve()
            relative = resolved.relative_to(root).as_posix()
        except (OSError, ValueError):
            continue
        if not resolved.is_file():
            continue
        rows.append(
            {
                "name": resolved.name,
                "path": relative,
                "size": resolved.stat().st_size,
                "url": f"/api/jobs/{job.name}/files/{quote(relative, safe='/')}",
            }
        )
    return rows


def _validate_docx(path: Path) -> None:
    try:
        from toa_maker import _validate_office_archive

        with zipfile.ZipFile(path) as archive:
            _validate_office_archive(archive)
    except (OSError, zipfile.BadZipFile, ValueError) as exc:
        raise RequestError(HTTPStatus.BAD_REQUEST, f"Not a valid DOCX: {exc}") from exc


def _validate_pdf(path: Path) -> None:
    try:
        with path.open("rb") as handle:
            header = handle.read(5)
    except OSError as exc:
        raise RequestError(HTTPStatus.BAD_REQUEST, f"Could not read PDF: {exc}") from exc
    if header != b"%PDF-":
        raise RequestError(HTTPStatus.BAD_REQUEST, "Not a valid PDF upload.")


def _validate_settings(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Settings must be a JSON object.")
    result = dict(DEFAULT_SETTINGS)
    for key, allowed in BUILD_OPTIONS.items():
        value = str(payload.get(key, result[key]))
        if value not in allowed:
            raise RequestError(HTTPStatus.BAD_REQUEST, f"Unsupported {key}.")
        result[key] = value
    court_profile = str(payload.get("court_profile", result["court_profile"]))
    if court_profile not in COURT_PROFILES:
        raise RequestError(HTTPStatus.BAD_REQUEST, "Unsupported court_profile.")
    result["court_profile"] = court_profile
    profile = COURT_PROFILE_BY_ID[court_profile]
    defaults = profile.get("defaults", {})
    for key, value in defaults.items():
        if key in BUILD_OPTIONS and key not in payload:
            result[key] = str(value)
    for key, allowed in profile.get("allowed", {}).items():
        if key in BUILD_OPTIONS and result[key] not in allowed:
            result[key] = str(defaults[key])
    for key, value in profile.get("locked", {}).items():
        if key in BUILD_OPTIONS:
            result[key] = str(value)
    for key in ("offline", "enrich_spans", "prompt_for_scanned_pdfs"):
        value = payload.get(key, result[key])
        if not isinstance(value, bool):
            raise RequestError(HTTPStatus.BAD_REQUEST, f"{key} must be true or false.")
        result[key] = value
    setup_version = payload.get("setup_version", result["setup_version"])
    if isinstance(setup_version, bool) or not isinstance(setup_version, int):
        raise RequestError(HTTPStatus.BAD_REQUEST, "setup_version must be an integer.")
    result["setup_version"] = max(0, setup_version)
    return result


def _cli(*args: str | Path) -> list[str]:
    return [sys.executable, "-X", "utf8", str(CLI_PATH), *(str(item) for item in args)]


def _public_status(job: dict[str, Any]) -> str:
    state = str(job.get("state") or "")
    operation = str(job.get("operation") or "")
    progress = int(job.get("progress") or 0)
    if state == "error":
        return "Needs attention"
    if state == "complete":
        if operation == "detection":
            return "Ready to build"
        if operation == "PDF attachment":
            return "PDF added"
        if operation in {"build", "finalization"} and job.get("output_mode") == "table":
            return "Table ready"
        if operation in {"build", "finalization"} and job.get("output_mode") == "both":
            return "Book and table ready"
        return "Book ready"
    if state != "running":
        return "Ready"
    if operation == "detection":
        return "Finding citations"
    if operation in {"PDF attachment", "attach"}:
        return "Matching PDFs"
    if operation in {"manual book", "finalization"}:
        return "Building the book"
    if operation == "build":
        if progress < 50:
            return "Finding citations"
        if progress < 84:
            return "Matching PDFs"
        return {
            "table": "Building the table",
            "both": "Building both files",
        }.get(job.get("output_mode"), "Building the book")
    return "Working"


def _start_process(
    job: Path,
    operation: str,
    argv: list[str],
    *,
    success: Callable[[], None] | None = None,
) -> None:
    with _RUNNING_LOCK:
        if job.name in _RUNNING:
            raise RequestError(HTTPStatus.CONFLICT, "This job already has work in progress.")
        if len(_RUNNING) >= MAX_RUNNING_JOBS:
            raise RequestError(HTTPStatus.SERVICE_UNAVAILABLE, "The build service is busy.")
        _RUNNING.add(job.name)
    _update_job(
        job,
        state="running",
        operation=operation,
        progress=0,
        message=f"Starting {operation}",
        log=[],
        error="",
    )

    def run() -> None:
        lines: list[str] = []
        process: subprocess.Popen[str] | None = None
        try:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            process = subprocess.Popen(
                argv,
                cwd=BASE_DIR,
                env={
                    **isolated_process_env(
                        "LEGALPDF_*",
                        "MIKE_DOCX_*",
                        "OPEN_LEGAL_DATA_HOME",
                        "PYTHONPATH",
                        "TESSDATA_PREFIX",
                        "TOA_*",
                        "VIRTUAL_ENV",
                    ),
                    "PYTHONIOENCODING": "utf-8",
                    "PYTHONUTF8": "1",
                },
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="strict",
                bufsize=1,
                creationflags=flags,
            )
            assert process.stdout is not None
            progress = 0
            message = f"Running {operation}"
            last_write = 0.0
            with process.stdout:
                for raw_line in process.stdout:
                    line = raw_line.rstrip()
                    if not line:
                        continue
                    lines.append(line)
                    del lines[:-100]
                    if line.startswith("PROGRESS\t"):
                        fields = line.split("\t", 2)
                        if len(fields) == 3:
                            try:
                                progress = min(100, max(0, int(fields[1])))
                            except ValueError:
                                pass
                            message = fields[2][:500]
                        now = time.monotonic()
                        if now - last_write >= 0.2:
                            _update_job(
                                job,
                                progress=progress,
                                message=message,
                                log=list(lines),
                            )
                            last_write = now
            return_code = process.wait()
            if return_code:
                detail = lines[-1] if lines else f"CLI exited with status {return_code}"
                _update_job(
                    job,
                    state="error",
                    message=f"{operation.capitalize()} failed",
                    error=detail,
                    log=lines,
                )
                return
            if success is not None:
                success()
            _update_job(
                job,
                state="complete",
                progress=100,
                message=f"{operation.capitalize()} complete",
                error="",
                log=lines,
            )
        except Exception as exc:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            lines = [*lines[-99:], f"{type(exc).__name__}: {exc}"]
            _update_job(
                job,
                state="error",
                message=f"{operation.capitalize()} failed",
                error=str(exc),
                log=lines,
            )
        finally:
            with _RUNNING_LOCK:
                _RUNNING.discard(job.name)

    threading.Thread(target=run, name=f"toa-{operation}-{job.name[:8]}", daemon=True).start()


def _manifest_path(job: Path) -> Path:
    manifest = _latest_manifest_path(job)
    if not manifest:
        raise RequestError(HTTPStatus.CONFLICT, "Build the project before inserting PDFs.")
    return manifest


def _manifest_public(job: Path) -> dict[str, Any]:
    path = _manifest_path(job)
    payload = _read_json(path, {})
    authorities = []
    for row in payload.get("authorities", []):
        if not isinstance(row, dict):
            continue
        authorities.append(
            {
                "key": str(row.get("key") or ""),
                "name": str(row.get("name") or row.get("citation") or "Authority"),
                "citation": str(row.get("citation") or ""),
                "tab": str(row.get("tab") or ""),
                "pdf_origin": str(row.get("pdf_origin") or ""),
                "needs_pdf": str(row.get("pdf_origin") or "") == "placeholder",
            }
        )
    return {
        "placeholder_count": sum(row["needs_pdf"] for row in authorities),
        "can_finalize": bool(payload.get("outputs", {}).get("book_of_authorities_pdf")),
        "authorities": authorities,
    }


def _manual_public(job: Path) -> dict[str, Any]:
    state = _read_json(job / "manual" / "state.json", {"book_title": "Book of Authorities", "entries": []})
    entries = []
    for row in state.get("entries", []):
        if not isinstance(row, dict):
            continue
        entries.append(
            {
                "id": str(row.get("id") or ""),
                "filename": str(row.get("filename") or ""),
                "title": str(row.get("title") or ""),
                "tab": str(row.get("tab") or ""),
            }
        )
    return {"book_title": str(state.get("book_title") or "Book of Authorities"), "entries": entries}


def _save_manual(job: Path, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or not isinstance(payload.get("entries", []), list):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Manual book state is invalid.")
    title = str(payload.get("book_title") or "Book of Authorities").strip()[:300] or "Book of Authorities"
    existing = {row["id"]: row for row in _manual_public(job)["entries"]}
    entries = []
    seen: set[str] = set()
    for item in payload["entries"]:
        if not isinstance(item, dict):
            raise RequestError(HTTPStatus.BAD_REQUEST, "Manual book entry is invalid.")
        file_id = str(item.get("id") or "")
        if file_id not in existing or file_id in seen or not FILE_RE.fullmatch(file_id):
            raise RequestError(HTTPStatus.BAD_REQUEST, "Manual PDF reference is invalid.")
        seen.add(file_id)
        source = existing[file_id]
        entries.append(
            {
                "id": file_id,
                "filename": source["filename"],
                "title": str(item.get("title") or source["title"] or source["filename"]).strip()[:300],
                "tab": str(item.get("tab") or f"Tab {len(entries) + 1}").strip()[:100],
            }
        )
    result = {"book_title": title, "entries": entries}
    _write_json(job / "manual" / "state.json", result)
    return result


def _save_review_edits(job: Path, payload: Any) -> dict[str, int]:
    if not isinstance(payload, dict) or not isinstance(payload.get("edits"), list):
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            "Review edits must be a JSON list.",
        )
    edits = payload["edits"]
    if not edits or len(edits) > 500:
        raise RequestError(HTTPStatus.BAD_REQUEST, "Review edits are empty or too large.")

    with _STATE_LOCK:
        review = _read_json(job / "review.json", None)
        if not isinstance(review, dict) or not isinstance(review.get("parts"), list):
            raise RequestError(HTTPStatus.CONFLICT, "Citation review is not ready.")
        parts = [part for part in review["parts"] if isinstance(part, dict)]
        by_id = {
            str(part.get("uid") or f"{part.get('unit_key', '')}:{part.get('index', '')}"): part
            for part in parts
        }
        allowed_kinds = {"case", "statute", "journal", "reference", "other"}
        allowed_fields = {"kind", "supra_target", "citation", "pinpoint_fragments"}

        for edit in edits:
            if not isinstance(edit, dict) or not isinstance(edit.get("changes"), dict):
                raise RequestError(HTTPStatus.BAD_REQUEST, "Review edit is invalid.")
            part_id = str(edit.get("part_id") or "")
            part = by_id.get(part_id)
            changes = edit["changes"]
            if part is None or not changes or not set(changes) <= allowed_fields:
                raise RequestError(HTTPStatus.BAD_REQUEST, "Review edit is invalid.")
            for field, value in changes.items():
                if field == "kind":
                    if value not in allowed_kinds:
                        raise RequestError(HTTPStatus.BAD_REQUEST, "Source type is invalid.")
                elif field == "supra_target":
                    if not isinstance(value, str) or (
                        value and (value == part_id or value not in by_id)
                    ):
                        raise RequestError(
                            HTTPStatus.BAD_REQUEST,
                            "Cross-reference is invalid.",
                        )
                elif field == "citation":
                    if not isinstance(value, str) or len(value) > 10_000:
                        raise RequestError(HTTPStatus.BAD_REQUEST, "Citation is invalid.")
                elif (
                    not isinstance(value, list)
                    or len(value) > 100
                    or any(not isinstance(item, str) or len(item) > 500 for item in value)
                ):
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Pinpoints are invalid.")
                part[field] = value
            part["reviewed"] = True
        _write_json(job / "review.json", review)
    return {"saved": len(edits)}


def _review_action(job: Path, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Review action is invalid.")
    action = payload.get("action")
    part_id = payload.get("part_id")
    if action not in {"authority", "pinpoint", "split", "merge"} or not isinstance(part_id, str):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Review action is invalid.")

    from toa_maker import (
        DeterministicPart,
        ReviewState,
        _anchor_spans,
        _part_from,
        _set_authority_span,
        _set_pinpoint_span,
    )

    with _STATE_LOCK:
        path = job / "review.json"
        if not path.is_file():
            raise RequestError(HTTPStatus.CONFLICT, "Citation review is not ready.")
        review = ReviewState.load(path)
        parts = {part.part_id: part for part in review.parts}
        part = parts.get(part_id)
        units = {unit.key: unit for unit in review.units}
        unit = units.get(part.unit_key) if part else None
        if not part or not unit:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Citation is no longer available.")

        def selected_range() -> tuple[int, int]:
            start, end = payload.get("start"), payload.get("end")
            if (
                isinstance(start, bool)
                or isinstance(end, bool)
                or not isinstance(start, int)
                or not isinstance(end, int)
            ):
                raise RequestError(HTTPStatus.BAD_REQUEST, "Select text in the citation first.")
            return start, end

        def manual_part(index: int, start: int, end: int, reason: str):
            while start < end and unit.text[start].isspace():
                start += 1
            while end > start and unit.text[end - 1].isspace():
                end -= 1
            raw = unit.text[start:end]
            created = _part_from(
                unit,
                index,
                "manual",
                [reason],
                DeterministicPart(
                    start,
                    end,
                    raw,
                    tuple(item[2] for item in _anchor_spans(raw)),
                ),
            )
            created.reviewed = True
            created.uid = f"{unit.key}:manual:{start}:{end}"
            return created

        try:
            selected_part_id = part.part_id
            if action == "authority":
                _set_authority_span(part, unit, *selected_range())
            elif action == "pinpoint":
                _set_pinpoint_span(part, unit, *selected_range())
            elif action == "split":
                cursor = payload.get("cursor")
                if isinstance(cursor, bool) or not isinstance(cursor, int):
                    raise RequestError(
                        HTTPStatus.BAD_REQUEST,
                        "Place the cursor inside this citation first.",
                    )
                if unit.kind != "footnote" or not (part.start < cursor < part.end):
                    raise RequestError(
                        HTTPStatus.BAD_REQUEST,
                        "Place the cursor inside this footnote citation first.",
                    )
                if not unit.text[part.start:cursor].strip() or not unit.text[cursor:part.end].strip():
                    raise RequestError(
                        HTTPStatus.BAD_REQUEST,
                        "The cursor must leave citation text on both sides.",
                    )
                left = manual_part(part.index, part.start, cursor, "manual_split")
                right = manual_part(part.index + 1, cursor, part.end, "manual_split")
                if part.supra_target:
                    (left if left.kind == "reference" else right).supra_target = part.supra_target
                for referrer in review.parts:
                    if referrer.supra_target == part.part_id:
                        referrer.supra_target = left.part_id
                position = review.parts.index(part)
                review.parts[position : position + 1] = [left, right]
                review.renumber()
                selected_part_id = left.part_id
            else:
                siblings = sorted(
                    (candidate for candidate in review.parts if candidate.unit_key == part.unit_key),
                    key=lambda candidate: candidate.start,
                )
                position = siblings.index(part)
                if unit.kind != "footnote" or position == 0:
                    raise RequestError(
                        HTTPStatus.BAD_REQUEST,
                        "This is the first citation in the footnote.",
                    )
                previous = siblings[position - 1]
                merged = manual_part(
                    previous.index,
                    min(previous.start, part.start),
                    max(previous.end, part.end),
                    "manual_merge",
                )
                if merged.kind == "reference":
                    merged.supra_target = previous.supra_target or part.supra_target
                old_ids = {previous.part_id, part.part_id}
                for referrer in review.parts:
                    if referrer.supra_target in old_ids:
                        referrer.supra_target = merged.part_id
                updated = []
                for candidate in review.parts:
                    if candidate is previous:
                        updated.append(merged)
                    elif candidate is not part:
                        updated.append(candidate)
                review.parts = updated
                review.renumber()
                selected_part_id = merged.part_id
        except ValueError as exc:
            raise RequestError(HTTPStatus.BAD_REQUEST, str(exc)) from exc

        review.save(path, compact=True)
        return {"review": review.to_dict(), "selected_part_id": selected_part_id}


def _dependency_status() -> dict[str, Any]:
    modules = {
        "python-docx": ("docx", True),
        "requests": ("requests", True),
        "PyMuPDF": ("fitz", True),
    }
    dependencies = {
        label: {"available": importlib.util.find_spec(module) is not None, "required": required}
        for label, (module, required) in modules.items()
    }
    return {
        "ok": CLI_PATH.is_file() and all(
            item["available"] for item in dependencies.values() if item["required"]
        ),
        "service": "authorities-helper",
        "version": 1,
        "python": sys.version.split()[0],
        "dependencies": dependencies,
    }


class ToAWebServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state_root: Path):
        self.state_root = state_root.resolve()
        self.state_root.mkdir(parents=True, exist_ok=True)
        (self.state_root / "jobs").mkdir(exist_ok=True)
        super().__init__(address, ToAWebHandler)


class ToAWebHandler(BaseHTTPRequestHandler):
    server_version = "AuthoritiesHelper"

    def version_string(self) -> str:
        return self.server_version

    @property
    def state_root(self) -> Path:
        return self.server.state_root  # type: ignore[attr-defined]

    def log_message(self, _format: str, *args: Any) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/api/jobs"): path = "/api/jobs/*"
        status = args[1] if len(args) > 1 else "-"
        print(f"[toa-web] {self.client_address[0]} {self.command} {path} {status}", file=sys.stderr)

    def _request_authority(self) -> tuple[str, int]:
        values = self.headers.get_all("Host", [])
        if len(values) != 1:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Exactly one Host header is required.")
        parsed = urlsplit(f"//{values[0]}")
        try:
            port = parsed.port or 80
        except ValueError as exc:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid Host header.") from exc
        host = (parsed.hostname or "").lower()
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid Host header.")
        if host not in LOOPBACK_NAMES:
            raise RequestError(HTTPStatus.FORBIDDEN, "Loopback host required.")
        return host, port

    def _check_host(self) -> None:
        self._request_authority()

    def _check_write_origin(self) -> None:
        if self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
            raise RequestError(HTTPStatus.FORBIDDEN, "Cross-site request refused.")
        origin = self.headers.get("Origin")
        if origin:
            expected_host, expected_port = self._request_authority()
            parsed = urlsplit(origin)
            try:
                actual_port = parsed.port or 80
            except ValueError as exc:
                raise RequestError(HTTPStatus.FORBIDDEN, "Cross-site request refused.") from exc
            if (
                parsed.scheme != "http"
                or (parsed.hostname or "").lower() != expected_host
                or actual_port != expected_port
                or parsed.username
                or parsed.password
                or parsed.path not in {"", "/"}
                or parsed.query
                or parsed.fragment
            ):
                raise RequestError(HTTPStatus.FORBIDDEN, "Cross-site request refused.")

    def _security_headers(self, cache: str) -> None:
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Permissions-Policy",
            "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
        )

    def _json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._security_headers("no-store")
        self.end_headers()
        self.wfile.write(body)

    def _unexpected(self, exc: Exception) -> None:
        print(f"[toa-web] request failed: {type(exc).__name__}", file=sys.stderr)
        self._json({"error": "Internal server error."}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _empty(self, status: int = HTTPStatus.NO_CONTENT) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _body_length(self, limit: int) -> int:
        values = self.headers.get_all("Content-Length", [])
        if not values:
            raise RequestError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required.")
        if len(values) != 1:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Exactly one Content-Length header is required.")
        try:
            length = int(values[0])
        except ValueError as exc:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length.") from exc
        if length < 0 or length > limit:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload is too large.")
        return length

    def _read_json(self) -> Any:
        length = self._body_length(JSON_LIMIT)
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid JSON body.") from exc

    def _receive(self, directory: Path, limit: int, length: int | None = None) -> Path:
        length = self._body_length(limit) if length is None else length
        if length == 0:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Upload is empty.")
        directory.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(prefix=".upload-", suffix=".part", dir=directory, delete=False)
        path = Path(handle.name)
        remaining = length
        try:
            with handle:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise RequestError(HTTPStatus.BAD_REQUEST, "Upload ended early.")
                    handle.write(chunk)
                    remaining -= len(chunk)
            return path
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def _static(self, name: str, *, mike_mode: bool = False) -> None:
        path = WEB_DIR / name
        if not path.is_file():
            raise RequestError(HTTPStatus.NOT_FOUND, "Not found.")
        body = path.read_bytes()
        mode_class = b"mike-mode" if mike_mode else b"standalone-mode"
        body = body.replace(b'<html lang="en">', b'<html lang="en" class="' + mode_class + b'">', 1)
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._security_headers("no-cache")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; "
            "style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; "
            "frame-ancestors http://127.0.0.1:* http://localhost:*",
        )
        self.end_headers()
        self.wfile.write(body)

    def _download(self, job: Path, relative: str) -> None:
        if relative not in {row["path"] for row in _output_files(job)}:
            raise RequestError(HTTPStatus.FORBIDDEN, "This file is not downloadable.")
        path = _safe_child(job, relative)
        if not path.is_file():
            raise RequestError(HTTPStatus.NOT_FOUND, "File not found.")
        size = path.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self._security_headers("no-store")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(path.name)}")
        self.end_headers()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                self.wfile.write(chunk)

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._check_host()
            parsed = urlsplit(self.path)
            path = parsed.path
            if path in {"/", "/index.html"}:
                return self._static(
                    "index.html",
                    mike_mode=parse_qs(parsed.query).get("mode") == ["mike"],
                )
            if path in {"/app.js", "/styles.css", "/court-profiles.json"}:
                return self._static(path[1:])
            if path == "/favicon.ico":
                return self._empty()
            if path == "/api/status":
                return self._json(_dependency_status())
            if path == "/api/settings":
                settings = _read_json(self.state_root / "settings.json", DEFAULT_SETTINGS)
                return self._json(_validate_settings(settings))
            if path == "/api/jobs":
                project_id = _project_id(parse_qs(parsed.query))
                jobs = [
                    _job_public(item)
                    for item in sorted(
                        (self.state_root / "jobs").iterdir(),
                        key=lambda child: child.stat().st_mtime,
                        reverse=True,
                    )
                    if item.is_dir() and JOB_RE.fullmatch(item.name)
                ]
                if project_id:
                    jobs = [job for job in jobs if job.get("project_id") == project_id]
                return self._json({"jobs": jobs[:20]})
            match = re.fullmatch(r"/api/jobs/([0-9a-f]{32})(?:/(.*))?", path)
            if not match:
                raise RequestError(HTTPStatus.NOT_FOUND, "Not found.")
            job = _job_path(self.state_root, match.group(1))
            tail = match.group(2) or ""
            if not tail:
                return self._json(_job_public(job))
            if tail == "review":
                review = _read_json(job / "review.json", None)
                if review is None:
                    raise RequestError(HTTPStatus.CONFLICT, "Citation review is not ready.")
                return self._json(review)
            if tail == "files":
                return self._json({"files": _output_files(job)})
            if tail.startswith("files/"):
                return self._download(job, tail[6:])
            if tail == "manual":
                return self._json(_manual_public(job))
            if tail == "manifest":
                return self._json(_manifest_public(job))
            raise RequestError(HTTPStatus.NOT_FOUND, "Not found.")
        except RequestError as exc:
            self._json({"error": str(exc)}, exc.status)
        except Exception as exc:
            self._unexpected(exc)

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._check_host()
            self._check_write_origin()
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            path = parsed.path
            if path == "/api/jobs":
                filename = _clean_name(query.get("filename", [""])[0], "input.docx")
                length = self._body_length(PDF_LIMIT)
                project_id = _project_id(query)
                split_fallback = query.get("split_fallback", ["off"])[0]
                if split_fallback not in {"off", "auto"}:
                    raise RequestError(
                        HTTPStatus.BAD_REQUEST,
                        "split_fallback must be off or auto.",
                    )
                if length == 0:
                    job_id, job = _new_job(self.state_root, project_id=project_id)
                    return self._json(_job_public(job), HTTPStatus.CREATED)
                suffix = Path(filename).suffix.lower()
                if suffix not in {".docx", ".pdf"}:
                    raise RequestError(
                        HTTPStatus.BAD_REQUEST,
                        "Upload a Word document (.docx) or PDF.",
                    )
                limit = PDF_LIMIT if suffix == ".pdf" else DOCX_LIMIT
                if length > limit:
                    raise RequestError(
                        HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                        "Upload is too large.",
                    )
                temporary = self._receive(self.state_root / "incoming", limit, length)
                try:
                    (_validate_pdf if suffix == ".pdf" else _validate_docx)(temporary)
                    job_id, job = _new_job(self.state_root, filename, project_id)
                    input_document = job / f"input{suffix}"
                    temporary.replace(input_document)
                    _update_job(job, input_file=input_document.name)
                except Exception:
                    temporary.unlink(missing_ok=True)
                    raise
                review = job / "review.json"
                argv = _cli("detect", input_document, "--review", review, "--compact", "--progress")
                argv.extend(["--split-fallback", split_fallback])
                _update_job(job, split_fallback=split_fallback)
                settings = _validate_settings(
                    _read_json(self.state_root / "settings.json", DEFAULT_SETTINGS)
                )
                if settings["enrich_spans"]:
                    argv.append("--enrich-spans")
                if settings["offline"]:
                    argv.append("--offline")
                def require_review() -> None:
                    if not review.is_file():
                        raise RuntimeError("Detector did not write review JSON.")

                _start_process(job, "detection", argv, success=require_review)
                return self._json(_job_public(job), HTTPStatus.ACCEPTED)
            match = re.fullmatch(r"/api/jobs/([0-9a-f]{32})/(.+)", path)
            if not match:
                raise RequestError(HTTPStatus.NOT_FOUND, "Not found.")
            job = _job_path(self.state_root, match.group(1))
            action = match.group(2)
            if action == "review/action":
                return self._json(_review_action(job, self._read_json()))
            if action == "build":
                input_document = _input_document(job)
                if not (job / "review.json").is_file():
                    raise RequestError(
                        HTTPStatus.CONFLICT,
                        "Import and review a Word document or PDF first.",
                    )
                settings = _validate_settings(self._read_json())
                if input_document.suffix.lower() == ".pdf" and settings["output_mode"] != "book":
                    raise RequestError(
                        HTTPStatus.BAD_REQUEST,
                        "PDF documents can create a Book of Authorities only.",
                    )
                _update_job(job, output_mode=settings["output_mode"])
                build_directory = job / "outputs" / uuid.uuid4().hex[:12]
                build_directory.mkdir()
                argv = _cli(
                    "build",
                    input_document,
                    "--output",
                    build_directory,
                    "--review",
                    job / "review.json",
                    "--pdf-mode",
                    settings["pdf_mode"],
                    "--tab-style",
                    settings["tab_style"],
                    "--output-mode",
                    settings["output_mode"],
                    "--table-delivery",
                    settings["table_delivery"],
                    "--table-location",
                    settings["table_location"],
                    "--highlight-style",
                    settings["highlight_style"],
                    "--scanned-pdf-policy",
                    settings["scanned_pdf_policy"],
                    "--progress",
                )
                if settings["offline"]:
                    argv.append("--offline")
                _start_process(job, "build", argv)
                return self._json(_job_public(job), HTTPStatus.ACCEPTED)
            if action == "manual/files":
                filename = _clean_name(query.get("filename", [""])[0], "document.pdf")
                if not filename.lower().endswith(".pdf"):
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Upload a PDF file.")
                temporary = self._receive(job / "manual" / "files", PDF_LIMIT)
                try:
                    _validate_pdf(temporary)
                    file_id = uuid.uuid4().hex
                    target = job / "manual" / "files" / f"{file_id}.pdf"
                    temporary.replace(target)
                except Exception:
                    temporary.unlink(missing_ok=True)
                    raise
                state = _manual_public(job)
                title = re.sub(r"[_-]+", " ", Path(filename).stem).strip() or Path(filename).stem
                state["entries"].append(
                    {
                        "id": file_id,
                        "filename": filename,
                        "title": title,
                        "tab": f"Tab {len(state['entries']) + 1}",
                    }
                )
                _write_json(job / "manual" / "state.json", state)
                return self._json(state, HTTPStatus.CREATED)
            if action == "manual/build":
                state = _save_manual(job, self._read_json())
                if not state["entries"]:
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Add at least one PDF.")
                project = {
                    "book_title": state["book_title"],
                    "entries": [
                        {
                            "pdf_path": str(job / "manual" / "files" / f"{row['id']}.pdf"),
                            "title": row["title"],
                            "tab": row["tab"],
                        }
                        for row in state["entries"]
                    ],
                }
                project_path = job / "manual" / "project.json"
                _write_json(project_path, project)
                output = job / "manual" / "outputs" / f"{_slug(state['book_title'])}.pdf"
                _update_job(job, manual_output=str(output))
                _start_process(
                    job,
                    "manual book",
                    _cli("manual-book", project_path, "--output", output, "--progress"),
                )
                return self._json(_job_public(job), HTTPStatus.ACCEPTED)
            if action == "attach":
                authority_key = query.get("key", [""])[0]
                if not authority_key or len(authority_key) > 512 or any(ord(char) < 32 for char in authority_key):
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid authority key.")
                filename = _clean_name(query.get("filename", [""])[0], "authority.pdf")
                if not filename.lower().endswith(".pdf"):
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Upload a PDF file.")
                temporary = self._receive(job / "attachments", PDF_LIMIT)
                try:
                    _validate_pdf(temporary)
                    target = job / "attachments" / f"{uuid.uuid4().hex}.pdf"
                    temporary.replace(target)
                except Exception:
                    temporary.unlink(missing_ok=True)
                    raise
                _start_process(
                    job,
                    "PDF attachment",
                    _cli("attach-pdf", _manifest_path(job), authority_key, target),
                )
                return self._json(_job_public(job), HTTPStatus.ACCEPTED)
            if action == "finalize":
                payload = self._read_json()
                if not isinstance(payload, dict) or not isinstance(payload.get("omit_placeholders", False), bool):
                    raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid finalize settings.")
                argv = _cli("finalize-book", _manifest_path(job), "--progress")
                if payload.get("omit_placeholders"):
                    argv.append("--omit-placeholders")
                _start_process(job, "finalization", argv)
                return self._json(_job_public(job), HTTPStatus.ACCEPTED)
            raise RequestError(HTTPStatus.NOT_FOUND, "Not found.")
        except RequestError as exc:
            self._json({"error": str(exc)}, exc.status)
        except Exception as exc:
            self._unexpected(exc)

    def do_PUT(self) -> None:  # noqa: N802
        try:
            self._check_host()
            self._check_write_origin()
            path = urlsplit(self.path).path
            if path == "/api/settings":
                settings = _validate_settings(self._read_json())
                _write_json(self.state_root / "settings.json", settings)
                return self._json(settings)
            match = re.fullmatch(r"/api/jobs/([0-9a-f]{32})/(review|manual)", path)
            if not match:
                raise RequestError(HTTPStatus.NOT_FOUND, "Not found.")
            job = _job_path(self.state_root, match.group(1))
            payload = self._read_json()
            if match.group(2) == "manual":
                return self._json(_save_manual(job, payload))
            return self._json(_save_review_edits(job, payload))
        except RequestError as exc:
            self._json({"error": str(exc)}, exc.status)
        except Exception as exc:
            self._unexpected(exc)

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            self._check_host()
            self._check_write_origin()
            match = re.fullmatch(
                r"/api/jobs/([0-9a-f]{32})/manual/files/([0-9a-f]{32})",
                urlsplit(self.path).path,
            )
            if not match:
                raise RequestError(HTTPStatus.NOT_FOUND, "Not found.")
            job = _job_path(self.state_root, match.group(1))
            if job.name in _RUNNING:
                raise RequestError(HTTPStatus.CONFLICT, "Wait for the current job to finish.")
            file_id = match.group(2)
            state = _manual_public(job)
            state["entries"] = [row for row in state["entries"] if row["id"] != file_id]
            _write_json(job / "manual" / "state.json", state)
            (job / "manual" / "files" / f"{file_id}.pdf").unlink(missing_ok=True)
            return self._empty()
        except RequestError as exc:
            self._json({"error": str(exc)}, exc.status)
        except Exception as exc:
            self._unexpected(exc)


_MISSING = object()


class ToAProtocolRequest:
    """Adapt Beaver's private stdio transport to the canonical HTTP handlers."""

    def __init__(self, root: Path, inbox: Path, target: str, body: Any = _MISSING,
                 upload: str = ""):
        self.state_root = root.resolve()
        (self.state_root / "jobs").mkdir(parents=True, exist_ok=True)
        self.inbox = inbox
        self.path = target
        self.body = body
        self.upload = upload
        self.response: dict[str, Any] = {}

    def _check_host(self) -> None:
        pass

    def _check_write_origin(self) -> None:
        pass

    def _body_length(self, limit: int) -> int:
        size = self._upload_path().stat().st_size if self.upload else 0
        if size > limit:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload is too large.")
        return size

    def _read_json(self) -> Any:
        if self.body is _MISSING:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid JSON body.")
        return self.body

    def _upload_path(self) -> Path:
        path = Path(self.upload).resolve()
        if not path.is_file() or path.parent != self.inbox:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid upload.")
        return path

    def _receive(self, _directory: Path, limit: int, length: int | None = None) -> Path:
        path = self._upload_path()
        size = path.stat().st_size
        if not size:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Upload is empty.")
        if size > limit or (length is not None and size != length):
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload is too large.")
        return path

    def _json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        self.response = {"status": int(status), "body": payload}

    def _empty(self, status: int = HTTPStatus.NO_CONTENT) -> None:
        self.response = {"status": int(status)}

    def _download(self, job: Path, relative: str) -> None:
        if relative not in {row["path"] for row in _output_files(job)}:
            raise RequestError(HTTPStatus.FORBIDDEN, "This file is not downloadable.")
        path = _safe_child(job, relative)
        if not path.is_file():
            raise RequestError(HTTPStatus.NOT_FOUND, "File not found.")
        self.response = {
            "status": int(HTTPStatus.OK),
            "file": str(path),
            "name": path.name,
            "content_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        }

    def _unexpected(self, exc: Exception) -> None:
        print(f"[toa-plugin] request failed: {type(exc).__name__}", file=sys.stderr)
        self._json({"error": "Internal server error."}, HTTPStatus.INTERNAL_SERVER_ERROR)


def serve_stdio(root: Path, inbox: Path) -> int:
    """Serve the same handlers to Beaver without opening another server port."""
    root = root.resolve()
    inbox = inbox.resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / "jobs").mkdir(exist_ok=True)
    inbox.mkdir(parents=True, exist_ok=True)
    handlers = {
        "GET": ToAWebHandler.do_GET,
        "POST": ToAWebHandler.do_POST,
        "PUT": ToAWebHandler.do_PUT,
        "DELETE": ToAWebHandler.do_DELETE,
    }
    for raw in sys.stdin.buffer:
        request_id: Any = None
        upload = ""
        try:
            if len(raw) > JSON_LIMIT + 4096:
                raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request is too large.")
            message = json.loads(raw)
            if not isinstance(message, dict):
                raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid request.")
            request_id = message.get("id")
            method = message.get("method")
            target = message.get("path")
            upload = message.get("upload", "")
            scope = message.get("scope")
            if method not in handlers or not isinstance(target, str) or not target.startswith("/api/"):
                raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid request.")
            if (
                len(target) > 4096
                or "\r" in target
                or "\n" in target
                or not isinstance(upload, str)
                or not isinstance(scope, str)
                or not re.fullmatch(r"[0-9a-f]{64}", scope)
            ):
                raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid request.")
            adapter = ToAProtocolRequest(
                root / "beaver" / scope,
                inbox,
                target,
                message["body"] if "body" in message else _MISSING,
                upload,
            )
            handlers[method](adapter)  # type: ignore[arg-type]
            response = {"id": request_id, **adapter.response}
        except RequestError as exc:
            response = {"id": request_id, "status": int(exc.status), "body": {"error": str(exc)}}
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
            response = {"id": request_id, "status": 400, "body": {"error": "Invalid request."}}
        finally:
            if upload:
                try:
                    candidate = Path(upload).resolve()
                    if candidate.parent == inbox:
                        candidate.unlink(missing_ok=True)
                except OSError:
                    pass
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


def create_server(
    port: int = 8765,
    *,
    state_root: Path | None = None,
) -> ToAWebServer:
    os.umask(0o077)
    root = state_root or app_state("authorities-helper", create=True)
    return ToAWebServer(("127.0.0.1", port), root)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the AuthoritiesHelper browser/desktop UI.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--stdio", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--inbox", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.stdio:
        if args.inbox is None:
            parser.error("--stdio requires --inbox")
        os.umask(0o077)
        return serve_stdio(app_state("authorities-helper", create=True), args.inbox)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    server = create_server(args.port)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"AuthoritiesHelper: {url}", flush=True)
    print(f"Application data: {server.state_root}", flush=True)
    if not args.no_browser:
        threading.Timer(0.2, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

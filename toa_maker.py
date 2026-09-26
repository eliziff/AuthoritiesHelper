#!/usr/bin/env python3
"""Deterministic table-of-authorities and book-of-authorities builder.

The application is deliberately split into three small contracts:

* DOCX/OOXML and legal PDF extraction keep source text and offsets intact.
* A conservative detector proposes authority occurrences. An explicit optional
  fallback can send only unresolved citation units to the neutral legal-PDF
  engine's bounded, cached Codex splitter.
* A review JSON is the durable hand-off between the detector, the browser
  workspace, and the final A2AJ/book build.

Run ``python bootstrap.py`` for the correction workflow or ``python
toa_maker.py build INPUT.docx`` for a non-interactive build.
"""
from __future__ import annotations

import argparse
import bisect
import difflib
import hashlib
import html
import json
import math
import os
import re
import shutil
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from contextlib import nullcontext
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable, Optional
from urllib.parse import urljoin, urlparse

from document_delivery import append_pdf, export_docx_to_pdf
from grammar_tables import table_definition as _grammar_def
from grammar_tables import table_entry as _table
from shared_legal_data import (
    SharedA2AJCorpus,
    a2aj_status,
    provider_cache,
)


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MAX_OFFICE_XML_BYTES = 64 * 1024 * 1024
MAX_OFFICE_ENTRIES = 10_000
MAX_OFFICE_EXPANDED_BYTES = 512 * 1024 * 1024


def _office_xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    matches = [item for item in archive.infolist() if item.filename == name]
    if len(matches) != 1 or matches[0].file_size > MAX_OFFICE_XML_BYTES:
        raise ValueError(f"Invalid or oversized Office XML part: {name}")
    data = archive.read(matches[0])
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", data, re.I):
        raise ValueError(f"Office XML declarations are not allowed: {name}")
    return ET.fromstring(data)


def _tag(name: str, namespace: str = W_NS) -> str:
    return "{%s}%s" % (namespace, name)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _validate_office_archive(archive: zipfile.ZipFile) -> None:
    infos = [item for item in archive.infolist() if not item.is_dir()]
    names = [item.filename.replace("\\", "/") for item in infos]
    folded = [name.casefold() for name in names]
    unsafe_name = any(
        name != item.filename
        or name.startswith("/")
        or any(part in {"", ".", ".."} for part in name.split("/"))
        for item, name in zip(infos, names)
    )
    if (
        len(infos) > MAX_OFFICE_ENTRIES
        or sum(item.file_size for item in infos) > MAX_OFFICE_EXPANDED_BYTES
        or any(item.flag_bits & 1 for item in infos)
        or unsafe_name
        or len(set(folded)) != len(folded)
        or folded.count("word/document.xml") != 1
    ):
        raise ValueError("Office document archive is invalid or exceeds extraction limits")
    if any(
        "/embeddings/" in f"/{name}"
        or "/activex/" in f"/{name}"
        or name.endswith("/vbaproject.bin")
        for name in folded
    ):
        raise ValueError("Office document contains active or embedded content")
    for item, name in zip(infos, folded):
        if not name.endswith(".rels"):
            continue
        for relation in _office_xml(archive, item.filename).iter():
            if _local(relation.tag) != "Relationship" or relation.get("TargetMode") != "External":
                continue
            target, kind = relation.get("Target", ""), relation.get("Type", "")
            if not kind.endswith("/hyperlink") or urlparse(target).scheme.lower() not in {
                "http", "https", "mailto"
            }:
                raise ValueError("Office document contains an active external relationship")
    document = _office_xml(archive, "word/document.xml")
    instructions = "".join(
        node.text or "" for node in document.iter() if _local(node.tag) == "instrText"
    )
    instructions = re.sub(r"\s+", "", instructions)
    if any(_local(node.tag) == "altChunk" for node in document.iter()) or re.search(
        r"DDEAUTO|INCLUDETEXT|INCLUDEPICTURE", instructions, re.I
    ):
        raise ValueError("Office document contains active linked content")


def _normal_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _clean_citation(value: str) -> str:
    return _normal_space(value).strip(" ,;:").rstrip(".").strip()


@lru_cache(maxsize=4096)
def _citation_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(
        r"\s+at\s+(?:(?:para(?:graphs?)?|pp?|pages?|sections?|ss?|rules?|rr?)\.?\s*)?\d.*$",
        "",
        value,
        flags=re.I,
    )
    value = re.sub(r"\s*,\s*(?:s(?:ection)?s?|ss?\.?|r(?:ules?)?|rr?\.?)\s+\d[\w().,\-\s]*$", "", value, flags=re.I)
    value = value.replace("–", "-").replace("—", "-")
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


# These corpus patterns are intentionally narrow routing evidence.
_URL_RE = _table("cite.url")
_NEUTRAL_RE = _table("cite.neutral")
_CANLII_RE = _table("cite.canlii")
_REPORTER_RE = _table("cite.reporter.toa")
_STATUTE_RE = _table("cite.statute.toa")
_JOURNAL_RE = _table("cite.journal.toa")
_US_REPORTER_RES = tuple(
    _table(entry_id)
    for entry_id in (
        "cite.us.reporter.full",
        "cite.us.reporter.short",
        "cite.us.reporter.custom.full",
        "cite.us.reporter.custom.short",
    )
)
_US_STATUTE_RES = tuple(
    _table(entry_id)
    for entry_id in ("cite.us.law.full", "cite.us.law.short")
)
_US_JOURNAL_RES = tuple(
    _table(entry_id)
    for entry_id in ("cite.us.journal.full", "cite.us.journal.short")
)
_LEGAL_TITLE_RE = _table("title.legal.toa")
_REFERENCE_RE = _table("ref.pure.toa")
_SOURCE_SIGNAL_RE = _table("signal.source")
_CITATION_SIGNAL_RE = _table("signal.citation.toa")
_SIGNAL_PREFIX_RE = _table("signal.prefix.toa")
_REFERENCE_WORD_RE = _table("ref.token")
_INLINE_REFERENCE_RE = _table("ref.inline.toa")
_PINPOINT_VALUE = _grammar_def("pinpoints", "pin_item_toa")
_PINPOINT_VALUE_RE = re.compile(_PINPOINT_VALUE)
_PAR_RE = _table("pinpoint.para.toa")
_SECTION_RE = _table("pinpoint.section.toa")
_PAGE_RE = _table("pinpoint.page.toa")
_HISTORY_RE = _table("ref.history.toa")
_SHORT_FORM_SUFFIX_RE = _table("shortform.toa")
_BLOCK_BREAK_RE = re.compile(r"\n\s*\n")


def _paragraph_blocks(text: str) -> Iterable[str]:
    start = 0
    for match in _BLOCK_BREAK_RE.finditer(text):
        block = text[start:match.start()].strip()
        if block:
            yield block
        start = match.end()
    block = text[start:].strip()
    if block:
        yield block


def _xml_safe(text: str) -> str:
    """Remove control characters that OOXML cannot represent."""
    return "".join(
        character
        for character in text
        if character in "\t\n\r"
        or 0x20 <= ord(character) <= 0xD7FF
        or 0xE000 <= ord(character) <= 0xFFFD
        or 0x10000 <= ord(character) <= 0x10FFFF
    )


def _write_json(path: Path, payload: Any, *, indent: Optional[int] = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.part")
    try:
        with partial.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                indent=indent,
                separators=(",", ":") if indent is None else None,
            )
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


@dataclass(frozen=True)
class DeterministicPart:
    start: int
    end: int
    text: str
    anchors: tuple[str, ...] = ()


@dataclass(frozen=True)
class DeterministicSplit:
    status: str
    parts: tuple[DeterministicPart, ...] = ()
    delimiters: tuple[tuple[int, int, str], ...] = ()
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class DeterministicFields:
    status: str
    corrected: str
    kind: str
    link_candidate: str
    pinpoint_fragments: tuple[str, ...]
    page_pinpoints: tuple[int, ...]
    bare_citation: str
    citation_with_style: str
    short_form: str
    anchors: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()


def _masked_ranges(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in _URL_RE.finditer(text)]


def _source_signal_start(match: re.Match[str]) -> int:
    return match.start("sentence") if match.group("sentence") else match.start("inline")


def _top_level_positions(text: str) -> set[int]:
    candidates = {_source_signal_start(match) for match in _SOURCE_SIGNAL_RE.finditer(text)}
    candidates.update(index for index, character in enumerate(text) if character == ";")
    masked = _masked_ranges(text)
    positions: set[int] = set()
    round_depth = square_depth = curly_depth = 0
    smart_quote = False
    straight_quote = False
    mask_index = 0
    for i, ch in enumerate(text):
        while mask_index < len(masked) and i >= masked[mask_index][1]:
            mask_index += 1
        if mask_index < len(masked) and masked[mask_index][0] <= i < masked[mask_index][1]:
            continue
        if i in candidates and not smart_quote and not straight_quote and not (round_depth or square_depth or curly_depth):
            positions.add(i)
        if ch == "“":
            smart_quote = True
        elif ch == "”":
            smart_quote = False
        elif ch == '"':
            straight_quote = not straight_quote
        elif not smart_quote and not straight_quote:
            if ch == "(":
                round_depth += 1
            elif ch == ")" and round_depth:
                round_depth -= 1
            elif ch == "[":
                square_depth += 1
            elif ch == "]" and square_depth:
                square_depth -= 1
            elif ch == "{":
                curly_depth += 1
            elif ch == "}" and curly_depth:
                curly_depth -= 1
    return positions


def _anchor_spans(text: str) -> list[tuple[int, int, str]]:
    found: list[tuple[int, int, str]] = []
    for kind, pattern in (
        ("statute", _STATUTE_RE),
        *(("statute", pattern) for pattern in _US_STATUTE_RES),
        ("neutral", _NEUTRAL_RE),
        ("canlii", _CANLII_RE),
        ("reporter", _REPORTER_RE),
        *(("reporter", pattern) for pattern in _US_REPORTER_RES),
        ("journal", _JOURNAL_RE),
        *(("journal", pattern) for pattern in _US_JOURNAL_RES),
        ("url", _URL_RE),
    ):
        found.extend((m.start(), m.end(), kind) for m in pattern.finditer(text))
    found.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    out: list[tuple[int, int, str]] = []
    for item in found:
        if out and item[0] < out[-1][1]:
            continue
        out.append(item)
    return out


def _strip_signals(text: str) -> str:
    value = text.strip()
    for _ in range(4):
        new = _SIGNAL_PREFIX_RE.sub("", value).strip()
        if new == value:
            break
        value = new
    return value


def _kind(text: str, anchors: tuple[str, ...]) -> str:
    if _REFERENCE_RE.fullmatch(text):
        return "reference"
    if "statute" in anchors or _LEGAL_TITLE_RE.search(text):
        return "statute"
    if "neutral" in anchors or "canlii" in anchors or "reporter" in anchors:
        return "case"
    if "journal" in anchors:
        return "journal"
    if "url" in anchors:
        return "other"
    return "other"


def _bare_citation(text: str, kind: str, spans: list[tuple[int, int, str]]) -> str:
    value = text.strip().rstrip(".").strip()
    if kind == "reference":
        return value
    preferred = [item for item in spans if item[2] in {"statute", "neutral", "canlii", "reporter", "journal"}]
    if preferred:
        return value[min(item[0] for item in preferred):].strip(" ,;.")
    return value


_CASE_LEFT_RE = re.compile(
    r"([A-Z][A-Za-z0-9’'&().-]*(?:\s+(?:[A-Z][A-Za-z0-9’'&().-]*|"
    r"\([A-Z][A-Za-z0-9’'&().-]*\)|of|the|and|de|la|du)){0,12})\s*$"
)


def _case_name_start(text: str, anchor_start: int, floor: int = 0) -> int:
    prefix = text[floor:anchor_start].rstrip(" ,")
    matches = list(re.finditer(r"\bv\.?\s+", prefix, re.I))
    if not matches:
        return anchor_start
    left = prefix[:matches[-1].start()]
    match = _CASE_LEFT_RE.search(left)
    return floor + match.start(1) if match else anchor_start


def _journal_name_start(text: str, anchor_start: int, floor: int = 0) -> int:
    """Keep the author and article title, but not prose introducing the source."""
    prefix = text[floor:anchor_start]
    quote_positions = [position for mark in ('“', '"') if (position := prefix.find(mark)) >= 0]
    signal_limit = min(quote_positions) if quote_positions else len(prefix)
    signals = list(_CITATION_SIGNAL_RE.finditer(prefix[:signal_limit]))
    if not signals:
        return floor
    start = floor + signals[-1].end()
    while start < anchor_start and (text[start].isspace() or text[start] in ",:"):
        start += 1
    return start


def _short_form(value: str, kind: str, spans: list[tuple[int, int, str]]) -> str:
    if spans:
        anchor_start = min(item[0] for item in spans)
        if kind == "case":
            case_start = _case_name_start(value, anchor_start)
            if case_start < anchor_start:
                return value[case_start:anchor_start].strip(" ,;:.")
            explicit_short_form = re.search(r"\[([^\]]{2,70})\]\.??$", value)
            if explicit_short_form and not explicit_short_form.group(1).isdigit():
                return explicit_short_form.group(1).strip()
            # In a bare reporter citation, a bracketed year can sit before
            # the reporter anchor. It is citation data, not a case name.
            return ""
        prefix = value[:anchor_start].strip(" ,;:.")
        if prefix and kind in {"case", "journal", "statute"}:
            if kind == "journal":
                signals = list(_CITATION_SIGNAL_RE.finditer(prefix))
                if signals:
                    prefix = prefix[signals[-1].end():].strip(" ,;:.")
            return prefix if len(prefix) <= 160 and not re.search(r"[.!?]\s", prefix) else ""
    match = re.search(r"\[([^\]]{2,70})\]\.??$", value)
    if match and not match.group(1).isdigit():
        return match.group(1).strip()
    if re.search(r"\bibid\b", value, re.I):
        return "Ibid"
    if re.search(r"\bsupra\b", value, re.I):
        return value.split("supra", 1)[0].strip(" ,;:.")
    return ""


def _pinpoints(text: str, kind: str) -> tuple[tuple[str, ...], tuple[int, ...]]:
    if kind in {"case", "reference", "other"}:
        match = _PAR_RE.search(text)
        if match:
            values = _PINPOINT_VALUE_RE.findall(match.group(1))
            return tuple("par" + value for value in values), ()
    if kind in {"statute", "reference", "other"}:
        match = _SECTION_RE.search(text)
        if match:
            values = _PINPOINT_VALUE_RE.findall(match.group(1))
            return tuple("sec" + value for value in values), ()
    match = _PAGE_RE.search(text)
    if match:
        value = match.group(1)
        page_range = re.fullmatch(r"\s*(\d+)\s*(?:to|[-\u2013\u2014])\s*(\d+)\s*", value, re.I)
        if page_range:
            first, last = map(int, page_range.groups())
            if first < 1 or last < first or last - first > 1000:
                return (), ()
            values = list(range(first, last + 1))
        else:
            values = [int(item) for item in re.findall(r"\d+", value) if int(item) > 0]
        return (), tuple(values)
    return (), ()


def _authority_bounds(text: str) -> tuple[int, int]:
    """Return the primary-authority span, excluding signals and pinpoints."""
    start, end = 0, len(text)
    while start < end and text[start].isspace():
        start += 1
    while end > start and (text[end - 1].isspace() or text[end - 1] in ".;,"):
        end -= 1
    for _ in range(4):
        match = _SIGNAL_PREFIX_RE.match(text[start:end])
        if not match:
            break
        start += match.end()
        while start < end and text[start].isspace():
            start += 1
    reference = _INLINE_REFERENCE_RE.search(text, start, end)
    first_anchor = next(iter(_anchor_spans(text[start:end])), None)
    if reference and (first_anchor is None or reference.start() < start + first_anchor[0]):
        reference_end = reference.end()
        while reference_end > reference.start() and text[reference_end - 1] in ".;,":
            reference_end -= 1
        return reference.start(), reference_end
    if first_anchor is not None:
        anchor_start, anchor_end, anchor_kind = first_anchor
        authority_start = start + anchor_start
        if anchor_kind in {"neutral", "canlii", "reporter"}:
            authority_start = _case_name_start(text, authority_start, start)
        elif anchor_kind == "journal":
            authority_start = _journal_name_start(text, authority_start, start)
        elif anchor_kind == "statute":
            prefix = text[start:authority_start]
            titles = list(_LEGAL_TITLE_RE.finditer(prefix))
            if titles and not prefix[titles[-1].end():].strip(" ,"):
                authority_start = start + titles[-1].start()
                signal = _SIGNAL_PREFIX_RE.match(text[authority_start:start + anchor_start])
                if signal:
                    authority_start += signal.end()
        return authority_start, start + anchor_end
    history = _HISTORY_RE.search(text, start, end)
    if history:
        end = history.start()
    else:
        short_form = _SHORT_FORM_SUFFIX_RE.search(text, start, end)
        if short_form:
            end = short_form.start()
    while end > start and (text[end - 1].isspace() or text[end - 1] in ".;,"):
        end -= 1
    kind = _kind(text[start:end], tuple(item[2] for item in _anchor_spans(text[start:end])))
    patterns = [_PAGE_RE]
    if kind in {"case", "reference", "other"}:
        patterns.append(_PAR_RE)
    if kind in {"statute", "reference", "other"}:
        patterns.append(_SECTION_RE)
    pinpoint_starts = []
    for pattern in patterns:
        for match in pattern.finditer(text, start, end):
            if text[match.end():end].strip(" .;,"):
                continue
            pinpoint_start = match.start()
            prefix = text[start:pinpoint_start]
            at = re.search(r"(?:,\s*)?\bat\s*$", prefix, re.I)
            comma = re.search(r",\s*$", prefix)
            if at:
                pinpoint_start = start + at.start()
            elif comma:
                pinpoint_start = start + comma.start()
            pinpoint_starts.append(pinpoint_start)
    if pinpoint_starts:
        end = min(pinpoint_starts)
        while end > start and (text[end - 1].isspace() or text[end - 1] in ".;,"):
            end -= 1
    return start, end


def _fields_for_authority(authority_text: str, occurrence_text: str, anchors: tuple[str, ...] = ()) -> DeterministicFields:
    text = authority_text.strip()
    styled = _strip_signals(text)
    spans = _anchor_spans(styled)
    anchor_types = tuple(item[2] for item in spans)
    kind = _kind(styled, anchor_types or anchors)
    pinpoints, pages = _pinpoints(occurrence_text, kind)
    direct = _URL_RE.search(text)
    link = direct.group(0).strip("<>.,; ") if direct else ""
    bare = _bare_citation(styled, kind, spans)
    reasons: list[str] = []
    if not bare:
        reasons.append("missing_bare_citation")
    if kind == "other" and not link:
        reasons.append("unsupported_source_shape")
    short_form = _short_form(styled, kind, spans)
    if not short_form:
        occurrence = _strip_signals(occurrence_text)
        short_form = _short_form(occurrence, kind, _anchor_spans(occurrence))
    return DeterministicFields(
        "complete" if not reasons else "partial",
        text,
        kind,
        link,
        pinpoints,
        pages,
        bare,
        styled,
        short_form,
        anchors,
        tuple(reasons),
    )


def extract_fields(part: DeterministicPart) -> DeterministicFields:
    start, end = _authority_bounds(part.text)
    return _fields_for_authority(part.text[start:end], part.text, tuple(part.anchors))


def extract_text_fields(text: str) -> DeterministicFields:
    value = str(text or "")
    part = DeterministicPart(0, len(value), value, tuple(item[2] for item in _anchor_spans(value)))
    return extract_fields(part)


def split_citations(text: str) -> DeterministicSplit:
    """Split only at top-level, source-supported boundaries.

    This is the compact version of the reference project's deterministic
    splitter. It preserves offsets and returns a partial result when a
    delimiter leaves residue that is not itself a citation.
    """
    if not isinstance(text, str) or not text.strip():
        return DeterministicSplit("abstain", reasons=("empty",))

    evidence_cache: dict[tuple[int, int], tuple[tuple[str, ...], bool]] = {}

    def evidence(start: int, end: int) -> tuple[tuple[str, ...], bool]:
        key = start, end
        cached = evidence_cache.get(key)
        if cached is not None:
            return cached
        value = text[start:end]
        spans = _anchor_spans(value)
        reference = bool(_REFERENCE_RE.fullmatch(value))
        anchors = ("reference",) if reference else tuple(item[2] for item in spans)
        result = anchors, bool(spans or reference or _REFERENCE_WORD_RE.search(value))
        evidence_cache[key] = result
        return result

    top = _top_level_positions(text)
    boundaries: list[tuple[int, int, str]] = [
        (i, i + 1, "top_level_semicolon") for i, ch in enumerate(text) if ch == ";" and i in top
    ]
    hard = sorted({0, len(text), *(right for _left, right, _reason in boundaries)})
    for match in _SOURCE_SIGNAL_RE.finditer(text):
        pos = _source_signal_start(match)
        if pos not in top:
            continue
        hard_index = bisect.bisect_left(hard, pos)
        left = hard[hard_index - 1] if hard_index else hard[0]
        right = hard[hard_index] if hard_index < len(hard) else hard[-1]
        if pos > left and evidence(left, pos)[1] and evidence(pos, right)[1]:
            cut = pos
            while cut > left and text[cut - 1].isspace():
                cut -= 1
            if cut > left and text[cut - 1] == ",":
                cut -= 1
            boundaries.append((cut, pos, "explicit_source_signal"))
    boundaries = sorted(set(boundaries))
    if not boundaries:
        p = _trim_part(0, len(text), text)
        if p is None:
            return DeterministicSplit("abstain", reasons=("no_supported_boundary",))
        anchors, supported = evidence(p.start, p.end)
        if not supported:
            return DeterministicSplit("abstain", reasons=("no_supported_boundary",))
        p = DeterministicPart(p.start, p.end, p.text, anchors)
        return DeterministicSplit("deterministic_complete", (p,), reasons=("single_source",))

    parts: list[DeterministicPart] = []
    residue = False
    start = 0
    for cut, next_start, _reason in boundaries:
        part = _trim_part(start, cut, text)
        start = next_start
        if part is None:
            continue
        anchors, supported = evidence(part.start, part.end)
        candidate = DeterministicPart(part.start, part.end, part.text, anchors)
        if supported:
            parts.append(candidate)
        else:
            residue = True
    part = _trim_part(start, len(text), text)
    if part is not None:
        anchors, supported = evidence(part.start, part.end)
        candidate = DeterministicPart(part.start, part.end, part.text, anchors)
        if supported:
            parts.append(candidate)
        else:
            residue = True
    if not parts:
        return DeterministicSplit("abstain", reasons=("no_source_parts",))
    delimiters = tuple(
        (parts[i].end, parts[i + 1].start, text[parts[i].end:parts[i + 1].start])
        for i in range(len(parts) - 1)
    )
    reasons = tuple(dict.fromkeys(reason for _left, _right, reason in boundaries))
    if residue:
        reasons = (*reasons, "unresolved_residue")
    return DeterministicSplit("deterministic_partial" if residue else "deterministic_complete", tuple(parts), delimiters, reasons)


def _trim_part(start: int, end: int, text: str) -> DeterministicPart | None:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return DeterministicPart(start, end, text[start:end]) if start < end else None


@dataclass
class TextUnit:
    key: str
    kind: str
    ordinal: int
    footnote_id: Optional[int]
    text: str
    footnote_refs: list[tuple[int, int]] = field(default_factory=list)


@dataclass
class ReviewPart:
    unit_key: str
    index: int
    start: int
    end: int
    text: str
    split_status: str
    split_reasons: list[str]
    kind: str
    anchors: list[str]
    bare_citation: str
    citation: str
    short_form: str
    pinpoint_fragments: list[str]
    page_pinpoints: list[int]
    link_candidate: str
    supra_target: str = ""
    reviewed: bool = False
    uid: str = ""
    authority_start: int = -1
    authority_end: int = -1
    note_number: Optional[int] = None
    pinpoint_start: int = -1
    pinpoint_end: int = -1
    resolved_name: str = ""

    @property
    def part_id(self) -> str:
        return self.uid or f"{self.unit_key}:{self.index}"

    @property
    def footnote_id(self) -> Optional[int]:
        if self.note_number is not None:
            return self.note_number
        if self.unit_key.startswith("footnote:"):
            try:
                return int(self.unit_key.split(":", 1)[1])
            except ValueError:
                return None
        return None

    @property
    def authority_text(self) -> str:
        if self.start <= self.authority_start < self.authority_end <= self.end:
            return self.text[self.authority_start - self.start:self.authority_end - self.start]
        return self.citation or self.text


@dataclass
class ReviewState:
    input_path: str
    units: list[TextUnit]
    parts: list[ReviewPart]
    created_at: str
    version: int = 3
    split_fallback: dict[str, Any] = field(default_factory=dict)

    def renumber(self) -> None:
        grouped: dict[str, list[ReviewPart]] = defaultdict(list)
        for part in self.parts:
            grouped[part.unit_key].append(part)
        old_to_new: dict[str, str] = {}
        for unit_key, items in grouped.items():
            for index, part in enumerate(sorted(items, key=lambda p: p.start), 1):
                old_id = f"{unit_key}:{part.index}"
                part.index = index
                if not part.uid:
                    part.uid = f"{unit_key}:p{index}"
                old_to_new[old_id] = part.part_id
        for part in self.parts:
            if part.supra_target in old_to_new:
                part.supra_target = old_to_new[part.supra_target]

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "input_path": self.input_path,
            "created_at": self.created_at,
            "units": [vars(unit).copy() for unit in self.units],
            "parts": [vars(part).copy() for part in self.parts],
            "split_fallback": self.split_fallback,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ReviewState":
        units = [TextUnit(**item) for item in payload.get("units", [])]
        parts = [ReviewPart(**item) for item in payload.get("parts", [])]
        state = cls(
            str(payload.get("input_path") or ""),
            units,
            parts,
            str(payload.get("created_at") or ""),
            max(3, int(payload.get("version", 1))),
            (
                dict(payload.get("split_fallback") or {})
                if isinstance(payload.get("split_fallback"), dict)
                else {}
            ),
        )
        units_by_key = {unit.key: unit for unit in units}
        for part in parts:
            unit = units_by_key.get(part.unit_key)
            if part.note_number is None and unit:
                part.note_number = unit.footnote_id
            if part.authority_start < part.start or part.authority_end > part.end or part.authority_start >= part.authority_end:
                if unit:
                    local_start, local_end = _authority_bounds(part.text)
                    _set_authority_span(part, unit, part.start + local_start, part.start + local_end)
        state.renumber()
        return state

    def save(self, path: str | Path, *, compact: bool = False) -> None:
        path = Path(path)
        _write_json(path, self.to_dict(), indent=None if compact else 2)

    @classmethod
    def load(cls, path: str | Path) -> "ReviewState":
        with Path(path).open(encoding="utf-8") as handle:
            return cls.from_dict(json.load(handle))


def _part_from(unit: TextUnit, index: int, split_status: str, reasons: Iterable[str], part: DeterministicPart) -> ReviewPart:
    fields = extract_fields(part)
    authority_start, authority_end = _authority_bounds(part.text)
    return ReviewPart(
        unit.key,
        index,
        part.start,
        part.end,
        part.text,
        split_status,
        list(reasons),
        fields.kind,
        list(fields.anchors),
        fields.bare_citation,
        fields.citation_with_style,
        fields.short_form,
        list(fields.pinpoint_fragments),
        list(fields.page_pinpoints),
        fields.link_candidate,
        authority_start=part.start + authority_start,
        authority_end=part.start + authority_end,
        note_number=unit.footnote_id,
    )


def _set_authority_span(part: ReviewPart, unit: TextUnit, start: int, end: int) -> None:
    while start < end and unit.text[start].isspace():
        start += 1
    while end > start and unit.text[end - 1].isspace():
        end -= 1
    if not (0 <= start < end <= len(unit.text)):
        raise ValueError("Select authority text from the displayed footnote.")
    has_manual_pinpoint = 0 <= part.pinpoint_start < part.pinpoint_end <= len(unit.text)
    if has_manual_pinpoint and start < part.pinpoint_end and end > part.pinpoint_start:
        raise ValueError("The authority cannot overlap the selected pinpoint.")
    part.start = min(part.start, start)
    part.end = max(part.end, end)
    part.text = unit.text[part.start:part.end]
    fields = _fields_for_authority(
        unit.text[start:end],
        part.text,
        tuple(item[2] for item in _anchor_spans(unit.text[start:end])),
    )
    part.authority_start = start
    part.authority_end = end
    part.kind = fields.kind
    part.anchors = list(fields.anchors)
    part.bare_citation = fields.bare_citation
    part.citation = fields.citation_with_style
    part.short_form = fields.short_form
    if not has_manual_pinpoint:
        part.pinpoint_fragments = list(fields.pinpoint_fragments)
        part.page_pinpoints = list(fields.page_pinpoints)
    part.link_candidate = fields.link_candidate
    part.reviewed = True


def _set_pinpoint_span(part: ReviewPart, unit: TextUnit, start: int, end: int) -> None:
    while start < end and unit.text[start].isspace():
        start += 1
    while end > start and unit.text[end - 1].isspace():
        end -= 1
    if not (0 <= start < end <= len(unit.text)):
        raise ValueError("Select pinpoint text from the displayed footnote.")
    if start < part.authority_end and end > part.authority_start:
        raise ValueError("The pinpoint cannot overlap the primary authority.")
    part.start = min(part.start, start)
    part.end = max(part.end, end)
    part.text = unit.text[part.start:part.end]
    selected = unit.text[start:end]
    fragments, pages = _pinpoints(selected, part.kind)
    part.pinpoint_fragments = list(fragments) or ([] if pages else [selected])
    part.page_pinpoints = list(pages)
    part.pinpoint_start = start
    part.pinpoint_end = end
    part.reviewed = True


def _universal_engine_src() -> Path:
    configured = os.environ.get("LEGALPDF_ENGINE_DIR", "").strip()
    engine_root = Path(__file__).resolve().parent.parent / "legal-pdf-parser"
    candidates = [
        Path(configured).expanduser().resolve() / "src" if configured else None,
        Path(configured).expanduser().resolve() if configured else None,
        engine_root / "src",
    ]
    for candidate in candidates:
        if candidate and (candidate / "legalpdf" / "__init__.py").is_file():
            value = str(candidate)
            if value not in sys.path:
                sys.path.insert(0, value)
            return candidate
    raise RuntimeError(
        "The legal PDF parser is unavailable. "
        "Set LEGALPDF_ENGINE_DIR or place it beside AuthoritiesHelper."
    )


def _universal_split_planner() -> Callable[..., dict[str, Any]]:
    """Load the neutral splitter only when the caller explicitly requests it."""
    _universal_engine_src()
    try:
        from legalpdf.docx_linking import plan_footnotes
    except ImportError as exc:
        raise RuntimeError(
            "The legal PDF splitter is unavailable. "
            "Run detection with --split-fallback off."
        ) from exc
    return plan_footnotes


def _fallback_part(
    unit: TextUnit,
    index: int,
    raw: dict[str, Any],
    reasons: Iterable[str],
    cursor: int,
) -> tuple[ReviewPart, int]:
    verbatim = str(raw.get("verbatim") or "")
    # The universal splitter guarantees ordered, non-overlapping exact
    # substrings; retaining a local cursor handles repeated short forms.
    start = unit.text.find(verbatim, cursor)
    if start < 0:
        raise ValueError("Universal splitter returned text outside its citation unit.")
    end = start + len(verbatim)
    deterministic = DeterministicPart(
        start,
        end,
        verbatim,
        tuple(item[2] for item in _anchor_spans(verbatim)),
    )
    part = _part_from(
        unit,
        index,
        "codex_fallback" if raw.get("route") == "codex" else "universal_deterministic",
        [*reasons, "universal_cached_splitter"],
        deterministic,
    )
    kind = str(raw.get("kind") or "")
    if kind:
        part.kind = kind
    part.bare_citation = str(raw.get("bare_citation") or part.bare_citation)
    part.citation = str(raw.get("citation_with_style") or part.citation)
    part.short_form = str(raw.get("short_form") or part.short_form)
    part.pinpoint_fragments = [
        str(value) for value in raw.get("pinpoint_fragments", []) if str(value)
    ]
    part.page_pinpoints = [
        int(value)
        for value in raw.get("page_pinpoints", [])
        if isinstance(value, int) and value > 0
    ]
    return part, end


def review_document(
    path: str | Path,
    *,
    split_fallback: str = "off",
    split_model: str = "gpt-5.6-sol",
    split_effort: str = "none",
    split_planner: Optional[Callable[..., dict[str, Any]]] = None,
) -> ReviewState:
    if split_fallback not in {"off", "auto"}:
        raise ValueError("split_fallback must be off or auto")
    units = extract_source_units(path)
    parts: list[ReviewPart] = []
    ambiguous: list[tuple[TextUnit, DeterministicSplit]] = []
    for unit in units:
        split = split_citations(unit.text)
        fallback_evidence = bool(
            split.parts
            or _anchor_spans(unit.text)
            or _REFERENCE_WORD_RE.search(unit.text)
        )
        if (
            split_fallback == "auto"
            and split.status != "deterministic_complete"
            and fallback_evidence
        ):
            ambiguous.append((unit, split))
            continue
        if split.status == "abstain" or not split.parts:
            continue
        for index, item in enumerate(split.parts, 1):
            parts.append(_part_from(unit, index, split.status, split.reasons, item))
    fallback_audit: dict[str, Any] = {
        "requested": split_fallback,
        "eligible_units": len(ambiguous),
        "model": split_model if split_fallback == "auto" else "",
        "effort": split_effort if split_fallback == "auto" else "",
        "strategy": "deterministic_only",
        "codex_batches": 0,
        "live_codex_batches": 0,
        "token_usage": {},
    }
    if ambiguous:
        planner = split_planner or _universal_split_planner()
        plan = planner(
            [
                {
                    "id": unit.key,
                    "label": str(unit.footnote_id or unit.ordinal),
                    "text": unit.text,
                    "proposition": "",
                }
                for unit, _split in ambiguous
            ],
            strategy="hybrid",
            model=split_model,
            effort=split_effort,
        )
        planned_by_id = {
            str(item.get("id") or ""): item
            for item in plan.get("footnotes", [])
            if isinstance(item, dict)
        }
        for unit, split in ambiguous:
            planned = planned_by_id.get(unit.key)
            if not planned:
                raise ValueError(
                    f"Universal splitter omitted citation unit {unit.key}."
                )
            cursor = 0
            for index, raw in enumerate(planned.get("parts", []), 1):
                if not isinstance(raw, dict):
                    raise ValueError("Universal splitter returned an invalid part.")
                part, cursor = _fallback_part(
                    unit,
                    index,
                    raw,
                    split.reasons,
                    cursor,
                )
                parts.append(part)
        telemetry = (
            plan.get("telemetry")
            if isinstance(plan.get("telemetry"), dict)
            else {}
        )
        fallback_audit = {
            **fallback_audit,
            "strategy": str(plan.get("strategy_used") or "hybrid"),
            "codex_batches": int(telemetry.get("codex_batches") or 0),
            "live_codex_batches": int(telemetry.get("live_codex_batches") or 0),
            "token_usage": (
                dict(telemetry.get("token_usage") or {})
                if isinstance(telemetry.get("token_usage"), dict)
                else {}
            ),
        }
    review = ReviewState(
        str(Path(path).resolve()),
        units,
        parts,
        datetime.now(timezone.utc).isoformat(),
        split_fallback=fallback_audit,
    )
    review.renumber()
    _infer_reference_links(review)
    return review


def _normalized_token_spans(value: str) -> list[tuple[str, int, int]]:
    return [
        (
            unicodedata.normalize("NFKD", match.group(0)).casefold().rstrip("."),
            match.start(),
            match.end(),
        )
        for match in re.finditer(r"[\w’'-]+\.?", value)
    ]


def _resolved_name_span(text: str, name: str) -> Optional[tuple[int, int]]:
    source = _normalized_token_spans(text)
    wanted = [token for token, _start, _end in _normalized_token_spans(name)]
    if not wanted or len(wanted) > len(source):
        return None
    for index in range(len(source) - len(wanted) + 1):
        if [token for token, _start, _end in source[index:index + len(wanted)]] == wanted:
            return source[index][1], source[index + len(wanted) - 1][2]
    return None


def enrich_review_authority_spans(
    review: ReviewState,
    client: Optional[A2AJClient] = None,
    progress: Optional[Callable[[int, int, str], None]] = None,
) -> ReviewState:
    """Expand primary spans to exact resolved names that occur in the source."""
    client = client or A2AJClient(offline=False)
    units = {unit.key: unit for unit in review.units}
    candidates = [
        part
        for part in review.parts
        if not part.supra_target and part.kind in {"case", "statute"} and part.bare_citation
    ]
    for index, part in enumerate(candidates, 1):
        if progress:
            progress(index, len(candidates), part.bare_citation)
        lookup = client.lookup(part.bare_citation, part.kind, search=False)
        if not lookup.document or not lookup.document.name:
            continue
        part.resolved_name = lookup.document.name
        unit = units.get(part.unit_key)
        if unit is None:
            continue
        local = unit.text[part.start:part.authority_end]
        span = _resolved_name_span(local, lookup.document.name)
        if span is not None:
            _set_authority_span(part, unit, part.start + span[0], part.authority_end)
    return review


def _infer_reference_links(review: ReviewState) -> None:
    """Link Ibid and unambiguous supra occurrences to one canonical authority."""
    concrete_by_note: dict[int, list[ReviewPart]] = defaultdict(list)
    for part in review.parts:
        if part.kind != "reference" and part.bare_citation and part.footnote_id is not None:
            concrete_by_note[part.footnote_id].append(part)

    last: Optional[ReviewPart] = None
    for part in review.parts:
        if part.kind != "reference":
            if part.bare_citation:
                last = part
            continue
        target: Optional[ReviewPart] = None
        if re.search(r"\bibid\b", part.text, re.I):
            target = last
        else:
            note_match = re.search(r"\bsupra\s+(?:note|n\.?|nn\.?)\s+(\d+)", part.text, re.I)
            if note_match:
                candidates = concrete_by_note.get(int(note_match.group(1)), [])
                if len(candidates) == 1:
                    target = candidates[0]
                elif candidates:
                    prefix = re.split(r"\bsupra\b", part.text, flags=re.I)[0].strip(" ,;:.").casefold()
                    matches = [candidate for candidate in candidates if prefix and prefix in (candidate.short_form or candidate.authority_text).casefold()]
                    if len(matches) == 1:
                        target = matches[0]
        if target:
            part.supra_target = target.part_id
            last = target


def extract_docx_units(path: str | Path) -> list[TextUnit]:
    path = Path(path)
    if path.suffix.lower() != ".docx":
        raise ValueError("Input must be a .docx file")
    if not path.exists():
        raise FileNotFoundError(path)
    units: list[TextUnit] = []
    with zipfile.ZipFile(path) as archive:
        _validate_office_archive(archive)
        document = _office_xml(archive, "word/document.xml")
        body = next((node for node in document.iter() if _local(node.tag) == "body"), document)
        for ordinal, paragraph in enumerate((node for node in body.iter() if _local(node.tag) == "p")):
            text, references = _element_text_with_footnote_refs(paragraph)
            if text.strip():
                units.append(TextUnit(f"body:{ordinal}", "body", ordinal, None, text, references))
        footnote_numbers: dict[int, int] = {}
        if "word/footnotes.xml" in archive.namelist():
            footnotes = _office_xml(archive, "word/footnotes.xml")
            footnote_number = 0
            for footnote in footnotes.iter():
                if _local(footnote.tag) != "footnote":
                    continue
                raw_id = footnote.get(_tag("id"))
                if raw_id is None or int(raw_id) <= 0:
                    continue
                text = _element_text(footnote)
                if text.strip():
                    footnote_number += 1
                    footnote_numbers[int(raw_id)] = footnote_number
                    units.append(TextUnit(f"footnote:{int(raw_id)}", "footnote", footnote_number, footnote_number, text))
        for unit in units:
            if unit.kind == "body":
                unit.footnote_refs = [
                    (footnote_numbers.get(raw_id, raw_id), offset)
                    for raw_id, offset in unit.footnote_refs
                ]
    # Document order is important for Ibid and for reproducible review files.
    return units


def extract_pdf_units(path: str | Path) -> list[TextUnit]:
    path = Path(path)
    if path.suffix.lower() != ".pdf":
        raise ValueError("Input must be a .pdf file")
    if not path.exists():
        raise FileNotFoundError(path)
    _universal_engine_src()
    try:
        from legalpdf.core import parse_pdf
        from legalpdf.adapters import to_toa_text_units
    except ImportError as exc:
        raise RuntimeError("The legal PDF parser is unavailable.") from exc
    document = parse_pdf(path)
    return [TextUnit(**record) for record in to_toa_text_units(document)]


def extract_source_units(path: str | Path) -> list[TextUnit]:
    suffix = Path(path).suffix.lower()
    if suffix == ".docx":
        return extract_docx_units(path)
    if suffix == ".pdf":
        return extract_pdf_units(path)
    raise ValueError("Input must be a .docx or .pdf file")


def _element_text(element: Any) -> str:
    values: list[str] = []
    for node in element.iter():
        name = _local(node.tag)
        if name == "t":
            values.append(node.text or "")
        elif name == "tab":
            values.append("\t")
        elif name in {"br", "cr"}:
            values.append("\n")
    return "".join(values)


def _element_text_with_footnote_refs(element: Any) -> tuple[str, list[tuple[int, int]]]:
    values: list[str] = []
    references: list[tuple[int, int]] = []
    length = 0
    for node in element.iter():
        name = _local(node.tag)
        value = ""
        if name == "t":
            value = node.text or ""
        elif name == "tab":
            value = "\t"
        elif name in {"br", "cr"}:
            value = "\n"
        elif name == "footnoteReference":
            raw_id = node.get(_tag("id"))
            if raw_id is not None:
                references.append((int(raw_id), length))
        if value:
            values.append(value)
            length += len(value)
    return "".join(values), references


@dataclass
class A2AJDocument:
    dataset: str
    citation: str
    alternate_citation: str
    name: str
    date: str
    url: str
    text: str
    language: str
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class A2AJLookup:
    status: str
    document: Optional[A2AJDocument] = None
    method: str = ""
    error: str = ""


class A2AJClient:
    """Small cached client for the public A2AJ ``/fetch`` and ``/search`` APIs."""

    def __init__(
        self,
        base_url: str = "https://api.a2aj.ca",
        cache_dir: str | Path | None = None,
        timeout: int = 30,
        offline: bool = False,
        min_seconds_between_requests: float = 0.35,
        local_corpus: Any = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.cache_dir = (
            Path(cache_dir)
            if cache_dir is not None
            else provider_cache("a2aj") / "http"
        )
        self.timeout = timeout
        self.offline = offline
        self.min_wait = float(min_seconds_between_requests)
        self._last_request = 0.0
        self._session: Any = None
        if local_corpus is None:
            try:
                if a2aj_status().get("available"):
                    local_corpus = SharedA2AJCorpus()
            except Exception:
                local_corpus = None
        self.local_corpus = local_corpus

    def _key(self, endpoint: str, params: dict[str, Any]) -> str:
        payload = json.dumps({"endpoint": endpoint, "params": params}, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _get(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        key = self._key(endpoint, params)
        cache_path = self.cache_dir / f"{key}.json"
        local: Optional[dict[str, Any]] = None
        try:
            if self.local_corpus is not None and endpoint == "/fetch":
                local = self.local_corpus.fetch(
                    str(params.get("citation") or ""),
                    str(params.get("doc_type") or ""),
                    language=str(params.get("output_language") or "en"),
                )
            elif self.local_corpus is not None and endpoint == "/search":
                query = str(params.get("query") or "")
                local = self.local_corpus.fetch(query, str(params.get("doc_type") or ""))
                if not ((local.get("json") or {}).get("results")):
                    local = self.local_corpus.search_exact_name(
                        query,
                        str(params.get("doc_type") or ""),
                    )
        except (ImportError, OSError, RuntimeError, ValueError):
            local = None
        if local is not None and ((local.get("json") or {}).get("results")):
            return local
        if cache_path.exists():
            try:
                with cache_path.open(encoding="utf-8") as handle:
                    return json.load(handle)
            except (OSError, json.JSONDecodeError):
                pass
        if local is not None and self.offline:
            return local
        if self.offline:
            return {"status": None, "json": None, "error": "offline"}
        try:
            import requests

            if self._session is None:
                self._session = requests.Session()
                self._session.headers.update({"User-Agent": "AuthoritiesHelper/0.1"})
            elapsed = time.monotonic() - self._last_request
            if elapsed < self.min_wait:
                time.sleep(self.min_wait - elapsed)
            response = self._session.get(
                f"{self.base_url}{endpoint}",
                params={key: value for key, value in params.items() if value is not None},
                timeout=self.timeout,
            )
            self._last_request = time.monotonic()
            try:
                body = response.json()
            except ValueError:
                body = None
            payload = {"status": response.status_code, "json": body, "error": ""}
        except Exception as exc:  # network errors should not destroy the book build
            payload = {"status": None, "json": None, "error": str(exc)}
        if payload.get("json") and payload.get("status") == 200:
            _write_json(cache_path, payload)
        return payload

    @staticmethod
    def _text(obj: Any, language: str = "en") -> str:
        if isinstance(obj, str):
            return obj
        if isinstance(obj, dict):
            for key in (f"unofficial_text_{language}", f"text_{language}", "text", "full_text", "body", "content"):
                value = obj.get(key)
                if isinstance(value, str) and value.strip():
                    return value
            for value in obj.values():
                if not isinstance(value, (dict, list)):
                    continue
                found = A2AJClient._text(value, language)
                if found:
                    return found
        if isinstance(obj, list):
            for value in obj:
                found = A2AJClient._text(value, language)
                if found:
                    return found
        return ""

    @staticmethod
    def _document(obj: dict[str, Any], language: str = "en") -> A2AJDocument:
        actual_language = language if language in {"en", "fr"} else "en"
        if not obj.get(f"unofficial_text_{actual_language}") and obj.get(f"unofficial_text_fr"):
            actual_language = "fr"
        return A2AJDocument(
            str(obj.get("dataset") or ""),
            str(obj.get(f"citation_{actual_language}") or obj.get("citation_en") or obj.get("citation_fr") or ""),
            str(obj.get(f"citation2_{actual_language}") or obj.get("citation2_en") or obj.get("citation2_fr") or ""),
            str(obj.get(f"name_{actual_language}") or obj.get("name_en") or obj.get("name_fr") or ""),
            str(obj.get(f"document_date_{actual_language}") or obj.get("document_date_en") or ""),
            str(obj.get(f"source_url_{actual_language}") or obj.get(f"url_{actual_language}") or obj.get("source_url") or obj.get("url") or ""),
            A2AJClient._text(obj, actual_language),
            actual_language,
            obj,
        )

    @staticmethod
    def _candidate_citations(obj: dict[str, Any]) -> list[str]:
        return [str(obj.get(key) or "") for key in ("citation_en", "citation2_en", "citation_fr", "citation2_fr") if obj.get(key)]

    def lookup(
        self,
        citation: str,
        kind: str,
        *,
        name: str = "",
        search: bool = True,
    ) -> A2AJLookup:
        doc_type = "cases" if kind == "case" else "laws" if kind == "statute" else ""
        if not doc_type:
            return A2AJLookup("unsupported", method="not_an_a2aj_source")
        exact_key = _citation_key(citation)

        def select(payload: dict[str, Any]) -> list[dict[str, Any]]:
            body = payload.get("json") or {}
            items = body.get("results") if isinstance(body, dict) else None
            if not isinstance(items, list):
                return []
            return [item for item in items if isinstance(item, dict) and any(_citation_key(value) == exact_key for value in self._candidate_citations(item))]

        response = self._get("/fetch", {"citation": citation, "doc_type": doc_type, "output_language": "en"})
        if response.get("status") is None and response.get("error") == "offline":
            return A2AJLookup("offline", error="offline")
        if response.get("status") is None:
            return A2AJLookup("network_error", error=str(response.get("error") or "network error"))
        matches = select(response)
        method = "exact_citation"
        if not matches and search:
            query = name.strip() or citation
            searched = self._get(
                "/search",
                {
                    "query": query,
                    "search_type": "name" if name.strip() else "full_text",
                    "doc_type": doc_type,
                    "search_language": "en",
                    "size": 10,
                },
            )
            if searched.get("status") is None:
                error = str(searched.get("error") or "network error")
                return A2AJLookup(
                    "offline" if error == "offline" else "network_error",
                    method="exact_search",
                    error=error,
                )
            if searched.get("status") != 200:
                body = searched.get("json") or {}
                error = body.get("error") if isinstance(body, dict) else ""
                return A2AJLookup(
                    "network_error",
                    method="exact_search",
                    error=str(error or f"A2AJ API error ({searched.get('status')})"),
                )
            matches = select(searched)
            method = "exact_search"
        if len(matches) == 1:
            return A2AJLookup("found", self._document(matches[0]), method)
        if len(matches) > 1:
            return A2AJLookup("ambiguous", method=method)
        return A2AJLookup("not_found", method=method)


@dataclass
class Occurrence:
    part_id: str
    unit_key: str
    source_kind: str
    footnote_id: Optional[int]
    part_index: int
    raw_text: str
    citation: str
    pinpoint_fragments: list[str]
    page_pinpoints: list[int]
    tab: str = ""
    proposition_text: str = ""
    exact_quotes: list[str] = field(default_factory=list)
    pinpoint_text: str = ""
    pinpoint_start: int = -1
    pinpoint_end: int = -1
    document_pages: list[int] = field(default_factory=list)


@dataclass
class Authority:
    key: str
    kind: str
    citation: str
    name: str
    alternate_citation: str = ""
    dataset: str = ""
    date: str = ""
    source_url: str = ""
    source_text: str = ""
    source_sections: dict[str, str] = field(default_factory=dict)
    lookup_status: str = "not_queried"
    lookup_method: str = ""
    tab: str = ""
    pdf_path: str = ""
    pdf_origin: str = ""
    pdf_source_url: str = ""
    pdf_has_text_layer: Optional[bool] = None
    ocr_scope: str = ""
    ocr_pages: list[int] = field(default_factory=list)
    occurrences: list[Occurrence] = field(default_factory=list)


@dataclass
class AnalysisResult:
    review: ReviewState
    authorities: list[Authority]
    unresolved: list[dict[str, Any]]
    part_links: dict[str, str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "review": self.review.to_dict(),
            "authorities": [asdict(item) for item in self.authorities],
            "unresolved": self.unresolved,
            "part_links": self.part_links,
        }


def _a2aj_sections(document: A2AJDocument) -> dict[str, str]:
    raw = document.raw
    for key in (
        f"unofficial_sections_{document.language}",
        f"sections_{document.language}",
        "sections",
    ):
        value = raw.get(key)
        if isinstance(value, dict):
            return {
                str(label): text
                for label, text in value.items()
                if isinstance(text, str) and text.strip()
            }
    return {}


def _authority_sourcedoc_payload(authority: Authority) -> Optional[dict[str, Any]]:
    doc_type = "cases" if authority.kind == "case" else "laws" if authority.kind == "statute" else None
    if doc_type is None or not authority.source_text.strip():
        return None
    return {
        "docType": doc_type,
        "citation": authority.citation,
        "text": authority.source_text,
        "alternateCitation": authority.alternate_citation or None,
        "dataset": authority.dataset or None,
        "name": authority.name or None,
        "sectionMap": dict(authority.source_sections),
    }


def _compile_authority_sourcedoc(authority: Authority) -> Optional[Any]:
    payload = _authority_sourcedoc_payload(authority)
    if payload is None:
        return None
    try:
        from legal_structure import Document

        return Document(
            payload["docType"],
            payload["citation"],
            payload["text"],
            alternate_citation=payload["alternateCitation"],
            dataset=payload["dataset"],
            name=payload["name"],
            section_map=list(payload["sectionMap"].items()) or None,
            provider="a2aj",
            require_report_start=(payload["docType"] == "cases" and authority.dataset.upper() == "SCC"),
        )
    except (ImportError, OSError, RuntimeError, ValueError):
        return None


def _infer_authority_name(fields: DeterministicFields) -> str:
    return fields.short_form or fields.citation_with_style or fields.bare_citation or "Unresolved authority"


def _review_fields(part: ReviewPart) -> DeterministicFields:
    """Use fields already computed when the review part was created."""
    return DeterministicFields(
        "complete",
        part.text.strip(),
        part.kind,
        part.link_candidate,
        tuple(part.pinpoint_fragments),
        tuple(part.page_pinpoints),
        part.bare_citation,
        part.citation,
        part.short_form,
        tuple(part.anchors),
    )


def _footnote_propositions(review: ReviewState) -> dict[int, tuple[str, list[str]]]:
    """Return the body passage preceding each footnote and its explicit quotes."""
    body_units = sorted((unit for unit in review.units if unit.kind == "body"), key=lambda unit: unit.ordinal)
    text_parts: list[str] = []
    anchors: list[tuple[int, int]] = []
    cursor = 0
    for unit in body_units:
        text_parts.append(unit.text)
        for note_number, local_offset in unit.footnote_refs:
            anchors.append((int(note_number), cursor + int(local_offset)))
        cursor += len(unit.text) + 1
        text_parts.append("\n")
    body_text = "".join(text_parts)
    output: dict[int, tuple[str, list[str]]] = {}
    previous = 0
    for note_number, position in sorted(anchors, key=lambda item: item[1]):
        if note_number in output:
            continue
        proposition = _normal_space(body_text[previous:position])
        previous = position
        quotes: list[str] = []
        for match in re.finditer(r"“([^”\n]+)”|\"([^\"\n]+)\"", proposition):
            quote = _normal_space(match.group(1) or match.group(2) or "")
            if quote and quote not in quotes:
                quotes.append(quote)
        output[note_number] = (proposition, quotes)
    return output


def _merge_authority(target: Authority, incoming: Authority) -> Authority:
    if target.lookup_status != "found" and incoming.lookup_status == "found":
        # A2AJ's resolved title is canonical. Do not preserve a provisional
        # label derived from a bare or parallel citation over the full style
        # of cause / legislation name returned by the source.
        target.name = incoming.name or target.name
        target.citation = incoming.citation or target.citation
    if not target.name or target.name == "Unresolved authority":
        target.name = incoming.name
    for attr in (
        "citation",
        "alternate_citation",
        "dataset",
        "date",
        "source_url",
        "source_text",
        "source_sections",
        "lookup_method",
    ):
        if not getattr(target, attr) and getattr(incoming, attr):
            setattr(target, attr, getattr(incoming, attr))
    if target.lookup_status != "found" and incoming.lookup_status == "found":
        target.lookup_status = "found"
    return target


def _reference_target(
    part: ReviewPart,
    part_links: dict[str, str],
    authorities: dict[str, Authority],
    authorities_by_footnote: dict[int, list[Authority]],
    last_authority: Optional[Authority],
) -> Optional[Authority]:
    if part.supra_target:
        key = part_links.get(part.supra_target)
        if key and key in authorities:
            return authorities[key]
    text = part.text
    if re.search(r"\bibid\b", text, re.I):
        return last_authority
    note_match = re.search(r"\bsupra\s+(?:note|n\.?|nn\.?)\s+(\d+)", text, re.I)
    if note_match:
        note = int(note_match.group(1))
        candidates = authorities_by_footnote.get(note, [])
        if len(candidates) == 1:
            return candidates[0]
        prefix = re.split(r"\bsupra\b", text, flags=re.I)[0].strip(" ,;:.")
        named = [item for item in candidates if prefix.casefold() in item.name.casefold()]
        return named[0] if len(named) == 1 else None
    if re.search(r"\bsupra\b", text, re.I):
        prefix = re.split(r"\bsupra\b", text, flags=re.I)[0].strip(" ,;:.")
        candidates = [item for item in authorities.values() if prefix and prefix.casefold() in item.name.casefold()]
        return candidates[0] if len(candidates) == 1 else None
    return None


def resolve_review(
    review: ReviewState,
    client: Optional[A2AJClient] = None,
    progress: Optional[Callable[[int, int, str], None]] = None,
) -> AnalysisResult:
    client = client or A2AJClient(offline=True)
    unit_order = {unit.key: index for index, unit in enumerate(review.units)}
    units_by_key = {unit.key: unit for unit in review.units}
    ordered_parts = sorted(review.parts, key=lambda item: (unit_order.get(item.unit_key, 10**9), item.index))
    authorities: dict[str, Authority] = {}
    aliases: dict[str, Authority] = {}
    part_links: dict[str, str] = {}
    unresolved: list[dict[str, Any]] = []
    fields_by_part: dict[str, DeterministicFields] = {}
    propositions = _footnote_propositions(review)

    # First pass: concrete authorities. This makes manual supra links stable
    # even when the target occurs later in the document.
    total_parts = len(ordered_parts)
    for part_number, part in enumerate(ordered_parts, 1):
        if progress:
            progress(part_number, total_parts, part.authority_text)
        fields = _review_fields(part)
        fields_by_part[part.part_id] = fields
        if part.supra_target or fields.kind == "reference":
            continue
        if not fields.bare_citation or (fields.kind == "other" and not fields.link_candidate):
            continue
        requested_key = _citation_key(fields.bare_citation or fields.citation_with_style)
        authority = aliases.get(requested_key)
        if authority is None:
            authority = Authority(
                requested_key or hashlib.sha1(part.text.encode("utf-8")).hexdigest()[:12],
                fields.kind,
                _clean_citation(fields.citation_with_style or fields.bare_citation),
                _infer_authority_name(fields),
                source_url=fields.link_candidate,
                lookup_status="offline" if client.offline else "not_queried",
            )
            authorities[authority.key] = authority
            aliases[requested_key] = authority
        if fields.kind in {"case", "statute"} and authority.lookup_status in {"not_queried", "offline"}:
            lookup = client.lookup(
                fields.bare_citation,
                fields.kind,
                name=fields.short_form,
            )
            authority.lookup_status = lookup.status
            authority.lookup_method = lookup.method
            if lookup.document:
                document = lookup.document
                authority.citation = document.citation or authority.citation
                authority.alternate_citation = document.alternate_citation
                authority.name = document.name or authority.name
                authority.dataset = document.dataset
                authority.date = document.date
                authority.source_url = document.url or authority.source_url
                authority.source_text = document.text
                authority.source_sections = _a2aj_sections(document)
                for identity in (document.citation, document.alternate_citation, fields.bare_citation):
                    identity_key = _citation_key(identity)
                    if not identity_key:
                        continue
                    other = aliases.get(identity_key)
                    if other and other is not authority:
                        previous = authority
                        authority = _merge_authority(other, authority)
                        for dictionary_key, value in list(authorities.items()):
                            if value is previous:
                                authorities[dictionary_key] = authority
                    aliases[identity_key] = authority
                authorities[authority.key] = authority
        part_links[part.part_id] = authority.key

    authorities_by_footnote: dict[int, list[Authority]] = defaultdict(list)
    seen_by_footnote: dict[int, set[int]] = defaultdict(set)
    for part in ordered_parts:
        key = part_links.get(part.part_id)
        authority = authorities.get(key) if key else None
        note = part.footnote_id
        if authority is not None and note is not None and id(authority) not in seen_by_footnote[note]:
            seen_by_footnote[note].add(id(authority))
            authorities_by_footnote[note].append(authority)

    # Second pass: references and explicit GUI-created supra links.
    last: Optional[Authority] = None
    for part in ordered_parts:
        fields = fields_by_part[part.part_id]
        authority: Optional[Authority] = None
        if part.part_id in part_links:
            key = part_links[part.part_id]
            authority = authorities.get(key)
        elif part.supra_target or fields.kind == "reference":
            authority = _reference_target(part, part_links, authorities, authorities_by_footnote, last)
            if authority:
                part_links[part.part_id] = authority.key
        if authority:
            proposition, exact_quotes = propositions.get(part.footnote_id or -1, ("", []))
            occurrence = Occurrence(
                part.part_id,
                part.unit_key,
                fields.kind,
                part.footnote_id,
                part.index,
                part.text,
                fields.citation_with_style or fields.bare_citation or part.text,
                list(fields.pinpoint_fragments),
                list(fields.page_pinpoints),
                proposition_text=proposition,
                exact_quotes=list(exact_quotes),
                pinpoint_text=(
                    units_by_key[part.unit_key].text[part.pinpoint_start:part.pinpoint_end]
                    if part.unit_key in units_by_key and 0 <= part.pinpoint_start < part.pinpoint_end
                    else ""
                ),
                pinpoint_start=part.pinpoint_start,
                pinpoint_end=part.pinpoint_end,
            )
            authority.occurrences.append(occurrence)
            last = authority
        elif fields.kind == "reference" or part.supra_target:
            unresolved.append({
                "part_id": part.part_id,
                "text": part.text,
                "reason": "manual_target_not_found" if part.supra_target else "supra_or_ibid_not_resolved",
            })

    # A merged alias can leave a stale dictionary key; expose each authority once.
    unique: list[Authority] = []
    seen: set[int] = set()
    for authority in authorities.values():
        if id(authority) not in seen:
            seen.add(id(authority))
            unique.append(authority)
    for authority in unique:
        authority.occurrences = _dedupe_occurrences(authority.occurrences)
    return AnalysisResult(review, unique, unresolved, part_links)


def _dedupe_occurrences(items: list[Occurrence]) -> list[Occurrence]:
    out: list[Occurrence] = []
    seen: set[tuple[str, int, str]] = set()
    for item in items:
        key = (item.part_id, item.part_index, item.raw_text)
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def _xml_text_nodes(element: Any) -> list[tuple[Any, str, Any]]:
    nodes: list[tuple[Any, str, Any]] = []
    for parent in element.iter():
        for node in parent:
            name = _local(node.tag)
            if name == "t":
                nodes.append((node, node.text or "", parent))
            elif name == "tab":
                nodes.append((node, "\t", parent))
            elif name in {"br", "cr"}:
                nodes.append((node, "\n", parent))
    return nodes


def _find_xml_units(root: Any, kind: str) -> dict[str, Any]:
    """Find the same stable unit keys used by ``extract_docx_units``."""
    result: dict[str, Any] = {}
    if kind == "body":
        body = next((node for node in root.iter() if _local(node.tag) == "body"), root)
        for ordinal, paragraph in enumerate(node for node in body.iter() if _local(node.tag) == "p"):
            result[f"body:{ordinal}"] = paragraph
    else:
        for footnote in root.iter():
            if _local(footnote.tag) != "footnote":
                continue
            raw_id = footnote.get(_tag("id"))
            if raw_id is not None and int(raw_id) > 0:
                result[f"footnote:{int(raw_id)}"] = footnote
    return result


def _set_xml_text(node: Any, value: str) -> None:
    node.text = value
    if value.startswith(" ") or value.endswith(" ") or "\t" in value or "\n" in value:
        node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    else:
        node.attrib.pop("{http://www.w3.org/XML/1998/namespace}space", None)


def _insert_marker(element: Any, offset: int, marker: str) -> bool:
    """Insert visible marker text into the original run structure.

    The operation works in descending offset order, so it does not need to
    rewrite the source text or change any review offsets. If a marker lands on
    a tab/line break, it falls back to a new run immediately after the prior
    text run.
    """
    nodes = _xml_text_nodes(element)
    cursor = 0
    for node, value, parent in nodes:
        start, end = cursor, cursor + len(value)
        cursor = end
        if not (start <= offset <= end):
            continue
        if _local(node.tag) != "t":
            continue
        left = value[: max(0, offset - start)]
        right = value[max(0, offset - start):]
        _set_xml_text(node, left)
        marker_node = type(node)(_tag("t"))
        _set_xml_text(marker_node, marker)
        children = list(parent)
        index = children.index(node)
        parent.insert(index + 1, marker_node)
        if right:
            right_node = type(node)(_tag("t"))
            _set_xml_text(right_node, right)
            parent.insert(index + 2, right_node)
        return True
    # Empty/line-break-only tails are uncommon but should not make annotation
    # fail the entire build.
    text_nodes = [(node, value) for node, value, _parent in nodes if _local(node.tag) == "t"]
    if text_nodes:
        node, value = text_nodes[-1]
        _set_xml_text(node, value + marker)
        return True
    return False


def _field_runs(node_type: Any, instruction: str, *, hidden: bool = False) -> list[Any]:
    runs = []
    for field_type, text in (("begin", ""), ("", instruction), ("separate", ""), ("end", "")):
        run = node_type(_tag("r"))
        if hidden:
            properties = node_type(_tag("rPr"))
            properties.append(node_type(_tag("vanish")))
            run.append(properties)
        if field_type:
            field = node_type(_tag("fldChar"))
            field.set(_tag("fldCharType"), field_type)
            run.append(field)
        else:
            field = node_type(_tag("instrText"))
            field.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            field.text = instruction
            run.append(field)
        runs.append(run)
    return runs


def _insert_field(element: Any, offset: int, instruction: str, *, hidden: bool = False) -> bool:
    nodes = _xml_text_nodes(element)
    cursor = 0
    for node, value, parent in nodes:
        start, end = cursor, cursor + len(value)
        cursor = end
        if not (start <= offset <= end) or _local(node.tag) != "t":
            continue
        left = value[: max(0, offset - start)]
        right = value[max(0, offset - start):]
        _set_xml_text(node, left)
        run = next((ancestor for ancestor in element.iter() if node in list(ancestor)), parent)
        run_parent = next((ancestor for ancestor in element.iter() if run in list(ancestor)), None)
        if run_parent is None:
            return False
        children = list(run_parent)
        position = children.index(run) + 1
        for field_run in _field_runs(type(node), instruction, hidden=hidden):
            run_parent.insert(position, field_run)
            position += 1
        if right:
            right_run = type(node)(_tag("r"))
            right_node = type(node)(_tag("t"))
            _set_xml_text(right_node, right)
            right_run.append(right_node)
            run_parent.insert(position, right_run)
        return True
    return False


def _word_field_text(value: str) -> str:
    return _normal_space(value).replace('"', "'")


def _append_native_toa(root: Any) -> None:
    body = next((node for node in root.iter() if _local(node.tag) == "body"), None)
    if body is None:
        return
    node_type = type(body)
    page = node_type(_tag("p"))
    run = node_type(_tag("r"))
    br = node_type(_tag("br"))
    br.set(_tag("type"), "page")
    run.append(br)
    page.append(run)
    heading = node_type(_tag("p"))
    heading_properties = node_type(_tag("pPr"))
    style = node_type(_tag("pStyle"))
    style.set(_tag("val"), "Heading1")
    heading_properties.append(style)
    heading.append(heading_properties)
    heading_run = node_type(_tag("r"))
    heading_text = node_type(_tag("t"))
    heading_text.text = "Table of Authorities"
    heading_run.append(heading_text)
    heading.append(heading_run)
    field_paragraph = node_type(_tag("p"))
    field_paragraph.extend(_field_runs(node_type, r' TOA \h \e "\t" '))
    section = next((child for child in list(body) if _local(child.tag) == "sectPr"), None)
    position = list(body).index(section) if section is not None else len(list(body))
    for item in (page, heading, field_paragraph):
        body.insert(position, item)
        position += 1


def _append_linked_toa(root: Any, authorities: list[tuple[str, str]]) -> None:
    """Append the compact, first-reference-order list required by the ABCA."""
    body = next((node for node in root.iter() if _local(node.tag) == "body"), None)
    if body is None:
        return
    node_type = type(body)

    def text_run(value: str, *, link: bool = False) -> Any:
        run = node_type(_tag("r"))
        if link:
            properties = node_type(_tag("rPr"))
            color = node_type(_tag("color"))
            color.set(_tag("val"), "0563C1")
            underline = node_type(_tag("u"))
            underline.set(_tag("val"), "single")
            properties.extend((color, underline))
            run.append(properties)
        value_node = node_type(_tag("t"))
        _set_xml_text(value_node, value)
        run.append(value_node)
        return run

    page = node_type(_tag("p"))
    page_run = node_type(_tag("r"))
    page_break = node_type(_tag("br"))
    page_break.set(_tag("type"), "page")
    page_run.append(page_break)
    page.append(page_run)

    heading = node_type(_tag("p"))
    heading_properties = node_type(_tag("pPr"))
    heading_style = node_type(_tag("pStyle"))
    heading_style.set(_tag("val"), "Heading1")
    heading_properties.append(heading_style)
    heading.extend((heading_properties, text_run("Table of Authorities")))

    rows: list[Any] = [page, heading]
    for number, (label, url) in enumerate(authorities, 1):
        paragraph = node_type(_tag("p"))
        paragraph.append(text_run(f"{number}. "))
        if url:
            field_runs = _field_runs(
                node_type,
                f' HYPERLINK "{url.replace(chr(34), "%22")}" ',
            )
            field_runs.insert(3, text_run(label, link=True))
            paragraph.extend(field_runs)
        else:
            paragraph.append(text_run(label))
            paragraph.append(text_run(" — copy required (no public link supplied)"))
        rows.append(paragraph)

    section = next((child for child in list(body) if _local(child.tag) == "sectPr"), None)
    position = list(body).index(section) if section is not None else len(list(body))
    for item in rows:
        body.insert(position, item)
        position += 1


def annotate_docx(
    input_path: str | Path,
    output_path: str | Path,
    placements: dict[str, list[tuple[int, str]]],
    *,
    toa_entries: Optional[dict[str, list[tuple[int, str, str, int]]]] = None,
    append_native_toa: bool = False,
    linked_toa: Optional[list[tuple[str, str]]] = None,
) -> None:
    """Copy a DOCX and add ``[Tab X]`` immediately after detected citations."""
    ET.register_namespace("w", W_NS)
    ET.register_namespace("r", R_NS)
    input_path, output_path = Path(input_path), Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(input_path) as source, zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as target:
        _validate_office_archive(source)
        xml_parts: dict[str, Any] = {}
        source_names = set(source.namelist())
        for name in ("word/document.xml", "word/footnotes.xml"):
            if name in source_names:
                xml_parts[name] = _office_xml(source, name)
        for name, root in xml_parts.items():
            kind = "body" if name.endswith("document.xml") else "footnote"
            units = _find_xml_units(root, kind)
            # Hidden field instructions do not participate in source-text
            # offsets. Insert them before visible tab markers so later
            # citations cannot be split by marker-induced offset shifts.
            for unit_key, entries in (toa_entries or {}).items():
                if not unit_key.startswith(kind + ":") or unit_key not in units:
                    continue
                for offset, long_name, short_name, category in sorted(entries, reverse=True):
                    instruction = (
                        f' TA \\l "{_word_field_text(long_name)}" '
                        f'\\s "{_word_field_text(short_name)}" \\c {category} '
                    )
                    _insert_field(units[unit_key], offset, instruction, hidden=True)
            for unit_key, insertions in placements.items():
                if not unit_key.startswith(kind + ":") or unit_key not in units:
                    continue
                for offset, marker in sorted(insertions, reverse=True):
                    _insert_marker(units[unit_key], offset, marker)
            if kind == "body":
                if append_native_toa:
                    _append_native_toa(root)
                elif linked_toa is not None:
                    _append_linked_toa(root, linked_toa)
            xml_parts[name] = root
        for item in source.infolist():
            if item.filename in xml_parts:
                data = ET.tostring(xml_parts[item.filename], encoding="utf-8", xml_declaration=True)
            else:
                data = source.read(item.filename)
            target.writestr(item, data)


def _replace_xml_span(element: Any, start: int, end: int, replacement: str) -> bool:
    nodes = _xml_text_nodes(element)
    cursor = 0
    start_hit: Optional[tuple[int, Any, str]] = None
    end_hit: Optional[tuple[int, Any, str]] = None
    for node, value, _parent in nodes:
        node_start, node_end = cursor, cursor + len(value)
        cursor = node_end
        if _local(node.tag) != "t":
            continue
        if start_hit is None and node_start <= start <= node_end:
            start_hit = (node_start, node, value)
        if node_start <= end <= node_end:
            end_hit = (node_start, node, value)
            break
    if start_hit is None or end_hit is None:
        return False
    start_base, start_node, start_value = start_hit
    end_base, end_node, end_value = end_hit
    if start_node is end_node:
        _set_xml_text(
            start_node,
            start_value[:start - start_base] + replacement + start_value[end - end_base:],
        )
        return True
    active = False
    for node, value, _parent in nodes:
        if node is start_node:
            active = True
            _set_xml_text(node, start_value[:start - start_base] + replacement)
        elif node is end_node:
            _set_xml_text(node, end_value[end - end_base:])
            return True
        elif active and _local(node.tag) == "t":
            _set_xml_text(node, "")
    return False


def _quote_source_span(
    payload: dict[str, Any],
    row: dict[str, Any],
) -> tuple[str, int, int]:
    expected = str(row.get("expected_quote") or "").strip()
    if not expected:
        raise ValueError("This discrepancy does not contain an authored quotation.")
    footnote_id = row.get("footnote_id")
    pattern = re.compile(r"\s+".join(re.escape(piece) for piece in expected.split()))
    candidates: list[tuple[int, str, int, int]] = []
    for unit in payload.get("review", {}).get("units", []):
        if not isinstance(unit, dict) or str(unit.get("kind") or "") != "body":
            continue
        text = str(unit.get("text") or "")
        anchors = [
            int(offset)
            for note, offset in unit.get("footnote_refs", [])
            if footnote_id is not None and int(note) == int(footnote_id)
        ]
        for match in pattern.finditer(text):
            if anchors:
                preceding = [anchor - match.end() for anchor in anchors if match.end() <= anchor]
                distance = (
                    min(preceding)
                    if preceding
                    else 1_000_000 + min(abs(anchor - match.end()) for anchor in anchors)
                )
            else:
                distance = 2_000_000 + int(unit.get("ordinal") or 0)
            candidates.append((distance, str(unit.get("key") or ""), match.start(), match.end()))
    if not candidates:
        raise ValueError("The authored quotation could not be mapped back to the source Word document.")
    _distance, unit_key, start, end = min(candidates)
    return unit_key, start, end


def apply_docx_discrepancy(
    manifest_path: str | Path,
    discrepancy_id: str,
    *,
    action: str,
) -> Optional[Path]:
    """Apply one explicitly accepted source correction, or record Ignore."""
    if action not in {"ignore", "pinpoint", "quote_exact", "quote_editorial"}:
        raise ValueError("Unknown discrepancy action.")
    manifest_path = Path(manifest_path)
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    row = next(
        (item for item in payload.get("discrepancies", []) if str(item.get("id") or "") == discrepancy_id),
        None,
    )
    if row is None:
        raise ValueError("The selected discrepancy is not present in this build.")
    if action == "ignore":
        row["status"] = "ignored"
        row["action"] = action
        row["reviewed_at"] = datetime.now(timezone.utc).isoformat()
        _write_json(manifest_path, payload, indent=2)
        return None

    if action == "pinpoint":
        replacement = str(row.get("replacement_text") or "")
        start, end = int(row.get("pinpoint_start", -1)), int(row.get("pinpoint_end", -1))
        unit_key = str(row.get("unit_key") or "")
        expected = str(row.get("source_pinpoint") or "")
    else:
        unit_key, start, end = _quote_source_span(payload, row)
        found = str(row.get("found_quote") or "").strip()
        expected = str(row.get("expected_quote") or "")
        if not found:
            raise ValueError("No source quotation was detected for this discrepancy.")
        if action == "quote_exact":
            replacement = found
        else:
            from quote_edits import editorial_quote

            replacement = editorial_quote(expected, found)
    if not replacement or start < 0 or end <= start or not unit_key:
        raise ValueError("This discrepancy does not have a safe source replacement.")

    source_path = Path(str(payload.get("input") or ""))
    if not source_path.is_file():
        raise FileNotFoundError(f"Source Word document not found: {source_path}")
    backup = source_path.with_name(f"{source_path.stem}.toa-backup{source_path.suffix}")
    if not backup.exists():
        shutil.copy2(source_path, backup)
    ET.register_namespace("w", W_NS)
    ET.register_namespace("r", R_NS)
    xml_name = "word/document.xml" if unit_key.startswith("body:") else "word/footnotes.xml"
    partial = source_path.with_suffix(".toa-update.part.docx")
    partial.unlink(missing_ok=True)
    try:
        with zipfile.ZipFile(source_path) as source, zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as target:
            _validate_office_archive(source)
            if xml_name not in source.namelist():
                raise ValueError(f"The source document does not contain {xml_name}.")
            root = _office_xml(source, xml_name)
            kind = "body" if xml_name.endswith("document.xml") else "footnote"
            units = _find_xml_units(root, kind)
            element = units.get(unit_key)
            if element is not None:
                current_text = "".join(value for _node, value, _parent in _xml_text_nodes(element))
                if expected and current_text[start:end] != expected:
                    nearby_start = max(0, start - 300)
                    nearby = current_text[nearby_start:start + 300]
                    matches = [match.start() for match in re.finditer(re.escape(expected), nearby)]
                    if matches:
                        start = nearby_start + min(
                            matches,
                            key=lambda value: abs((nearby_start + value) - start),
                        )
                        end = start + len(expected)
            if element is None or not _replace_xml_span(element, start, end, replacement):
                raise ValueError("The correction could not be mapped back to the source Word document.")
            for item in source.infolist():
                data = (
                    ET.tostring(root, encoding="utf-8", xml_declaration=True)
                    if item.filename == xml_name
                    else source.read(item.filename)
                )
                target.writestr(item, data)
        partial.replace(source_path)
    finally:
        partial.unlink(missing_ok=True)
    row["status"] = "applied"
    row["action"] = action
    row["applied_text"] = replacement
    row["reviewed_at"] = datetime.now(timezone.utc).isoformat()
    row["backup_path"] = str(backup.resolve())
    _write_json(manifest_path, payload, indent=2)
    return backup


def _safe_slug(value: str, fallback: str = "authority") -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-").lower()
    return value[:80] or fallback


def _tab_label(index: int, style: str) -> str:
    if style == "alpha":
        n = index
        letters = ""
        while n:
            n, remainder = divmod(n - 1, 26)
            letters = chr(ord("A") + remainder) + letters
        return f"Tab {letters}"
    return f"Tab {index}"


def assign_tabs(authorities: list[Authority], style: str = "numeric") -> list[Authority]:
    order = {"case": 0, "statute": 1, "journal": 2, "other": 3, "reference": 4}
    authorities.sort(key=lambda item: (order.get(item.kind, 9), (item.name or item.citation).casefold(), item.citation.casefold()))
    for index, authority in enumerate(authorities, 1):
        authority.tab = _tab_label(index, style)
        for occurrence in authority.occurrences:
            occurrence.tab = authority.tab
    return authorities


def _require_docx() -> Any:
    try:
        from docx import Document
    except ImportError as exc:  # pragma: no cover - dependency error path
        raise RuntimeError("Install dependencies with: python -m pip install -r requirements.txt") from exc
    return Document


def _set_run_font(run: Any, name: str = "Calibri", size: float = 11, color: str = "000000", bold: Optional[bool] = None, italic: Optional[bool] = None) -> None:
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    run.font.name = name
    run.font.size = Pt(size)
    run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.rFonts
    if fonts is None:
        from docx.oxml import OxmlElement

        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    fonts.set(qn("w:ascii"), name)
    fonts.set(qn("w:hAnsi"), name)


def _configure_doc(doc: Any, title: str) -> None:
    from docx.enum.section import WD_ORIENT
    from docx.shared import Inches, Pt

    section = doc.sections[0]
    section.orientation = WD_ORIENT.PORTRAIT
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = section.bottom_margin = Inches(1)
    section.left_margin = section.right_margin = Inches(1)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)
    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25
    for name, size, before, after in (
        ("Heading 1", 16, 18, 10),
        ("Heading 2", 13, 14, 7),
        ("Heading 3", 12, 10, 5),
    ):
        style = styles[name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.color.rgb = __import__("docx.shared", fromlist=["RGBColor"]).RGBColor.from_string("000000")
        style.font.bold = True
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.line_spacing = 1.25
    title_style = styles["Title"]
    title_style.font.name = "Calibri"
    title_style.font.size = Pt(24)
    title_style.font.color.rgb = __import__("docx.shared", fromlist=["RGBColor"]).RGBColor.from_string("000000")
    title_style.font.bold = True
    title_style.paragraph_format.space_before = Pt(0)
    title_style.paragraph_format.space_after = Pt(8)
    header = section.header.paragraphs[0]
    header.text = ""
    _set_run_font(header.add_run(title), size=8.5, color="666666")
    footer = section.footer.paragraphs[0]
    footer.alignment = 2
    footer.text = ""
    _set_run_font(footer.add_run("Page "), size=8.5, color="666666")
    _add_page_field(footer)


def _add_page_field(paragraph: Any) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    run = OxmlElement("w:r")
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for child in (begin, instr, separate, text, end):
        run.append(child)
    paragraph._p.append(run)


def _set_cell_margins(cell: Any, top: int = 80, start: int = 120, bottom: int = 80, end: int = 120) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    tc_pr = cell._tc.get_or_add_tcPr()
    margins = tc_pr.first_child_found_in("w:tcMar")
    if margins is None:
        margins = OxmlElement("w:tcMar")
        tc_pr.append(margins)
    for side, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def _set_table_geometry(table: Any, widths: list[int]) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    table.autofit = False
    tbl_pr = table._tbl.tblPr
    width = tbl_pr.first_child_found_in("w:tblW")
    if width is None:
        width = OxmlElement("w:tblW")
        tbl_pr.insert(0, width)
    width.set(qn("w:w"), str(sum(widths)))
    width.set(qn("w:type"), "dxa")
    indent = tbl_pr.first_child_found_in("w:tblInd")
    if indent is None:
        indent = OxmlElement("w:tblInd")
        tbl_pr.append(indent)
    indent.set(qn("w:w"), "120")
    indent.set(qn("w:type"), "dxa")
    layout = tbl_pr.first_child_found_in("w:tblLayout")
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        tbl_pr.append(layout)
    layout.set(qn("w:type"), "fixed")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width_value in widths:
        grid_col = OxmlElement("w:gridCol")
        grid_col.set(qn("w:w"), str(width_value))
        grid.append(grid_col)
    for row in table.rows:
        for cell, width_value in zip(row.cells, widths):
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.first_child_found_in("w:tcW")
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.insert(0, tc_w)
            tc_w.set(qn("w:w"), str(width_value))
            tc_w.set(qn("w:type"), "dxa")
            _set_cell_margins(cell)


def _repeat_header(row: Any) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    tr_pr = row._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    tr_pr.append(header)


def _add_hyperlink(paragraph: Any, text: str, url: str) -> None:
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    if not url:
        paragraph.add_run(text)
        return
    relation = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), relation)
    run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "0563C1")
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    rpr.extend((color, underline))
    run.append(rpr)
    node = OxmlElement("w:t")
    node.text = text
    run.append(node)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


def _occurrence_pinpoints(occurrence: Occurrence) -> str:
    values = []
    for fragment in occurrence.pinpoint_fragments:
        if fragment.startswith("par"):
            values.append("¶ " + fragment[3:])
        elif fragment.startswith("sec"):
            values.append("s " + fragment[3:])
        else:
            values.append(fragment)
    values.extend(f"p {page}" for page in occurrence.page_pinpoints)
    return ", ".join(values)


def _format_cited_at(authority: Authority, location_style: str = "pinpoints") -> str:
    if location_style == "pages":
        pages = sorted({page for occurrence in authority.occurrences for page in occurrence.document_pages})
        return ", ".join(str(page) for page in pages) or "—"
    if location_style == "combined":
        values = []
        for occurrence in authority.occurrences:
            pages = ", ".join(str(page) for page in occurrence.document_pages) or "?"
            pinpoint = _occurrence_pinpoints(occurrence)
            label = pages + (f" ({pinpoint})" if pinpoint else "")
            if label not in values:
                values.append(label)
        return "; ".join(values) or "—"
    pinpoints = list(
        dict.fromkeys(
            value
            for occurrence in authority.occurrences
            if (value := _occurrence_pinpoints(occurrence))
        )
    )
    if pinpoints:
        return "; ".join(pinpoints)
    values: list[str] = []
    for occurrence in authority.occurrences:
        if occurrence.footnote_id is not None:
            label = f"fn {occurrence.footnote_id}"
        else:
            label = occurrence.unit_key
        if occurrence.pinpoint_fragments:
            label += " (" + ", ".join(occurrence.pinpoint_fragments) + ")"
        elif occurrence.page_pinpoints:
            label += " (pp " + ", ".join(str(item) for item in occurrence.page_pinpoints) + ")"
        if label not in values:
            values.append(label)
    return ", ".join(values)


def _add_table(doc: Any, authorities: list[Authority], location_style: str = "pinpoints") -> None:
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    groups: dict[str, list[Authority]] = defaultdict(list)
    labels = {"case": "Cases", "statute": "Legislation", "journal": "Secondary sources", "other": "Other sources"}
    for authority in authorities:
        groups[labels.get(authority.kind, "Other sources")].append(authority)
    for group_name in ("Cases", "Legislation", "Secondary sources", "Other sources"):
        items = groups.get(group_name)
        if not items:
            continue
        heading = doc.add_paragraph(group_name, style="Heading 1")
        heading.paragraph_format.keep_with_next = True
        table = doc.add_table(rows=1, cols=4)
        table.style = "Table Grid"
        headers = ("Tab", "Authority", "Cited at", "Source")
        for cell, label in zip(table.rows[0].cells, headers):
            cell.text = ""
            paragraph = cell.paragraphs[0]
            paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
            run = paragraph.add_run(label)
            _set_run_font(run, size=9.5, bold=True, color="000000")
        _repeat_header(table.rows[0])
        for authority in items:
            row = table.add_row()
            values = (
                authority.tab,
                authority.name or authority.citation,
                _format_cited_at(authority, location_style),
                "",
            )
            for cell, value in zip(row.cells, values):
                cell.text = ""
                paragraph = cell.paragraphs[0]
                run = paragraph.add_run(value)
                _set_run_font(run, size=9.2, color="000000")
            source = row.cells[3].paragraphs[0]
            if authority.source_url:
                _add_hyperlink(source, "Open source", authority.source_url)
            else:
                run = source.add_run(authority.lookup_status.replace("_", " "))
                _set_run_font(run, size=9.2, color="666666", italic=True)
        _set_table_geometry(table, [700, 3000, 2800, 2860])
        doc.add_paragraph().paragraph_format.space_after = 0


def write_table_of_authorities(
    authorities: list[Authority],
    output_path: str | Path,
    input_name: str,
    *,
    location_style: str = "pinpoints",
) -> None:
    Document = _require_docx()
    doc = Document()
    _configure_doc(doc, "Table of Authorities")
    title = doc.add_paragraph(style="Title")
    title.add_run("Table of Authorities")
    subtitle = doc.add_paragraph()
    _set_run_font(subtitle.add_run(input_name), size=11, color="666666", italic=True)
    if not authorities:
        paragraph = doc.add_paragraph("No supported authorities were detected. Review the source document or add a manual review entry.")
        _set_run_font(paragraph.runs[0], size=11, color="333333")
    else:
        _add_table(doc, authorities, location_style)
    doc.save(output_path)


def _add_authority_metadata(doc: Any, authority: Authority) -> None:
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    tab = doc.add_paragraph()
    tab.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = tab.add_run(authority.tab.upper())
    _set_run_font(run, size=16, color="000000", bold=True)
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _set_run_font(title.add_run(authority.name or authority.citation), size=15, color="000000", bold=True)
    citation = doc.add_paragraph()
    citation.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _set_run_font(citation.add_run(authority.citation), size=11, color="444444", italic=True)
    for label, value in (
        ("Source type", authority.kind),
        ("A2AJ status", authority.lookup_status.replace("_", " ")),
        ("Dataset", authority.dataset),
        ("Date", authority.date),
    ):
        if not value:
            continue
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = 0
        _set_run_font(paragraph.add_run(f"{label}: "), size=9.5, color="666666", bold=True)
        _set_run_font(paragraph.add_run(value), size=9.5, color="444444")
    if authority.source_url:
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = 8
        _set_run_font(paragraph.add_run("Source: "), size=9.5, color="666666", bold=True)
        _add_hyperlink(paragraph, authority.source_url, authority.source_url)


def _add_source_text_docx(doc: Any, text: str) -> None:
    from docx.shared import Pt

    text = _xml_safe(text)
    if not text.strip():
        paragraph = doc.add_paragraph("Source text was not returned by A2AJ. Use the source link above to obtain the authority.")
        _set_run_font(paragraph.runs[0], size=10, color="333333", italic=True)
        return
    for block in _paragraph_blocks(text):
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(5)
        paragraph.paragraph_format.line_spacing = 1.08
        _set_run_font(paragraph.add_run(block), size=9.5, color="000000")


def write_book_of_authorities(authorities: list[Authority], output_path: str | Path, input_name: str) -> None:
    Document = _require_docx()
    doc = Document()
    _configure_doc(doc, "Book of Authorities")
    title = doc.add_paragraph(style="Title")
    title.add_run("Book of Authorities")
    subtitle = doc.add_paragraph()
    _set_run_font(subtitle.add_run(input_name), size=12, color="444444", italic=True)
    intro = doc.add_paragraph()
    _set_run_font(intro.add_run("Authorities are separated by tab headings and appear in the same order as the Table of Authorities."), size=10, color="666666")
    doc.add_page_break()
    toc_heading = doc.add_paragraph("Index", style="Heading 1")
    toc_heading.paragraph_format.keep_with_next = True
    _add_table(doc, authorities)
    for authority in authorities:
        doc.add_page_break()
        _add_authority_metadata(doc, authority)
        _add_source_text_docx(doc, authority.source_text)
    doc.save(output_path)


_PDF_MARKDOWN_HEADING_RE = re.compile(r"^\s*(#{1,6})\s+(.+?)\s*#*\s*$", re.S)
_PDF_MARKDOWN_TABLE_RULE_RE = re.compile(
    r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$"
)
_PDF_UNORDERED_LIST_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<marker>[-+*])\s+(?P<text>.+)$",
    re.S,
)
_PDF_ORDERED_LIST_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<marker>\d{1,4}[.)])\s+(?P<text>.+)$",
    re.S,
)
_PDF_LEGAL_PROVISION_RE = re.compile(
    r"^\s*(?P<label>\d+(?:[.-]\d+)*|\(\d+\)|\([a-z]\)|\([ivxlcdm]+\))\s+(?P<text>.+)$",
    re.I | re.S,
)
def _markdown_table_cells(line: str) -> list[str]:
    value = line.strip().strip("|")
    cells = re.split(r"(?<!\\)\|", value)
    return [_normal_space(cell.replace(r"\|", "|")) for cell in cells]


def _markdown_table_rows(value: str) -> list[list[str]]:
    lines = [line for line in value.splitlines() if line.strip()]
    if len(lines) < 2 or not _PDF_MARKDOWN_TABLE_RULE_RE.fullmatch(lines[1]):
        return []
    rows = [_markdown_table_cells(line) for line in (lines[:1] + lines[2:])]
    width = len(rows[0]) if rows else 0
    return rows if width > 0 and all(len(row) == width for row in rows) else []


def _source_chunks(text: str) -> list[tuple[str, str]]:
    """Preserve block structure while extracting Markdown tables and lists."""
    chunks: list[tuple[str, str]] = []
    for block in _paragraph_blocks(text):
        lines = block.splitlines()
        plain: list[str] = []

        def flush() -> None:
            value = "\n".join(plain).strip()
            if value:
                chunks.append(("text", value))
            plain.clear()

        index = 0
        while index < len(lines):
            if (
                index + 1 < len(lines)
                and "|" in lines[index]
                and _PDF_MARKDOWN_TABLE_RULE_RE.fullmatch(lines[index + 1])
            ):
                flush()
                end = index + 2
                while end < len(lines) and "|" in lines[end]:
                    end += 1
                table = "\n".join(lines[index:end])
                if _markdown_table_rows(table):
                    chunks.append(("table", table))
                else:
                    plain.extend(lines[index:end])
                index = end
                continue
            line = lines[index]
            unordered = _PDF_UNORDERED_LIST_RE.match(line)
            ordered = _PDF_ORDERED_LIST_RE.match(line)
            # Court captions use "- and -" as a separator, never as a bullet.
            if unordered and _normal_space(line).casefold() == "- and -":
                unordered = None
            if unordered or ordered:
                flush()
                chunks.append(("text", line))
            elif _PDF_LEGAL_PROVISION_RE.match(line):
                flush()
                chunks.append(("text", line))
            else:
                plain.append(line)
            index += 1
        flush()
    return chunks


def _list_depth(indent: str) -> int:
    return min(5, len(indent.expandtabs(4)) // 2)


def _presentation_source_blocks(text: str) -> list[tuple[str, str, int]]:
    """Render Markdown presentation without inferring legal structure."""
    result: list[tuple[str, str, int]] = []
    for chunk_kind, block in _source_chunks(
        _xml_safe(text or "").replace("\u00a0", " ")
    ):
        if chunk_kind == "table":
            result.append(("table", block, len(_markdown_table_rows(block)[0])))
            continue
        compact = _normal_space(block)
        if not compact:
            continue
        heading = _PDF_MARKDOWN_HEADING_RE.match(block)
        if heading:
            result.append(
                (
                    "heading",
                    _normal_space(heading.group(2)),
                    min(5, max(2, len(heading.group(1)))),
                )
            )
            continue
        unordered = _PDF_UNORDERED_LIST_RE.match(block)
        ordered = _PDF_ORDERED_LIST_RE.match(block)
        if unordered and compact.casefold() != "- and -":
            result.append(
                (
                    "bullet",
                    _normal_space(unordered.group("text")),
                    _list_depth(unordered.group("indent")),
                )
            )
        elif ordered:
            result.append(
                (
                    "ordered",
                    ordered.group("marker")
                    + "\t"
                    + _normal_space(ordered.group("text")),
                    _list_depth(ordered.group("indent")),
                )
            )
        else:
            result.append(("paragraph", compact, 0))
    return result


def _sourcedoc_render_blocks(
    document: Any,
) -> Iterable[tuple[str, str, int]]:
    segments = document.get("segments", ()) if isinstance(document, dict) else document.segments()
    for segment in segments:
        if isinstance(segment, dict):
            kind = segment.get("kind")
            label = segment.get("label")
            origin = segment.get("origin")
            text = segment.get("text", "")
        else:
            kind, label, origin, text = segment
        if kind == "page":
            yield ("page", str(label or "").removeprefix("page"), 0)
        elif kind == "section" and origin == "native":
            yield ("section", str(label or "").removeprefix("sec"), 0)
        yield from _presentation_source_blocks(text)


def _markdown_inline_html(value: str) -> str:
    """Translate the small inline-Markdown subset used by A2AJ laws."""
    escaped = html.escape(value)
    escaped = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*\n]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", escaped)
    return escaped


def _markdown_table_html(value: str) -> str:
    rows = _markdown_table_rows(value)
    if not rows:
        return f"<p>{_markdown_inline_html(value)}</p>"
    header, *body = rows
    output = ["<table><thead><tr>"]
    output.extend(f"<th>{_markdown_inline_html(cell)}</th>" for cell in header)
    output.append("</tr></thead><tbody>")
    for row in body:
        output.append("<tr>")
        output.extend(f"<td>{_markdown_inline_html(cell)}</td>" for cell in row)
        output.append("</tr>")
    output.append("</tbody></table>")
    return "".join(output)


def _render_fitz_pdf(
    path: str | Path,
    title: str,
    citation: str,
    name: str,
    text: str | Iterable[str],
    metadata: str = "",
    source_doc: Optional[Any] = None,
) -> None:
    import fitz

    target = Path(path)
    partial = target.with_suffix(".fitz.part.pdf")
    partial.unlink(missing_ok=True)
    sources = (text,) if isinstance(text, str) else tuple(text)
    body: list[str] = [
        '<section class="title-page">',
        f'<div class="eyebrow">{html.escape(title.upper())}</div>',
        f"<h1>{html.escape(name or citation)}</h1>",
        f'<div class="citation">{html.escape(citation)}</div>',
    ]
    if metadata:
        body.append(f'<div class="metadata">{html.escape(metadata)}</div>')
    body.extend(("</section>", '<main class="authority-text">'))
    has_text = False
    render_sources: Iterable[Iterable[tuple[str, str, int]]]
    if source_doc is not None:
        render_sources = (_sourcedoc_render_blocks(source_doc),)
    else:
        render_sources = (
            _presentation_source_blocks(source or "") for source in sources
        )
    for source_number, blocks in enumerate(render_sources):
        if source_number:
            body.append('<div class="source-break"></div>')
        for kind, value, level in blocks:
            has_text = True
            escaped = _markdown_inline_html(value)
            if kind == "page":
                body.append(f'<div class="page-witness">Original page {escaped}</div>')
            elif kind == "section":
                body.append(f'<div class="section-witness">Section {escaped}</div>')
            elif kind == "heading":
                body.append(f"<h{level}>{escaped}</h{level}>")
            elif kind == "table":
                body.append(_markdown_table_html(value))
            elif kind == "bullet":
                body.append(
                    f'<p class="list-item list-level-{min(level, 5)}">'
                    f'<span class="list-marker">&bull;</span>{escaped}</p>'
                )
            elif kind == "ordered":
                marker, _, item_text = value.partition("\t")
                body.append(
                    f'<p class="list-item list-level-{min(level, 5)}">'
                    f'<span class="list-marker">{html.escape(marker)}</span>'
                    f"{_markdown_inline_html(item_text)}</p>"
                )
            elif kind == "provision":
                provision = _PDF_LEGAL_PROVISION_RE.match(value)
                label = _markdown_inline_html(provision.group("label")) if provision else ""
                provision_text = _markdown_inline_html(provision.group("text")) if provision else escaped
                body.append(
                    f'<p class="provision indent-{min(level, 5)}">'
                    f'<span class="provision-number">{label}</span> '
                    f'<span class="provision-text">{provision_text}</span></p>'
                )
            else:
                body.append(f'<p class="indent-{min(level, 5)}">{escaped}</p>')
    if not has_text:
        body.append(
            '<p class="missing">Source text was not returned. Use the source link in the '
            "Table of Authorities to obtain this authority.</p>"
        )
    body.append("</main>")
    css = """
        * { box-sizing: border-box; }
        body { font-family: serif; font-size: 10.2pt; line-height: 1.42; color: #111; }
        .title-page { page-break-after: always; text-align: center; padding: 145pt 42pt 0; }
        .eyebrow { font-family: sans-serif; font-size: 10pt; font-weight: bold;
                   letter-spacing: 1.2pt; color: #333; margin-bottom: 28pt; }
        h1 { font-family: sans-serif; font-size: 23pt; line-height: 1.16; color: #000;
             margin: 0 0 14pt; }
        .citation { font-size: 12pt; font-style: italic; color: #333; margin-bottom: 22pt; }
        .metadata { font-family: sans-serif; font-size: 8.5pt; color: #555; }
        .authority-text { padding: 0; }
        p { margin: 0 0 8pt; text-align: justify; }
        h2, h3, h4, h5 { font-family: sans-serif; color: #000; break-after: avoid;
                         margin: 18pt 0 7pt; line-height: 1.2; }
        h2 { font-size: 15pt; border-bottom: 0.7pt solid #777; padding-bottom: 4pt; }
        h3 { font-size: 12.5pt; margin-left: 12pt; }
        h4 { font-size: 11.5pt; margin-left: 24pt; }
        h5 { font-size: 10.5pt; margin-left: 36pt; }
        .provision-number { font-family: sans-serif; font-weight: bold; color: #000; }
        .list-item { margin-left: 18pt; text-indent: -14pt; text-align: left; }
        .list-item.list-level-1 { margin-left: 32pt; }
        .list-item.list-level-2 { margin-left: 46pt; }
        .list-item.list-level-3 { margin-left: 60pt; }
        .list-item.list-level-4 { margin-left: 74pt; }
        .list-item.list-level-5 { margin-left: 88pt; }
        .list-marker { display: inline-block; min-width: 14pt; font-family: sans-serif; font-weight: bold; }
        .indent-1 { margin-left: 12pt; }
        .indent-2 { margin-left: 24pt; }
        .indent-3 { margin-left: 36pt; }
        .indent-4 { margin-left: 48pt; }
        .indent-5 { margin-left: 60pt; }
        code { font-family: monospace; font-size: 9.4pt; background: #eee; }
        table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 8.5pt; }
        th, td { border: 0.5pt solid #777; padding: 4pt 5pt; text-align: left; vertical-align: top; }
        th { background: #eee; color: #000; font-family: sans-serif; font-weight: bold; }
        .section-witness { font-family: sans-serif; font-size: 9.5pt; font-weight: bold;
                           color: #222; border-bottom: 0.6pt solid #aaa;
                           padding-bottom: 3pt; margin: 12pt 0 7pt; }
        .page-witness { page-break-before: always; font-family: sans-serif; font-size: 8pt;
                        color: #555; text-align: right; border-top: 0.6pt solid #aaa;
                        padding-top: 4pt; margin-bottom: 12pt; }
        .source-break { page-break-before: always; }
        .missing { color: #333; font-style: italic; }
    """
    story = fitz.Story("".join(body), user_css=css)
    mediabox = fitz.paper_rect("letter")
    content_rect = fitz.Rect(62, 58, mediabox.width - 62, mediabox.height - 54)
    writer = fitz.DocumentWriter(str(partial))
    more = True
    while more:
        device = writer.begin_page(mediabox)
        more, _ = story.place(content_rect)
        story.draw(device)
        writer.end_page()
    writer.close()
    document = fitz.open(partial)
    running_header = name or citation
    if citation and citation.casefold() not in running_header.casefold():
        running_header = f"{running_header} · {citation}"
    for page_number, page in enumerate(document, 1):
        if page_number > 1:
            page.insert_text(
                (62, 36),
                _xml_safe(running_header[:105]),
                fontsize=7.5,
                fontname="helv",
                color=(0.4, 0.4, 0.4),
            )
            page.draw_line(
                (62, 43),
                (mediabox.width - 62, 43),
                color=(0.72, 0.72, 0.72),
                width=0.6,
            )
        page.insert_text(
            (mediabox.width - 92, mediabox.height - 29),
            str(page_number),
            fontsize=8,
            fontname="helv",
            color=(0.4, 0.4, 0.4),
        )
    document.set_metadata(
        {
            "title": name or citation,
            "subject": citation,
            "creator": "AuthoritiesHelper",
            "producer": "PyMuPDF",
        }
    )
    final_partial = target.with_suffix(".final.part.pdf")
    final_partial.unlink(missing_ok=True)
    document.save(final_partial, garbage=3, deflate=True)
    document.close()
    del document, story, writer, device
    import gc

    gc.collect()
    final_partial.replace(target)
    partial.unlink(missing_ok=True)


def _render_pdf(
    path: str | Path,
    title: str,
    citation: str,
    name: str,
    text: str | Iterable[str],
    metadata: str = "",
    source_doc: Optional[Any] = None,
) -> None:
    _render_fitz_pdf(path, title, citation, name, text, metadata, source_doc)


class _PdfLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href = ""
        self._label: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag.casefold() == "a":
            self._href = dict(attrs).get("href") or ""
            self._label = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._label.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "a" and self._href:
            self.links.append((_normal_space(" ".join(self._label)), self._href))
            self._href = ""
            self._label = []


def _decisia_pdf_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return ""
    match = re.search(r"/item/(\d+)/index\.do$", parsed.path, re.I)
    if not match:
        return ""
    path = parsed.path[:match.start()] + f"/{match.group(1)}/1/document.do"
    return parsed._replace(path=path, query="", fragment="").geturl()


def _pdf_links_from_html(base_url: str, source_html: str) -> list[str]:
    parser = _PdfLinkParser()
    try:
        parser.feed(source_html)
    except Exception:
        return []
    ranked: list[tuple[int, int, str]] = []
    base_host = urlparse(base_url).netloc.casefold()
    for position, (label, href) in enumerate(parser.links):
        absolute = urljoin(base_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme not in {"http", "https"}:
            continue
        clue = f"{label} {parsed.path} {parsed.query}".casefold()
        score = 0
        if parsed.path.casefold().endswith(".pdf"):
            score += 50
        if "/document.do" in parsed.path.casefold():
            score += 90
        if any(word in clue for word in ("download pdf", "view pdf", "full text pdf", "full-text pdf")):
            score += 80
        elif any(word in clue for word in ("download", "viewcontent", "article/view", "galley")):
            score += 35
        elif label.strip().casefold() == "pdf":
            score += 60
        if parsed.netloc.casefold() == base_host:
            score += 15
        if score >= 50:
            ranked.append((score, -position, absolute))
    return [url for _, _, url in sorted(ranked, reverse=True)]


def _response_bytes(response: Any, limit: int = 100 * 1024 * 1024) -> bytes:
    chunks: list[bytes] = []
    size = 0
    for chunk in response.iter_content(chunk_size=256 * 1024):
        if not chunk:
            continue
        size += len(chunk)
        if size > limit:
            raise ValueError("PDF response exceeded 100 MB")
        chunks.append(chunk)
    return b"".join(chunks)


def _valid_pdf(data: bytes) -> bool:
    if not data.lstrip().startswith(b"%PDF-"):
        return False
    try:
        import fitz

        with fitz.open(stream=data, filetype="pdf") as document:
            return document.page_count > 0
    except ImportError:
        return b"%%EOF" in data[-4096:]
    except Exception:
        return False


def _is_canlii_url(value: str) -> bool:
    host = (urlparse(value).hostname or "").casefold()
    return host == "canlii.org" or host.endswith(".canlii.org")


def _render_placeholder_pdf(path: str | Path, authority: Authority) -> None:
    """Create an unmistakable tab-sized stub for a missing authority PDF."""
    import fitz

    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1))
    page.draw_rect((0, 0, 18, 792), color=None, fill=(0.22, 0.22, 0.22))
    page.insert_text((68, 102), authority.tab.upper(), fontsize=10, fontname="hebo", color=(0.2, 0.2, 0.2))
    page.insert_textbox(
        (68, 142, 544, 212),
        "SOURCE PDF UNAVAILABLE",
        fontsize=28,
        lineheight=1.05,
        fontname="hebo",
        color=(0, 0, 0),
    )
    page.draw_line((68, 224), (544, 224), color=(0.55, 0.55, 0.55), width=1.5)
    page.insert_textbox(
        (68, 262, 544, 348),
        authority.name or authority.citation,
        fontsize=18,
        lineheight=1.15,
        fontname="hebo",
        color=(0, 0, 0),
    )
    page.insert_textbox(
        (68, 356, 544, 402),
        authority.citation,
        fontsize=12,
        lineheight=1.2,
        fontname="tiro",
        color=(0.25, 0.25, 0.25),
    )
    page.insert_textbox(
        (68, 470, 544, 572),
        "The original source PDF was not available when this book was built.",
        fontsize=10.5,
        lineheight=1.45,
        fontname="helv",
        color=(0.3, 0.3, 0.3),
    )
    document.set_metadata(
        {
            "title": f"PDF required — {authority.name or authority.citation}",
            "subject": authority.citation,
            "creator": "AuthoritiesHelper",
            "producer": "PyMuPDF",
        }
    )
    target = Path(path)
    partial = target.with_suffix(".placeholder.part.pdf")
    partial.unlink(missing_ok=True)
    document.save(partial, garbage=3, deflate=True)
    document.close()
    partial.replace(target)


def _download_pdf(authority: Authority, folder: Path, mode: str, session: Any = None) -> None:
    if mode == "none":
        return
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{authority.tab.lower().replace(' ', '-')}-{_safe_slug(authority.name or authority.citation)}.pdf"
    target = folder / name
    downloaded = False
    # CanLII permits ordinary links but prohibits programmatic or systematic
    # downloading. Its PDFs are therefore attached only after a user-initiated
    # browser download; the generic publisher downloader must never request one.
    if mode in {"auto", "originals"} and authority.source_url and not _is_canlii_url(authority.source_url):
        partial = target.with_suffix(".pdf.part")
        partial.unlink(missing_ok=True)
        try:
            import requests

            parsed = urlparse(authority.source_url)
            if parsed.scheme in {"http", "https"}:
                requester = session or requests
                native_url = _decisia_pdf_url(authority.source_url)
                queue = [url for url in (native_url, authority.source_url) if url]
                seen: set[str] = set()
                while queue and len(seen) < 12 and not downloaded:
                    candidate = queue.pop(0)
                    if candidate in seen:
                        continue
                    seen.add(candidate)
                    with requester.get(
                        candidate,
                        timeout=45,
                        stream=True,
                        headers={
                            "User-Agent": "Mozilla/5.0 (compatible; AuthoritiesHelper/1.0)",
                            "Accept": "application/pdf,text/html;q=0.8,*/*;q=0.2",
                        },
                    ) as response:
                        if response.status_code != 200:
                            continue
                        data = _response_bytes(response)
                        if _valid_pdf(data):
                            partial.write_bytes(data)
                            partial.replace(target)
                            downloaded = True
                            authority.pdf_origin = "original"
                            authority.pdf_source_url = candidate
                            break
                        content_type = (response.headers.get("content-type") or "").casefold()
                        if "html" in content_type or data.lstrip().startswith((b"<!DOCTYPE", b"<html", b"<HTML")):
                            queue.extend(
                                url
                                for url in _pdf_links_from_html(
                                    candidate,
                                    data.decode(response.encoding or "utf-8", "replace"),
                                )
                                if url not in seen
                            )
        except Exception:
            partial.unlink(missing_ok=True)
            downloaded = False
    if not downloaded and (mode == "originals" or not authority.source_text.strip()):
        _render_placeholder_pdf(target, authority)
        authority.pdf_origin = "placeholder"
        authority.pdf_source_url = authority.source_url
    elif not downloaded:
        source_note = f"Reconstructed from source text · {authority.kind} · {authority.lookup_status.replace('_', ' ')}"
        if authority.source_url:
            source_note += f" · {authority.source_url}"
        source_doc = _compile_authority_sourcedoc(authority)
        _render_pdf(
            target,
            authority.tab,
            authority.citation,
            authority.name,
            authority.source_text,
            source_note,
            source_doc,
        )
        authority.pdf_origin = "reconstructed"
        authority.pdf_source_url = authority.source_url
    authority.pdf_path = str(target.resolve())


def _tesseract_command() -> Optional[str]:
    configured = os.environ.get("LEGALPDF_TESSERACT_COMMAND", "").strip()
    for candidate in (
        configured,
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        "tesseract",
    ):
        if candidate and (resolved := shutil.which(candidate)):
            return resolved
    return None


def _prepare_authority_pdf(
    authority: Authority,
    policy: str,
    progress: Optional[Callable[[str], None]] = None,
) -> Any:
    """Parse one authority PDF for this build."""
    if policy not in {"page_margin", "cited_pages", "full"}:
        raise ValueError(f"Unknown scanned-PDF policy: {policy}")
    if not authority.pdf_path or not authority.occurrences:
        return None
    _universal_engine_src()
    try:
        from legalpdf.core import parse_pdf
        from legalpdf.ocr import TesseractOCRProvider
    except ImportError as exc:
        raise RuntimeError("The legal PDF parser is unavailable.") from exc
    if progress:
        progress("Parsing PDF structure")
    tesseract = (
        _tesseract_command() if policy in {"cited_pages", "full"} else None
    )
    ocr_provider = (
        TesseractOCRProvider(command=tesseract, dpi=200) if tesseract else None
    )
    document = parse_pdf(
        authority.pdf_path,
        ocr_provider=ocr_provider,
    )
    if (
        policy in {"cited_pages", "full"}
        and ocr_provider is None
        and any(item.code == "OCR_REQUIRED" for item in document.diagnostics)
    ):
        raise RuntimeError(
            "OCR was requested for a scanned authority, but Tesseract was not found."
        )
    authority.pdf_has_text_layer = any(
        page.source != "ocr"
        and len(
            re.sub(
                r"[^A-Za-z0-9]+",
                "",
                " ".join(line.text for line in page.lines),
            )
        )
        >= 12
        for page in document.pages
    )
    authority.ocr_pages = [
        page.index for page in document.pages if page.source == "ocr"
    ]
    authority.ocr_scope = policy if authority.ocr_pages else ""
    authority._pdf_document = document
    if progress and authority.ocr_pages:
        progress(f"OCR completed for {len(authority.ocr_pages)} page(s)")
    return document


def _authority_pdf_document(authority: Authority) -> Any:
    """Reuse this build's prepared document while its source is unchanged."""
    document = getattr(authority, "_pdf_document", None)
    if document is not None:
        with Path(authority.pdf_path).open("rb") as source:
            source_hash = hashlib.file_digest(source, "sha256").hexdigest()
        if document.source_sha256 == source_hash:
            return document
    return _prepare_authority_pdf(authority, authority.ocr_scope or "page_margin")


def _page_for_printed_label(document: Any, value: int) -> Optional[int]:
    """Use only the engine's unambiguous printed-page label."""
    matches = [
        page.index
        for page in document.pages
        if str(getattr(page, "printed_label", "") or "").strip() == str(value)
    ]
    return matches[0] if len(matches) == 1 else None


def _occurrence_pdf_pages(document: Any, occurrence: Occurrence) -> list[int]:
    return sorted(
        {
            index
            for value in occurrence.page_pinpoints
            if value > 0
            and (index := _page_for_printed_label(document, value)) is not None
        }
    )


_PDF_GROUPS = (
    ("Cases", "case"),
    ("Legislation", "statute"),
    ("Secondary sources", "journal"),
    ("Other sources", "other"),
    ("Documents", "manual"),
)


def _grouped_authorities(authorities: list[Authority]) -> list[tuple[str, list[Authority]]]:
    groups: dict[str, list[Authority]] = defaultdict(list)
    kind_labels = {kind: label for label, kind in _PDF_GROUPS}
    for authority in authorities:
        groups[kind_labels.get(authority.kind, "Other sources")].append(authority)
    return [(label, groups[label]) for label, _ in _PDF_GROUPS if groups.get(label)]


def _pdf_page_footer(page: Any, page_number: int, label: str) -> None:
    width, height = page.rect.width, page.rect.height
    page.draw_line((48, height - 38), (width - 48, height - 38), color=(0.72, 0.72, 0.72), width=0.6)
    page.insert_text((48, height - 23), label, fontsize=7.5, fontname="helv", color=(0.4, 0.4, 0.4))
    page.insert_text((width - 72, height - 23), str(page_number), fontsize=8, fontname="helv", color=(0.4, 0.4, 0.4))


def _pdf_cover(document: Any, title: str, subtitle: str) -> None:
    page = document.new_page(width=612, height=792)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1))
    page.draw_rect((0, 0, 18, 792), color=None, fill=(0.18, 0.18, 0.18))
    page.draw_line((72, 166), (540, 166), color=(0.55, 0.55, 0.55), width=2.2)
    page.insert_textbox(
        (72, 188, 540, 340),
        title,
        fontsize=28,
        lineheight=1.08,
        fontname="hebo",
        color=(0, 0, 0),
    )
    page.insert_textbox(
        (72, 355, 540, 420),
        subtitle,
        fontsize=13,
        lineheight=1.3,
        fontname="tiro",
        color=(0.25, 0.25, 0.25),
    )


def write_table_of_authorities_pdf(
    authorities: list[Authority],
    output_path: str | Path,
    input_name: str,
    *,
    location_style: str = "pinpoints",
) -> None:
    """Write a standalone, bookmarked TOA with an internal category index."""
    import fitz

    grouped = _grouped_authorities(authorities)
    rows_per_page = 16
    group_pages = {
        label: max(1, math.ceil(len(items) / rows_per_page))
        for label, items in grouped
    }
    starts: dict[str, int] = {}
    next_page = 2
    for label, _ in grouped:
        starts[label] = next_page
        next_page += group_pages[label]

    document = fitz.open()
    _pdf_cover(
        document,
        "Table of Authorities",
        input_name,
    )
    contents = document.new_page(width=612, height=792)
    contents.insert_text((58, 76), "Contents", fontsize=24, fontname="hebo", color=(0, 0, 0))
    contents.insert_text(
        (58, 103),
        "Select a category to jump to its table.",
        fontsize=9.5,
        fontname="helv",
        color=(0.4, 0.4, 0.4),
    )
    contents_links: list[tuple[Any, int]] = []
    y = 145.0
    for label, items in grouped:
        contents.draw_rect((58, y - 18, 554, y + 20), color=(0.65, 0.65, 0.65), fill=(0.96, 0.96, 0.96), width=0.6)
        contents.insert_text((72, y + 4), label, fontsize=12, fontname="hebo", color=(0, 0, 0))
        contents.insert_text((390, y + 4), f"{len(items)} authorities", fontsize=9, fontname="helv", color=(0.4, 0.4, 0.4))
        contents.insert_text((526, y + 4), str(starts[label] + 1), fontsize=9, fontname="hebo", color=(0, 0, 0))
        contents_links.append((fitz.Rect(58, y - 18, 554, y + 20), starts[label]))
        y += 54
    _pdf_page_footer(contents, 2, "Table of Authorities")

    toc: list[list[Any]] = [[1, "Table of Authorities", 1], [1, "Contents", 2]]
    for label, items in grouped:
        toc.append([1, label, starts[label] + 1])
        for chunk_number, start in enumerate(range(0, len(items) or 1, rows_per_page)):
            chunk = items[start:start + rows_per_page]
            page = document.new_page(width=612, height=792)
            heading = label if chunk_number == 0 else f"{label} — continued"
            page.insert_text((48, 62), heading, fontsize=20, fontname="hebo", color=(0, 0, 0))
            page.insert_text(
                (48, 84),
                "Authority",
                fontsize=7.5,
                fontname="hebo",
                color=(0.4, 0.4, 0.4),
            )
            page.insert_text(
                (440, 84),
                {
                    "pages": "Document page",
                    "pinpoints": "Authority pinpoint",
                    "combined": "Page · pinpoint",
                }.get(location_style, "Cited at"),
                fontsize=7.5,
                fontname="hebo",
                color=(0.4, 0.4, 0.4),
            )
            row_y = 106.0
            for authority in chunk:
                page.draw_line((48, row_y + 30), (564, row_y + 30), color=(0.82, 0.82, 0.82), width=0.5)
                page.insert_text((48, row_y + 11), authority.tab, fontsize=7.5, fontname="hebo", color=(0, 0, 0))
                page.insert_textbox(
                    (91, row_y, 430, row_y + 29),
                    authority.name or authority.citation,
                    fontsize=9.2,
                    lineheight=1.12,
                    fontname="tiro",
                    color=(0, 0, 0),
                )
                cited_at = _format_cited_at(authority, location_style)
                page.insert_textbox(
                    (440, row_y, 520, row_y + 29),
                    cited_at,
                    fontsize=7.7,
                    lineheight=1.1,
                    fontname="helv",
                    color=(0.3, 0.3, 0.3),
                )
                if authority.source_url:
                    page.insert_text((530, row_y + 11), "OPEN", fontsize=7, fontname="hebo", color=(0.02, 0.34, 0.75))
                    page.insert_link(
                        {
                            "kind": fitz.LINK_URI,
                            "from": fitz.Rect(526, row_y - 2, 565, row_y + 18),
                            "uri": authority.source_url,
                        }
                    )
                row_y += 38
            _pdf_page_footer(page, page.number + 1, "Table of Authorities")
    contents = document[1]
    for rect, target_page in contents_links:
        contents.insert_link({"kind": fitz.LINK_GOTO, "from": rect, "page": target_page})
    document.set_toc(toc)
    document.set_metadata(
        {
            "title": f"Table of Authorities — {input_name}",
            "subject": "Structured table of legal authorities",
            "creator": "AuthoritiesHelper",
            "producer": "PyMuPDF",
        }
    )
    target = Path(output_path)
    partial = target.with_suffix(".part.pdf")
    partial.unlink(missing_ok=True)
    document.save(partial, garbage=3, deflate=True)
    document.close()
    partial.replace(target)


def write_combined_book_pdf(
    authorities: list[Authority],
    output_path: str | Path,
    input_name: str,
    *,
    highlight_style: str = "margin",
    book_title: str = "Book of Authorities",
    cover_pdf: str | Path = "",
    index_pdf: str | Path = "",
) -> list[dict[str, Any]]:
    """Merge the actual authority PDFs behind a clickable index and bookmarks."""
    import fitz

    book_title = _normal_space(book_title) or "Book of Authorities"
    grouped = _grouped_authorities(authorities)
    tokens: list[tuple[str, Optional[Authority]]] = []
    for label, items in grouped:
        tokens.append((label, None))
        tokens.extend(("", authority) for authority in items)
    rows_per_contents_page = 25
    chunks = [tokens[start:start + rows_per_contents_page] for start in range(0, len(tokens), rows_per_contents_page)] or [[]]
    cover_path = Path(cover_pdf) if cover_pdf else None
    index_path = Path(index_pdf) if index_pdf else None
    with fitz.open(cover_path) if cover_path else nullcontext() as custom_cover:
        cover_page_count = custom_cover.page_count if custom_cover else 1
    with fitz.open(index_path) if index_path else nullcontext() as custom_index:
        index_page_count = custom_index.page_count if custom_index else len(chunks)
    front_page_count = cover_page_count + index_page_count
    page_counts: list[int] = []
    for authority in authorities:
        with fitz.open(authority.pdf_path) as source:
            page_counts.append(source.page_count)
    authority_documents = (
        {
            authority.key: _authority_pdf_document(authority)
            for authority in authorities
            if authority.occurrences
        }
        if highlight_style in {"margin", "paragraph", "text", "sidelined"}
        else {}
    )
    starts: dict[str, int] = {}
    next_page = front_page_count
    for authority, count in zip(authorities, page_counts):
        starts[authority.key] = next_page
        next_page += count

    document = fitz.open()
    if cover_path:
        with fitz.open(cover_path) as custom_cover:
            document.insert_pdf(custom_cover)
    else:
        _pdf_cover(document, book_title, "")
    contents_rows: list[tuple[int, Authority, Any]] = []
    if index_path:
        with fitz.open(index_path) as custom_index:
            document.insert_pdf(custom_index)
    else:
        for chunk_number, chunk in enumerate(chunks, 1):
            page = document.new_page(width=612, height=792)
            heading = "Table of Contents" if chunk_number == 1 else "Table of Contents — continued"
            page.insert_text((48, 58), heading, fontsize=20, fontname="hebo", color=(0, 0, 0))
            y = 92.0
            for label, authority in chunk:
                if authority is None:
                    page.draw_rect((48, y - 12, 564, y + 12), color=None, fill=(0.92, 0.92, 0.92))
                    page.insert_text((56, y + 4), label.upper(), fontsize=8.5, fontname="hebo", color=(0, 0, 0))
                    y += 27
                    continue
                target_page = starts[authority.key]
                page.insert_text((54, y + 3), authority.tab, fontsize=7.5, fontname="hebo", color=(0, 0, 0))
                page.insert_textbox(
                    (98, y - 9, 493, y + 10),
                    authority.name or authority.citation,
                    fontsize=8.8,
                    lineheight=1.05,
                    fontname="tiro",
                    color=(0, 0, 0),
                )
                page.insert_text((532, y + 3), str(target_page + 1), fontsize=8, fontname="hebo", color=(0, 0, 0))
                rect = fitz.Rect(48, y - 11, 564, y + 11)
                contents_rows.append((page.number, authority, rect))
                page.draw_line((98, y + 13), (564, y + 13), color=(0.82, 0.82, 0.82), width=0.45)
                y += 25
            _pdf_page_footer(page, page.number + 1, book_title)

    for authority in authorities:
        with fitz.open(authority.pdf_path) as source:
            document.insert_pdf(source)
    discrepancies: list[dict[str, Any]] = []
    if highlight_style in {"margin", "paragraph", "text", "sidelined"}:
        for authority, page_count in zip(authorities, page_counts):
            discrepancies.extend(_highlight_authority_passages(
                document,
                authority,
                starts[authority.key],
                page_count,
                highlight_style,
                authority_documents.get(authority.key),
            ))
    for page_number, authority, rect in contents_rows:
        document[page_number].insert_link({"kind": fitz.LINK_GOTO, "from": rect, "page": starts[authority.key]})

    toc: list[list[Any]] = [[1, book_title, 1], [1, "Table of Contents", cover_page_count + 1]]
    for label, items in grouped:
        if not items:
            continue
        toc.append([1, label, starts[items[0].key] + 1])
        toc.extend([2, f"{authority.tab} — {authority.name or authority.citation}", starts[authority.key] + 1] for authority in items)
    document.set_toc(toc)
    document.set_metadata(
        {
            "title": book_title,
            "subject": "Navigable book of legal authorities",
            "creator": "AuthoritiesHelper",
            "producer": "PyMuPDF",
        }
    )
    target = Path(output_path)
    partial = target.with_suffix(".part.pdf")
    partial.unlink(missing_ok=True)
    document.save(partial, garbage=3, deflate=True)
    document.close()
    partial.replace(target)
    return discrepancies


def build_manual_book(
    entries: Iterable[dict[str, Any]],
    output_path: str | Path,
    *,
    book_title: str = "Book of Evidence",
    progress: Optional[Callable[[int, str], None]] = None,
) -> Path:
    """Assemble user-supplied PDFs without citation detection or resolution."""
    import fitz

    rows = list(entries)
    if not rows:
        raise ValueError("Add at least one PDF to the manual book.")
    authorities: list[Authority] = []
    for index, row in enumerate(rows, 1):
        path = Path(str(row.get("pdf_path") or ""))
        if not path.is_file():
            raise FileNotFoundError(f"PDF not found: {path}")
        try:
            with fitz.open(path) as document:
                if document.page_count < 1:
                    raise ValueError("no pages")
        except Exception as exc:
            raise ValueError(f"{path.name} is not a readable PDF: {exc}") from exc
        title = _normal_space(str(row.get("title") or path.stem)) or path.stem
        tab = _normal_space(str(row.get("tab") or f"Tab {index}")) or f"Tab {index}"
        authorities.append(
            Authority(
                key=f"manual-{index}-{hashlib.sha1(str(path.resolve()).encode('utf-8')).hexdigest()[:10]}",
                kind="manual",
                citation="",
                name=title,
                tab=tab,
                pdf_path=str(path.resolve()),
                pdf_origin="manual",
                pdf_source_url=str(path.resolve()),
            )
        )
        if progress:
            progress(10 + int(55 * index / len(rows)), f"Validated {index}/{len(rows)}: {title[:80]}")
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if progress:
        progress(75, "Assembling the indexed manual book")
    write_combined_book_pdf(
        authorities,
        output,
        book_title,
        highlight_style="none",
        book_title=book_title,
    )
    if progress:
        progress(100, "Manual book complete")
    return output


def _highlight_authority_passages(
    document: Any,
    authority: Authority,
    start_page: int,
    page_count: int,
    style: str,
    legal_document: Any,
) -> list[dict[str, Any]]:
    """Mark only passages anchored by an explicit, resolved pinpoint."""
    if legal_document is None:
        return []
    if legal_document.page_count != page_count:
        raise ValueError(f"{authority.tab} PDF artifact page count is stale.")
    pages = [document[index] for index in range(start_page, start_page + page_count)]
    discrepancies: list[dict[str, Any]] = []
    for occurrence in authority.occurrences:
        targets: dict[int, list[Any]] = {
            index: []
            for index in _occurrence_pdf_pages(legal_document, occurrence)
        }
        for fragment in occurrence.pinpoint_fragments:
            pattern = _pinpoint_pattern(fragment)
            if pattern is None:
                continue
            for local_index, areas in _pinpoint_areas(
                legal_document, fragment, pattern
            ).items():
                targets.setdefault(local_index, []).extend(areas)
        if not targets:
            continue

        if style in {"margin", "sidelined"}:
            for local_index, areas in targets.items():
                if areas:
                    _apply_passage_mark(
                        pages[local_index],
                        areas,
                        "margin",
                        _page_line_areas(legal_document.pages[local_index]),
                    )
                else:
                    _apply_full_page_margin(
                        pages[local_index],
                        _page_line_areas(legal_document.pages[local_index]),
                    )
        elif style == "paragraph":
            for local_index, areas in targets.items():
                if areas:
                    _apply_passage_mark(pages[local_index], areas, "text")

        for quote in dict.fromkeys(value for value in occurrence.exact_quotes if len(_normal_space(value)) >= 8):
            best: Optional[tuple[float, int, list[Any], str, int, list[list[Any]]]] = None
            for local_index, target_areas in targets.items():
                normalized_quote = _normal_space(quote)
                words = _page_words(legal_document.pages[local_index])
                if target_areas:
                    words = [
                        word
                        for word in words
                        if any(_rects_intersect(word[:4], area) for area in target_areas)
                    ]
                match = _best_quote_word_match(normalized_quote, words)
                if match is None:
                    continue
                score, areas, actual, word_index = match
                candidate = (score, local_index, areas, actual, word_index, words)
                if best is None or candidate[0] > best[0]:
                    best = candidate
                if candidate[0] == 1.0:
                    break
            if best is None or best[0] < 0.86:
                continue
            score, local_index, areas, actual, word_index, words = best
            discrepancy = _passage_discrepancy(
                authority,
                occurrence,
                quote,
                actual,
                score,
                local_index,
                words,
                word_index,
                getattr(legal_document.pages[local_index], "printed_label", None),
            )
            if discrepancy:
                discrepancies.append(discrepancy)
            if score == 1.0 and style in {"margin", "text"}:
                _apply_passage_mark(pages[local_index], areas, "text")
    return _dedupe_discrepancies(discrepancies)


def _pinpoint_pattern(fragment: str) -> Optional[re.Pattern[str]]:
    match = re.fullmatch(
        rf"(par|sec)({_PINPOINT_VALUE})",
        fragment,
        re.I,
    )
    if not match:
        return None
    value = re.escape(match.group(2))
    value = (
        value.replace(r"\.", r"\s*\.\s*")
        .replace(r"\-", r"\s*-\s*")
        .replace(r"\(", r"\s*\(\s*")
        .replace(r"\)", r"\s*\)")
    )
    if match.group(1).casefold() == "par":
        return re.compile(rf"^\s*\[?\s*{value}\s*\]?(?:\s|$)", re.I)
    return re.compile(rf"^\s*{value}(?:\s|$)", re.I)


def _pinpoint_areas(
    document: Any,
    fragment: str,
    pattern: re.Pattern[str],
) -> dict[int, list[list[float]]]:
    lines = {line.id: line for page in document.pages for line in page.lines}
    if fragment.casefold().startswith("sec"):
        locator = fragment[3:].casefold()
        sections = [
            section
            for section in getattr(document, "sections", ())
            if locator
            and locator
            in {
                str(section.locator or "").casefold(),
                *(str(alias).casefold() for alias in section.aliases),
            }
        ]
        if len(sections) == 1:
            matches: dict[int, list[list[float]]] = defaultdict(list)
            for line_id in sections[0].line_ids:
                line = lines.get(line_id)
                if line is not None:
                    matches[line.page_index].append(line.bbox)
            return {
                page: [_union_rect(areas)]
                for page, areas in matches.items()
            }
    matches: dict[int, list[list[float]]] = defaultdict(list)
    for paragraph in document.paragraphs:
        if not pattern.search(paragraph.text):
            continue
        paragraph_lines = [
            lines[line_id] for line_id in paragraph.line_ids if line_id in lines
        ]
        if paragraph_lines:
            matches[paragraph.page_index].append(_union_rect(
                [line.bbox for line in paragraph_lines]
            ))
    return dict(matches)


def _word_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", unicodedata.normalize("NFKD", value).casefold())


def _page_words(page: Any) -> list[list[Any]]:
    words: list[list[Any]] = []
    for line_index, line in enumerate(
        sorted(page.lines, key=lambda item: item.reading_order)
    ):
        for word_index, word in enumerate(getattr(line, "words", ())):
            if len(word.bbox) == 4 and word.text.strip():
                words.append([
                    *map(float, word.bbox),
                    word.text,
                    line_index,
                    0,
                    word_index,
                ])
    return words


def _union_rect(values: Iterable[Any]) -> list[float]:
    rectangles = [list(map(float, value)) for value in values]
    return [
        min(value[0] for value in rectangles),
        min(value[1] for value in rectangles),
        max(value[2] for value in rectangles),
        max(value[3] for value in rectangles),
    ]


def _rects_intersect(left: Any, right: Any) -> bool:
    a, b = list(map(float, left)), list(map(float, right))
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def _page_line_areas(page: Any) -> list[list[float]]:
    return [
        list(map(float, line.bbox))
        for line in page.lines
        if line.text.strip()
    ]


def _best_quote_word_match(
    quote: str,
    words: list[list[Any]],
) -> Optional[tuple[float, list[Any], str, int]]:
    wanted = [_word_key(value) for value in re.findall(r"\w+(?:[’'][\w]+)?", quote) if _word_key(value)]
    available = [_word_key(str(word[4])) for word in words]
    if len(wanted) < 2 or len(available) < len(wanted):
        return None
    best_score = 0.0
    best_start = -1
    # A small length allowance catches a dropped or inserted OCR/source word.
    for size in range(max(2, len(wanted) - 2), min(len(available), len(wanted) + 2) + 1):
        for start in range(0, len(available) - size + 1):
            candidate = available[start:start + size]
            if wanted[0] not in candidate[:3] and candidate[0] not in wanted[:3]:
                continue
            score = difflib.SequenceMatcher(None, wanted, candidate, autojunk=False).ratio()
            if score > best_score:
                best_score, best_start = score, start
                best_size = size
    if best_start < 0 or best_score < 0.70:
        return None
    selected = words[best_start:best_start + best_size]
    line_groups: dict[tuple[int, int], list[list[Any]]] = defaultdict(list)
    for word in selected:
        key = (
            int(word[5]) if len(word) > 5 else int(float(word[1]) // 8),
            int(word[6]) if len(word) > 6 else int(float(word[1]) // 8),
        )
        line_groups[key].append(word)
    areas = [_union_rect(word[:4] for word in line) for line in line_groups.values()]
    actual = " ".join(str(word[4]) for word in selected)
    return best_score, areas, actual, best_start


def _detected_paragraph(words: list[list[Any]], word_index: int) -> Optional[int]:
    for word in reversed(words[max(0, word_index - 120):word_index + 1]):
        value = str(word[4]).strip()
        match = re.fullmatch(r"\[(\d{1,5})\]", value)
        if match:
            return int(match.group(1))
    return None


def _replace_pinpoint_number(original: str, value: int) -> str:
    for pattern in (_PAR_RE, _PAGE_RE, _SECTION_RE):
        match = pattern.search(original)
        if match:
            start, end = match.span(1)
            return original[:start] + str(value) + original[end:]
    return re.sub(r"\d+(?:\.\d+)*(?:\([A-Za-z0-9]+\))*", str(value), original, count=1)


def _passage_discrepancy(
    authority: Authority,
    occurrence: Occurrence,
    expected_quote: str,
    actual_quote: str,
    score: float,
    pdf_page: int,
    words: list[list[Any]],
    word_index: int,
    printed_label: Any,
) -> Optional[dict[str, Any]]:
    reasons: list[str] = []
    if score < 0.995:
        reasons.append("quote_text")
    detected_kind = ""
    detected_value: Optional[int] = None
    authored_values = [
        int(match.group(1))
        for fragment in occurrence.pinpoint_fragments
        if (match := re.fullmatch(r"par(\d+)", fragment))
    ]
    paragraph = _detected_paragraph(words, word_index)
    if authored_values and paragraph is not None and paragraph not in authored_values:
        reasons.append("pinpoint")
        detected_kind, detected_value = "paragraph", paragraph
    elif occurrence.page_pinpoints:
        label = str(printed_label or "").strip()
        found_page = int(label) if label.isdigit() else None
        if found_page is not None and found_page not in occurrence.page_pinpoints:
            reasons.append("pinpoint")
            detected_kind, detected_value = "page", found_page
    if not reasons:
        return None
    replacement = (
        _replace_pinpoint_number(occurrence.pinpoint_text, detected_value)
        if occurrence.pinpoint_text and detected_value is not None
        else ""
    )
    identity = hashlib.sha1(
        f"{authority.key}|{occurrence.part_id}|{expected_quote}|{pdf_page}".encode("utf-8")
    ).hexdigest()[:16]
    return {
        "id": identity,
        "status": "pending",
        "reasons": reasons,
        "authority_key": authority.key,
        "authority": authority.name or authority.citation,
        "citation": authority.citation,
        "part_id": occurrence.part_id,
        "unit_key": occurrence.unit_key,
        "footnote_id": occurrence.footnote_id,
        "source_pinpoint": occurrence.pinpoint_text,
        "pinpoint_start": occurrence.pinpoint_start,
        "pinpoint_end": occurrence.pinpoint_end,
        "detected_kind": detected_kind,
        "detected_value": detected_value,
        "replacement_text": replacement,
        "expected_quote": expected_quote,
        "found_quote": actual_quote,
        "match_score": round(score, 4),
        "pdf_page": pdf_page + 1,
    }


def _dedupe_discrepancies(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return list({str(item["id"]): item for item in items}.values())


def _apply_full_page_margin(page: Any, text_areas: Iterable[Any]) -> None:
    import fitz

    visible = page.rect
    text = [
        fitz.Rect(area) * page.rotation_matrix
        for area in text_areas
    ]
    right = max((item.x1 for item in text), default=visible.x1 - 24)
    bar = fitz.Rect(
        max(right + 6, visible.x1 - 18),
        visible.y0 + 32,
        max(right + 10.5, visible.x1 - 13.5),
        max(visible.y0 + 33, visible.y1 - 32),
    )
    if bar.x1 > visible.x1 - 3 or any(bar.intersects(item) for item in text):
        return
    page.draw_rect(
        _display_to_page_rect(page, bar),
        color=None,
        fill=(0.3, 0.3, 0.3),
        fill_opacity=0.9,
        overlay=True,
    )


def _display_to_page_rect(page: Any, value: Any) -> Any:
    import fitz

    rect = fitz.Rect(value) * page.derotation_matrix
    if page.rotation and page.cropbox_position != fitz.Point(0, 0):
        position = page.cropbox_position
        rect = fitz.Rect(
            rect.x0 + position.x,
            rect.y0 - position.y,
            rect.x1 + position.x,
            rect.y1 - position.y,
        )
    return rect


def _apply_passage_mark(
    page: Any,
    areas: list[Any],
    style: str,
    page_text_areas: Iterable[Any] = (),
) -> bool:
    import fitz

    areas = [fitz.Rect(area.rect if hasattr(area, "rect") else area) for area in areas]
    rects = [
        area * page.rotation_matrix
        for area in areas
    ]
    if not rects:
        return False
    if style == "text":
        annotation = page.add_highlight_annot(areas)
        annotation.set_colors(stroke=(0.65, 0.65, 0.65))
        annotation.set_opacity(0.34)
        annotation.update()
        return True
    visible = page.rect
    top = max(visible.y0 + 2, min(rect.y0 for rect in rects))
    bottom = min(visible.y1 - 2, max(rect.y1 for rect in rects))
    text = [
        fitz.Rect(area) * page.rotation_matrix
        for area in page_text_areas
    ]
    right = max(
        rect.x1
        for rect in rects + [
            item
            for item in text
            if item.y0 < bottom and item.y1 > top
        ]
    )
    bar = fitz.Rect(max(right + 6, visible.x1 - 24), top, max(right + 10.5, visible.x1 - 19.5), bottom)
    if bar.x1 > visible.x1 - 3 or any(bar.intersects(item) for item in text):
        return False
    page.draw_rect(
        _display_to_page_rect(page, bar),
        color=None,
        fill=(0.3, 0.3, 0.3),
        fill_opacity=0.88,
        overlay=True,
    )
    return True


def _authority_from_manifest_row(row: dict[str, Any]) -> Authority:
    occurrences = [
        Occurrence(
            part_id=str(item.get("part_id") or ""),
            unit_key=str(item.get("unit_key") or ""),
            source_kind=str(item.get("source_kind") or ""),
            footnote_id=item.get("footnote_id"),
            part_index=int(item.get("part_index") or 0),
            raw_text=str(item.get("raw_text") or ""),
            citation=str(item.get("citation") or ""),
            pinpoint_fragments=list(item.get("pinpoint_fragments") or []),
            page_pinpoints=[int(value) for value in item.get("page_pinpoints") or []],
            tab=str(item.get("tab") or ""),
            proposition_text=str(item.get("proposition_text") or ""),
            exact_quotes=[str(value) for value in item.get("exact_quotes") or []],
            pinpoint_text=str(item.get("pinpoint_text") or ""),
            pinpoint_start=int(item.get("pinpoint_start", -1)),
            pinpoint_end=int(item.get("pinpoint_end", -1)),
            document_pages=[int(value) for value in item.get("document_pages") or []],
        )
        for item in row.get("occurrences", [])
        if isinstance(item, dict)
    ]
    return Authority(
        key=str(row.get("key") or ""),
        kind=str(row.get("kind") or "other"),
        citation=str(row.get("citation") or ""),
        name=str(row.get("name") or ""),
        alternate_citation=str(row.get("alternate_citation") or ""),
        dataset=str(row.get("dataset") or ""),
        date=str(row.get("date") or ""),
        source_url=str(row.get("source_url") or ""),
        lookup_status=str(row.get("lookup_status") or "not_queried"),
        lookup_method=str(row.get("lookup_method") or ""),
        tab=str(row.get("tab") or ""),
        pdf_path=str(row.get("pdf_path") or ""),
        pdf_origin=str(row.get("pdf_origin") or ""),
        pdf_source_url=str(row.get("pdf_source_url") or ""),
        pdf_has_text_layer=row.get("pdf_has_text_layer"),
        ocr_scope=str(row.get("ocr_scope") or ""),
        ocr_pages=[int(value) for value in row.get("ocr_pages") or []],
        occurrences=occurrences,
    )


def attach_manual_pdf(
    manifest_path: str | Path,
    authority_key: str,
    source_pdf: str | Path,
) -> Path:
    """Validate and stage a user PDF in one manifest slot without rebuilding."""
    import fitz

    manifest_path = Path(manifest_path)
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    row = next(
        (item for item in payload.get("authorities", []) if str(item.get("key") or "") == authority_key),
        None,
    )
    if row is None:
        raise ValueError("The selected authority is not present in this build manifest.")
    source = Path(source_pdf)
    if not source.is_file():
        raise FileNotFoundError(f"PDF not found: {source}")
    try:
        with fitz.open(source) as document:
            if document.page_count < 1:
                raise ValueError("The selected PDF has no pages.")
    except Exception as exc:
        raise ValueError(f"The selected file is not a readable PDF: {exc}") from exc

    current = Path(str(row.get("pdf_path") or ""))
    if not current.parent:
        current = manifest_path.parent / "authorities" / f"{_safe_slug(str(row.get('tab') or authority_key))}.pdf"
    current.parent.mkdir(parents=True, exist_ok=True)
    target = current if str(row.get("pdf_origin") or "") == "manual" else current.with_name(f"{current.stem}-manual.pdf")
    source_resolved = source.resolve()
    target_resolved = target.resolve()
    if source_resolved != target_resolved:
        partial = target.with_suffix(".manual.part.pdf")
        partial.unlink(missing_ok=True)
        try:
            shutil.copy2(source, partial)
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
    row["pdf_path"] = str(target)
    row["pdf_origin"] = "manual"
    row["pdf_source_url"] = str(source_resolved)
    row["pdf_has_text_layer"] = None
    row["ocr_scope"] = ""
    row["ocr_pages"] = []
    row.pop("pdf_artifact_manifest", None)
    row["manual_pdf_attached_at"] = datetime.now(timezone.utc).isoformat()
    _write_json(manifest_path, payload, indent=2)
    return target


def attach_manifest_extra_pdf(
    manifest_path: str | Path,
    slot: str,
    source_pdf: str | Path,
    *,
    title: str = "",
    tab: str = "",
    key: str = "",
) -> Path:
    """Fill an optional front-matter slot or append one unrelated PDF."""
    import fitz

    if slot not in {"cover", "index", "supplemental"}:
        raise ValueError("Extra PDF slot must be cover, index, or supplemental.")
    manifest_path = Path(manifest_path)
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    source = Path(source_pdf)
    if not source.is_file():
        raise FileNotFoundError(f"PDF not found: {source}")
    try:
        with fitz.open(source) as document:
            if document.page_count < 1:
                raise ValueError("no pages")
    except Exception as exc:
        raise ValueError(f"The selected file is not a readable PDF: {exc}") from exc
    folder = manifest_path.parent / "supplemental"
    folder.mkdir(parents=True, exist_ok=True)
    identity = key or hashlib.sha1(f"{source.resolve()}:{time.time_ns()}".encode("utf-8")).hexdigest()[:12]
    filename = f"{slot}-{_safe_slug(title or source.stem)}-{identity[:8]}.pdf"
    target = folder / filename
    partial = target.with_suffix(".part.pdf")
    partial.unlink(missing_ok=True)
    try:
        shutil.copy2(source, partial)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    if slot in {"cover", "index"}:
        front_matter = payload.setdefault("front_matter", {})
        front_matter[slot] = str(target.resolve())
    else:
        rows = payload.setdefault("supplemental_pdfs", [])
        row = next((item for item in rows if str(item.get("key") or "") == identity), None)
        values = {
            "key": identity,
            "pdf_path": str(target.resolve()),
            "title": _normal_space(title or source.stem),
            "tab": _normal_space(tab or f"Appendix {len(rows) + 1}"),
        }
        if row is None:
            rows.append(values)
        else:
            row.update(values)
    _write_json(manifest_path, payload, indent=2)
    return target


def remove_manifest_extra_pdf(manifest_path: str | Path, key: str) -> None:
    """Clear an optional front-matter slot or remove a supplemental row."""
    manifest_path = Path(manifest_path)
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if key in {"cover", "index"}:
        payload.setdefault("front_matter", {})[key] = ""
    else:
        payload["supplemental_pdfs"] = [
            row for row in payload.get("supplemental_pdfs", []) if str(row.get("key") or "") != key
        ]
    _write_json(manifest_path, payload, indent=2)


def _supplemental_authority(row: dict[str, Any], index: int) -> Authority:
    return Authority(
        key=f"supplemental-{str(row.get('key') or index)}",
        kind="manual",
        citation="",
        name=str(row.get("title") or f"Supplemental document {index}"),
        tab=str(row.get("tab") or f"Appendix {index}"),
        pdf_path=str(row.get("pdf_path") or ""),
        pdf_origin="manual",
        pdf_source_url=str(row.get("pdf_path") or ""),
    )


def finalize_manifest_book(
    manifest_path: str | Path,
    progress: Optional[Callable[[int, str], None]] = None,
    *,
    omit_placeholders: bool = False,
) -> tuple[Path, int]:
    """Rebuild the combined PDF once after manual source slots are filled."""
    manifest_path = Path(manifest_path)
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    authorities = [_authority_from_manifest_row(row) for row in payload.get("authorities", [])]
    supplemental = [
        _supplemental_authority(row, index)
        for index, row in enumerate(payload.get("supplemental_pdfs", []), 1)
        if isinstance(row, dict)
    ]
    export_authorities = [
        authority
        for authority in authorities
        if not (omit_placeholders and authority.pdf_origin == "placeholder")
    ]
    export_authorities.extend(supplemental)
    missing_files = [authority.tab for authority in export_authorities if not Path(authority.pdf_path).is_file()]
    if missing_files:
        raise FileNotFoundError(f"Authority PDFs are missing for: {', '.join(missing_files[:8])}")
    output_value = str(payload.get("outputs", {}).get("book_of_authorities_pdf") or "")
    if not output_value:
        raise ValueError("This manifest does not identify a combined book PDF.")
    output = Path(output_value)
    if progress:
        progress(25, "Validating authority PDF slots")
    import fitz

    for authority in export_authorities:
        try:
            with fitz.open(authority.pdf_path) as document:
                if document.page_count < 1:
                    raise ValueError("no pages")
        except Exception as exc:
            raise ValueError(f"{authority.tab} does not contain a readable PDF: {exc}") from exc
    if progress:
        progress(55, "Rebuilding the indexed book")
    input_name = Path(str(payload.get("input") or "Source document")).name
    front_matter = payload.get("front_matter") or {}
    highlight_style = str(payload.get("highlight_style") or "margin")
    scanned_pdf_policy = str(payload.get("scanned_pdf_policy") or "page_margin")
    if highlight_style != "none":
        for authority in export_authorities:
            _prepare_authority_pdf(
                authority,
                scanned_pdf_policy,
                (lambda message, item=authority: progress(55, f"{item.tab}: {message}"))
                if progress
                else None,
            )
    new_discrepancies = write_combined_book_pdf(
        export_authorities,
        output,
        input_name,
        highlight_style=highlight_style,
        cover_pdf=str(front_matter.get("cover") or ""),
        index_pdf=str(front_matter.get("index") or ""),
    )
    placeholders = sum(authority.pdf_origin == "placeholder" for authority in authorities)
    prepared = {authority.key: authority for authority in export_authorities}
    for row in payload.get("authorities", []):
        authority = prepared.get(str(row.get("key") or ""))
        if authority is not None:
            row.update(
                {
                    "pdf_has_text_layer": authority.pdf_has_text_layer,
                    "ocr_scope": authority.ocr_scope,
                    "ocr_pages": authority.ocr_pages,
                }
            )
            row.pop("pdf_artifact_manifest", None)
    payload["finalized_at"] = datetime.now(timezone.utc).isoformat()
    existing_discrepancies = {
        str(row.get("id") or ""): row
        for row in payload.get("discrepancies", [])
        if isinstance(row, dict)
    }
    combined_discrepancies = {
        str(row.get("id") or ""): row
        for row in new_discrepancies
        if isinstance(row, dict)
    }
    combined_discrepancies.update(existing_discrepancies)
    payload["discrepancies"] = list(combined_discrepancies.values())
    payload["placeholder_count"] = placeholders
    payload["omitted_placeholder_count"] = placeholders if omit_placeholders else 0
    _write_json(manifest_path, payload, indent=2)
    if progress:
        progress(100, "Book finalized")
    return output, placeholders


def _toa_long_name(authority: Authority) -> str:
    name = _normal_space(authority.name)
    citation = _normal_space(authority.citation)
    if not name:
        return citation
    if citation.casefold().startswith(name.casefold()):
        return citation
    if not citation or _citation_key(citation) in _citation_key(name):
        return name
    return f"{name}, {citation}"


def _toa_category(kind: str) -> int:
    return {
        "case": 1,
        "statute": 2,
        "other": 3,
        "journal": 5,
    }.get(kind, 3)


def build_project(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    review: Optional[ReviewState] = None,
    a2aj_base_url: str = "https://api.a2aj.ca",
    offline: bool = False,
    pdf_mode: str = "auto",
    tab_style: str = "numeric",
    highlight_style: str = "margin",
    scanned_pdf_policy: str = "page_margin",
    output_mode: str = "book",
    table_delivery: str = "native_append",
    table_location: str = "pages",
    excluded_authorities: Iterable[str] = (),
    progress: Optional[Callable[[int, str], None]] = None,
) -> AnalysisResult:
    def report(value: int, message: str) -> None:
        if progress:
            progress(value, message)

    input_path, output_dir = Path(input_path), Path(output_dir)
    if output_mode not in {"book", "table", "both"}:
        raise ValueError("Output mode must be book, table, or both.")
    if table_delivery not in {"native_marks", "native_append", "linked_append", "pdf_append"}:
        raise ValueError("Unknown Table of Authorities delivery mode.")
    if table_delivery == "pdf_append":
        table_delivery = "native_append"
    if table_location not in {"pages", "pinpoints", "combined"}:
        raise ValueError("Unknown Table of Authorities location style.")
    if highlight_style not in {"none", "margin", "paragraph", "text", "sidelined"}:
        raise ValueError("Unknown passage-marking style.")
    want_book = output_mode in {"book", "both"}
    want_table = output_mode in {"table", "both"}
    if input_path.suffix.lower() == ".pdf" and want_table:
        raise ValueError(
            "A table can be inserted only into a Word document. "
            "Choose Book of Authorities for a PDF."
        )
    report(2, "Preparing output folder")
    output_dir.mkdir(parents=True, exist_ok=True)
    review = review or review_document(input_path)
    if not any(unit.footnote_refs for unit in review.units if unit.kind == "body"):
        fresh_units = {unit.key: unit for unit in extract_source_units(input_path)}
        for unit in review.units:
            fresh = fresh_units.get(unit.key)
            if fresh is not None:
                unit.footnote_refs = list(fresh.footnote_refs)
    report(7, f"Loaded {len(review.parts)} reviewed citation occurrences")
    client = A2AJClient(a2aj_base_url, offline=offline)
    analysis = resolve_review(
        review,
        client,
        lambda current, total, citation: report(
            8 + int(34 * current / max(1, total)),
            f"Resolving citation {current}/{total}: {citation[:90]}",
        ),
    )
    report(44, f"Resolved {len(analysis.authorities)} canonical authorities")
    excluded_values = {_normal_space(value).casefold() for value in excluded_authorities if _normal_space(value)}
    excluded_keys = {_citation_key(value) for value in excluded_authorities if _citation_key(value)}
    book_authorities: list[Authority] = []
    for authority in analysis.authorities:
        identities = {
            _normal_space(value).casefold()
            for value in (authority.name, authority.citation, authority.alternate_citation)
            if _normal_space(value)
        }
        citation_keys = {
            _citation_key(value)
            for value in (authority.name, authority.citation, authority.alternate_citation)
            if _citation_key(value)
        }
        if identities & excluded_values or citation_keys & excluded_keys:
            authority.tab = "Not reproduced"
        else:
            book_authorities.append(authority)
    assign_tabs(book_authorities, tab_style)
    stem = input_path.stem
    annotated_path = output_dir / f"{stem}.annotated.docx"
    placements: dict[str, list[tuple[int, str]]] = defaultdict(list)
    toa_entries: dict[str, list[tuple[int, str, str, int]]] = defaultdict(list)
    parts_by_id = {part.part_id: part for part in review.parts}
    for authority in analysis.authorities:
        for occurrence in authority.occurrences:
            part = parts_by_id.get(occurrence.part_id)
            if part is not None:
                offset = part.authority_end if part.start <= part.authority_end <= part.end else part.end
                if want_book and authority in book_authorities:
                    placements[part.unit_key].append((offset, f" [{authority.tab}]"))
                if want_table:
                    toa_entries[part.unit_key].append(
                        (
                            offset,
                            _toa_long_name(authority),
                            authority.name or authority.citation,
                            _toa_category(authority.kind),
                        )
                    )
    if want_table:
        report(50, "Marking the source document")
        annotate_docx(
            input_path,
            annotated_path,
            placements,
            toa_entries=toa_entries if table_delivery != "linked_append" else None,
            append_native_toa=table_delivery == "native_append",
            linked_toa=(
                [(_toa_long_name(authority), authority.source_url) for authority in analysis.authorities]
                if table_delivery == "linked_append"
                else None
            ),
        )
    download_session: Any = None
    if want_book and pdf_mode in {"auto", "originals"}:
        try:
            import requests

            download_session = requests.Session()
        except ImportError:
            download_session = None
    try:
        download_authorities = book_authorities if want_book else []
        total_authorities = len(download_authorities)
        for authority_number, authority in enumerate(download_authorities, 1):
            report(
                60 + int(20 * authority_number / max(1, total_authorities)),
                f"Preparing authority {authority_number}/{total_authorities}: {authority.name[:80]}",
            )
            _download_pdf(authority, output_dir / "authorities", pdf_mode, download_session)
            if highlight_style != "none":
                progress_value = 60 + int(20 * authority_number / max(1, total_authorities))
                _prepare_authority_pdf(
                    authority,
                    scanned_pdf_policy,
                    lambda message, value=progress_value, item=authority: report(
                        value,
                        f"{item.tab}: {message}",
                    ),
                )
            origin_label = {
                "original": "original PDF",
                "placeholder": "PDF placeholder — manual source required",
                "reconstructed": "structured reconstruction",
            }.get(authority.pdf_origin, authority.pdf_origin or "PDF prepared")
            report(
                60 + int(20 * authority_number / max(1, total_authorities)),
                f"{authority.tab}: {origin_label}",
            )
    finally:
        if download_session is not None:
            download_session.close()
    combined_pdf = output_dir / f"{stem}.book-of-authorities.pdf"
    discrepancies: list[dict[str, Any]] = []
    if want_book and pdf_mode != "none":
        report(91, "Merging authority PDFs behind the clickable contents")
        discrepancies = write_combined_book_pdf(
            book_authorities,
            combined_pdf,
            input_path.name,
            highlight_style=highlight_style,
        )
    authority_rows = []
    for authority in (book_authorities if want_book else analysis.authorities):
        row = asdict(authority)
        row.pop("source_text", None)
        row.pop("source_sections", None)
        row["source_text_length"] = len(authority.source_text)
        authority_rows.append(row)
    manifest = {
        "version": 1,
        "input": str(input_path.resolve()),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "output_mode": output_mode,
        "table_delivery": table_delivery,
        "table_location": table_location,
        "highlight_style": highlight_style,
        "scanned_pdf_policy": scanned_pdf_policy,
        "discrepancies": discrepancies,
        "excluded_authorities": sorted(excluded_values),
        "front_matter": {"cover": "", "index": ""},
        "supplemental_pdfs": [],
        "placeholder_count": sum(authority.pdf_origin == "placeholder" for authority in book_authorities)
        if want_book
        else 0,
        "outputs": {
            "annotated_docx": str(annotated_path.resolve()) if want_table else "",
            "book_of_authorities_pdf": (
                str(combined_pdf.resolve()) if want_book and pdf_mode != "none" else ""
            ),
        },
        "review": review.to_dict(),
        "authorities": authority_rows,
        "unresolved": analysis.unresolved,
        "part_links": analysis.part_links,
    }
    report(97, "Writing the build manifest")
    _write_json(output_dir / f"{stem}.toa-manifest.json", manifest, indent=2)
    report(100, "Build complete")
    return analysis


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build a deterministic table or book of authorities from a DOCX or PDF."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    detect = sub.add_parser("detect", help="Detect authority occurrences and write a review JSON.")
    detect.add_argument("input", type=Path)
    detect.add_argument("--review", type=Path)
    detect.add_argument("--compact", action="store_true", help=argparse.SUPPRESS)
    detect.add_argument("--enrich-spans", action="store_true", help=argparse.SUPPRESS)
    detect.add_argument("--offline", action="store_true", help=argparse.SUPPRESS)
    detect.add_argument("--progress", action="store_true", help=argparse.SUPPRESS)
    detect.add_argument(
        "--split-fallback",
        choices=("off", "auto"),
        default="off",
        help=argparse.SUPPRESS,
    )
    detect.add_argument(
        "--split-model",
        default=os.environ.get("MIKE_DOCX_LINK_MODEL", "gpt-5.6-sol"),
        help=argparse.SUPPRESS,
    )
    detect.add_argument(
        "--split-effort",
        default=os.environ.get("MIKE_DOCX_LINK_EFFORT", "none"),
        help=argparse.SUPPRESS,
    )

    build = sub.add_parser("build", help="Resolve citations and create DOCX/PDF outputs.")
    build.add_argument("input", type=Path)
    build.add_argument("--output", type=Path, default=None)
    build.add_argument("--review", type=Path, help="Use a browser-edited review JSON.")
    build.add_argument("--offline", action="store_true", help="Use only cached A2AJ responses and do not make network requests.")
    build.add_argument("--a2aj-base-url", default="https://api.a2aj.ca")
    build.add_argument(
        "--pdf-mode",
        choices=("auto", "originals", "render", "none"),
        default="auto",
    )
    build.add_argument("--tab-style", choices=("numeric", "alpha"), default="numeric")
    build.add_argument("--output-mode", choices=("book", "table", "both"), default="book")
    build.add_argument(
        "--table-delivery",
        choices=("native_marks", "native_append", "linked_append", "pdf_append"),
        default="native_append",
        help="Word delivery mode; pdf_append is retained as an alias for native_append.",
    )
    build.add_argument(
        "--table-location",
        choices=("pages", "pinpoints", "combined"),
        default="pages",
    )
    build.add_argument(
        "--highlight-style",
        choices=("none", "margin", "paragraph", "text", "sidelined"),
        default="margin",
        help=(
            "How cited passages are marked: margin marks resolved paragraphs and "
            "exact quotes; sidelined adds only a black paragraph line; paragraph "
            "highlights the whole resolved paragraph; text highlights exact quotes."
        ),
    )
    build.add_argument(
        "--scanned-pdf-policy",
        choices=("page_margin", "cited_pages", "full"),
        default="page_margin",
        help="How scanned original PDFs are handled when cited passages need marking.",
    )
    build.add_argument(
        "--exclude-file",
        type=Path,
        help="UTF-8 text file containing one authority name or citation per line to omit from the book.",
    )
    build.add_argument("--progress", action="store_true", help=argparse.SUPPRESS)

    lookup = sub.add_parser("lookup", help="Query one exact authority through A2AJ.")
    lookup.add_argument("citation")
    lookup.add_argument("--kind", choices=("case", "statute"), default="case")
    lookup.add_argument("--cache", type=Path)
    lookup.add_argument("--offline", action="store_true")
    lookup.add_argument("--a2aj-base-url", default="https://api.a2aj.ca")

    attach = sub.add_parser("attach-pdf", help="Fill one authority PDF slot recorded in a build manifest.")
    attach.add_argument("manifest", type=Path)
    attach.add_argument("authority_key")
    attach.add_argument("pdf", type=Path)

    attach_extra = sub.add_parser("attach-extra-pdf", help="Fill optional front matter or add an unrelated PDF.")
    attach_extra.add_argument("manifest", type=Path)
    attach_extra.add_argument("slot", choices=("cover", "index", "supplemental"))
    attach_extra.add_argument("pdf", type=Path)
    attach_extra.add_argument("--title", default="")
    attach_extra.add_argument("--tab", default="")
    attach_extra.add_argument("--key", default="")

    remove_extra = sub.add_parser("remove-extra-pdf", help="Clear optional front matter or remove an unrelated PDF.")
    remove_extra.add_argument("manifest", type=Path)
    remove_extra.add_argument("key")

    finalize = sub.add_parser("finalize-book", help="Rebuild a combined book from the PDFs recorded in its manifest.")
    finalize.add_argument("manifest", type=Path)
    finalize.add_argument(
        "--omit-placeholders",
        action="store_true",
        help="Leave unresolved PDF placeholder pages out of the finalized book.",
    )
    finalize.add_argument("--progress", action="store_true", help=argparse.SUPPRESS)

    manual = sub.add_parser("manual-book", help="Build an indexed PDF from an ordered list of user PDFs.")
    manual.add_argument("project", type=Path, help="JSON file containing book_title and entries.")
    manual.add_argument("--output", type=Path, required=True)
    manual.add_argument("--progress", action="store_true", help=argparse.SUPPRESS)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "detect":
        review = review_document(
            args.input,
            split_fallback=args.split_fallback,
            split_model=args.split_model,
            split_effort=args.split_effort,
        )
        if args.progress:
            print(f"PROGRESS\t10\tDetected {len(review.parts)} citation occurrences", flush=True)
        if args.enrich_spans:
            enrich_review_authority_spans(
                review,
                A2AJClient(
                    offline=args.offline,
                ),
                (
                    lambda current, total, citation: print(
                        f"PROGRESS\t{10 + int(85 * current / max(1, total))}\t"
                        f"Confirming full citation {current}/{total}: {citation[:90]}",
                        flush=True,
                    )
                )
                if args.progress
                else None,
            )
        path = args.review or args.input.with_suffix(".toa-review.json")
        review.save(path, compact=args.compact)
        if args.progress:
            print("PROGRESS\t100\tCitation review ready", flush=True)
        print(f"Detected {len(review.parts)} authority occurrences across {len(review.units)} relevant text units.")
        print(path)
        return 0
    if args.command == "build":
        review = ReviewState.load(args.review) if args.review else None
        output = args.output or args.input.with_name(f"{args.input.stem}-toa")
        excluded_authorities: list[str] = []
        if args.exclude_file:
            excluded_authorities = [
                line.strip()
                for line in args.exclude_file.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
        analysis = build_project(
            args.input,
            output,
            review=review,
            a2aj_base_url=args.a2aj_base_url,
            offline=args.offline,
            pdf_mode=args.pdf_mode,
            tab_style=args.tab_style,
            highlight_style=args.highlight_style,
            scanned_pdf_policy=args.scanned_pdf_policy,
            output_mode=args.output_mode,
            table_delivery=args.table_delivery,
            table_location=args.table_location,
            excluded_authorities=excluded_authorities,
            progress=(lambda value, message: print(f"PROGRESS\t{value}\t{message}", flush=True)) if args.progress else None,
        )
        print(f"Built {len(analysis.authorities)} authorities and {len(analysis.unresolved)} unresolved references.")
        print(output)
        return 0
    if args.command == "lookup":
        client = A2AJClient(args.a2aj_base_url, args.cache, offline=args.offline)
        lookup = client.lookup(args.citation, args.kind)
        print(json.dumps(asdict(lookup), ensure_ascii=False, indent=2))
        return 0 if lookup.status == "found" else 2
    if args.command == "attach-pdf":
        target = attach_manual_pdf(args.manifest, args.authority_key, args.pdf)
        print(f"Attached PDF to {args.authority_key}: {target}")
        return 0
    if args.command == "attach-extra-pdf":
        target = attach_manifest_extra_pdf(
            args.manifest,
            args.slot,
            args.pdf,
            title=args.title,
            tab=args.tab,
            key=args.key,
        )
        print(f"Attached {args.slot} PDF: {target}")
        return 0
    if args.command == "remove-extra-pdf":
        remove_manifest_extra_pdf(args.manifest, args.key)
        print(f"Removed extra PDF slot: {args.key}")
        return 0
    if args.command == "finalize-book":
        output, placeholders = finalize_manifest_book(
            args.manifest,
            progress=(lambda value, message: print(f"PROGRESS\t{value}\t{message}", flush=True)) if args.progress else None,
            omit_placeholders=args.omit_placeholders,
        )
        detail = "omitted" if args.omit_placeholders else "remaining"
        print(f"Finalized book with {placeholders} placeholder PDFs {detail}: {output}")
        return 0
    if args.command == "manual-book":
        project = json.loads(args.project.read_text(encoding="utf-8"))
        output = build_manual_book(
            project.get("entries", []),
            args.output,
            book_title=str(project.get("book_title") or "Book of Evidence"),
            progress=(lambda value, message: print(f"PROGRESS\t{value}\t{message}", flush=True)) if args.progress else None,
        )
        print(f"Built manual book with {len(project.get('entries', []))} PDFs: {output}")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

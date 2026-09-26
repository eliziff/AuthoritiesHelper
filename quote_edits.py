"""Build source-faithful quotation edits with brackets and ellipses.

The alignment rules are a compact port of the deterministic correction path in
ALR Quote Verifier. This module has no document or GUI dependencies.
"""
from __future__ import annotations

import difflib
import re
from functools import lru_cache


_WORD = r"[^\W_]+(?:['\u2019][^\W_]+)*"
_TOKEN_RE = re.compile(rf"\.\.\.|\[[^\]]+\]|{_WORD}|[\"\u201c\u201d\u2018\u2019]|[^\w\s]")
_WORD_RE = re.compile(_WORD)
_DOUBLE_QUOTES = {'"', "“", "”", "«", "»", "„"}
_SINGLE_QUOTES = {"'", "‘", "’", "‚"}
_QUOTES = _DOUBLE_QUOTES | _SINGLE_QUOTES
_DASHES = {"-", "\u00ad", "‐", "‑", "‒", "–", "—", "―", "−"}
_BRACKET_INITIAL_RE = re.compile(r"\[([A-Za-z])\]([A-Za-z]+)")
_PLAIN_WORD_RE = re.compile(r"[^\W_]+(?:'[^\W_]+)*")


def _is_word(token: str) -> bool:
    return bool(_WORD_RE.search(token or ""))


def _mergeable(token: str) -> bool:
    return _is_word(token) or (token.startswith("[") and token.endswith("]"))


@lru_cache(maxsize=256)
def _tokens(text: str) -> tuple[str, ...]:
    raw = [(match.group(0), match.start(), match.end()) for match in _TOKEN_RE.finditer(text or "")]
    merged: list[str] = []
    index = 0
    while index < len(raw):
        token, _start, end = raw[index]
        following = index + 1
        while (
            following < len(raw)
            and end == raw[following][1]
            and _mergeable(token)
            and _mergeable(raw[following][0])
        ):
            token += raw[following][0]
            end = raw[following][2]
            following += 1
        merged.append(token)
        index = following
    return tuple(merged)


@lru_cache(maxsize=4096)
def _equivalent(token: str) -> str:
    if token in _DOUBLE_QUOTES:
        return '"'
    if token in _SINGLE_QUOTES:
        return "'"
    if token in _DASHES:
        return "-"
    normalized = (token or "").replace("’", "'").replace("‘", "'")
    normalized = normalized.translate(str.maketrans({dash: "-" for dash in _DASHES}))
    initial = _BRACKET_INITIAL_RE.fullmatch(normalized)
    if initial:
        normalized = initial.group(1) + initial.group(2)
    return normalized.lower() if _PLAIN_WORD_RE.fullmatch(normalized) else normalized


def _internal_insertion(authored: str, source: str) -> str:
    if not authored or not source or any(char in authored + source for char in "[]"):
        return ""
    matcher = difflib.SequenceMatcher(a=source, b=authored, autojunk=False)
    opcodes = matcher.get_opcodes()
    insertions = [opcode for opcode in opcodes if opcode[0] == "insert"]
    if len(insertions) != 1 or any(opcode[0] not in {"equal", "insert"} for opcode in opcodes):
        return ""
    equal = sum(i2 - i1 for tag, i1, i2, _j1, _j2 in opcodes if tag == "equal")
    inserted = sum(j2 - j1 for tag, _i1, _i2, j1, j2 in insertions)
    if equal < min(3, len(source)) or inserted > max(4, len(source) // 2 + 1):
        return ""
    return "".join(
        source[i1:i2] if tag == "equal" else f"[{authored[j1:j2]}]"
        for tag, i1, i2, j1, j2 in opcodes
    )


def _format_authored(tokens: list[str], source_tokens: list[str] | None = None) -> list[str]:
    if not tokens:
        return []
    if source_tokens and len(tokens) == len(source_tokens) == 1:
        authored, source = tokens[0], source_tokens[0]
        if _is_word(authored) and _is_word(source):
            if (
                len(authored) == len(source)
                and authored[1:] == source[1:]
                and authored[0].lower() == source[0].lower()
                and authored[0] != source[0]
            ):
                return [f"[{authored[0]}]{authored[1:]}"]
            internal = _internal_insertion(authored, source)
            if internal:
                return [internal]
    if len(tokens) == 1:
        token = tokens[0]
        if "[" in token and "]" in token:
            return [token]
        return [f"[{token}]"] if _is_word(token) else [token]
    if any("[" in token and "]" in token for token in tokens):
        return tokens
    return [f"[{_join(tokens)}]"] if any(_is_word(token) for token in tokens) else tokens


def _equal_source(source: list[str], authored: list[str]) -> list[str]:
    if len(source) != len(authored):
        return source
    result: list[str] = []
    for source_token, authored_token in zip(source, authored):
        if source_token == authored_token:
            result.append(source_token)
        elif _BRACKET_INITIAL_RE.fullmatch(authored_token or ""):
            result.append(authored_token)
        elif (
            _is_word(authored_token)
            and _is_word(source_token)
            and len(authored_token) == len(source_token)
            and authored_token[1:] == source_token[1:]
            and authored_token[0].lower() == source_token[0].lower()
        ):
            result.append(f"[{authored_token[0]}]{authored_token[1:]}")
        else:
            result.append(source_token)
    return result


def _join(tokens: list[str]) -> str:
    output = ""
    open_double = open_single = False
    previous = ""
    previous_role = ""
    for token in tokens:
        token = "-" if token in _DASHES else token
        role = ""
        if token == '"':
            role = "close" if open_double else "open"
            open_double = not open_double
        elif token == "'":
            role = "close" if open_single else "open"
            open_single = not open_single
        elif token in {"“", "«", "„", "‘", "‚"}:
            role = "open"
        elif token in {"”", "»", "’"}:
            role = "close"
        if not output:
            output = token
        elif token == "-" or previous == "-":
            output = output.rstrip() + token
        elif role == "close" or token in {")", "]", "}", ",", ".", ";", ":", "!", "?"}:
            output += token
        elif previous in {"(", "[", "{"} or previous_role == "open":
            output += token
        else:
            output += " " + token
        previous, previous_role = token, role
    return re.sub(r"\s+", " ", output).strip()


def editorial_quote(authored_quote: str, source_quote: str) -> str:
    """Render the authored meaning as a source-faithful bracket/ellipsis quote."""
    authored = list(_tokens((authored_quote or "").strip()))
    source = list(_tokens((source_quote or "").strip()))
    if not authored:
        return source_quote.strip()
    if not source:
        return authored_quote.strip()
    matcher = difflib.SequenceMatcher(
        a=[_equivalent(token) for token in source],
        b=[_equivalent(token) for token in authored],
        autojunk=False,
    )
    output: list[str] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            output.extend(_equal_source(source[i1:i2], authored[j1:j2]))
        elif tag == "delete":
            if any(_is_word(token) for token in source[i1:i2]) and output and j1 < len(authored):
                if output[-1] != "...":
                    output.append("...")
            else:
                output.extend(source[i1:i2])
        elif tag == "insert":
            output.extend(_format_authored(authored[j1:j2]))
        else:
            output.extend(_format_authored(authored[j1:j2], source[i1:i2]))
    return _join(output)

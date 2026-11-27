"""Minimal, dependency-free YAML reader/writer.

Supports the subset of YAML used by Holchin project files (and most hand-edited
configuration files):

* block mappings and block sequences (including ``- key: value`` items)
* plain, single-quoted and double-quoted scalars
* ``|`` / ``>`` block scalars (with ``-`` / ``+`` chomping indicators)
* flow collections ``[a, b]`` and ``{k: v}`` (nestable)
* ``#`` comments, ``---`` document start, ``...`` document end
* null / bool / int / float resolution following the YAML 1.2 core schema

It does not support anchors/aliases, tags, multi-document streams or complex keys.
"""

from __future__ import annotations

import re

__all__ = ["load", "dump", "YAMLError"]


class YAMLError(ValueError):
    pass


# --------------------------------------------------------------------------- scalars

_INT_RE = re.compile(r"^[-+]?(0|[1-9][0-9_]*)$")
_HEX_RE = re.compile(r"^0x[0-9a-fA-F]+$")
_FLOAT_RE = re.compile(r"^[-+]?(\.[0-9]+|[0-9][0-9_]*(\.[0-9]*)?)([eE][-+]?[0-9]+)?$")


def _resolve_plain(s: str):
    if s in ("", "~", "null", "Null", "NULL"):
        return None
    if s in ("true", "True", "TRUE"):
        return True
    if s in ("false", "False", "FALSE"):
        return False
    if _INT_RE.match(s):
        return int(s.replace("_", ""))
    if _HEX_RE.match(s):
        return int(s, 16)
    if _FLOAT_RE.match(s):
        return float(s.replace("_", ""))
    if s in (".inf", ".Inf", "+.inf"):
        return float("inf")
    if s in ("-.inf", "-.Inf"):
        return float("-inf")
    if s in (".nan", ".NaN"):
        return float("nan")
    return s


_ESCAPES = {
    "0": "\0", "a": "\a", "b": "\b", "t": "\t", "\t": "\t", "n": "\n", "v": "\v",
    "f": "\f", "r": "\r", "e": "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\",
    "N": "\x85", "_": "\xa0",
}


def _unescape_double(body: str) -> str:
    out, i = [], 0
    while i < len(body):
        c = body[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        i += 1
        if i >= len(body):
            raise YAMLError("dangling escape in double-quoted string")
        e = body[i]
        if e in _ESCAPES:
            out.append(_ESCAPES[e])
            i += 1
        elif e in "xuU":
            n = {"x": 2, "u": 4, "U": 8}[e]
            out.append(chr(int(body[i + 1:i + 1 + n], 16)))
            i += 1 + n
        else:
            raise YAMLError(f"unknown escape \\{e}")
    return "".join(out)


def _strip_comment(s: str) -> str:
    """Remove a trailing comment from a line, respecting quotes."""
    q = None
    i = 0
    while i < len(s):
        c = s[i]
        if q:
            if q == '"' and c == "\\":
                i += 2
                continue
            if c == q:
                if q == "'" and i + 1 < len(s) and s[i + 1] == "'":
                    i += 2
                    continue
                q = None
        elif c in "'\"" and (i == 0 or s[i - 1] in " \t[{,:-"):
            q = c
        elif c == "#" and (i == 0 or s[i - 1] in " \t"):
            return s[:i].rstrip()
        i += 1
    return s.rstrip()


def _find_mapping_colon(s: str) -> int:
    """Index of the ``: `` separating key and value at top level, or -1."""
    q = None
    depth = 0
    i = 0
    while i < len(s):
        c = s[i]
        if q:
            if q == '"' and c == "\\":
                i += 2
                continue
            if c == q:
                if q == "'" and i + 1 < len(s) and s[i + 1] == "'":
                    i += 2
                    continue
                q = None
        elif c in "'\"" and (i == 0 or s[i - 1] in " \t[{,:"):
            q = c
        elif c in "[{":
            depth += 1
        elif c in "]}":
            depth -= 1
        elif c == ":" and depth == 0 and (i + 1 == len(s) or s[i + 1] in " \t"):
            return i
        i += 1
    return -1


def _parse_key(k: str):
    k = k.strip()
    if k.startswith('"') and k.endswith('"') and len(k) >= 2:
        return _unescape_double(k[1:-1])
    if k.startswith("'") and k.endswith("'") and len(k) >= 2:
        return k[1:-1].replace("''", "'")
    v = _resolve_plain(k)
    return v if isinstance(v, (str, int)) or v is None else k


# --------------------------------------------------------------------------- flow parser

class _Flow:
    def __init__(self, text: str):
        self.s = text
        self.i = 0

    def ws(self):
        while self.i < len(self.s) and self.s[self.i] in " \t\r\n":
            self.i += 1

    def parse(self):
        self.ws()
        v = self.value()
        self.ws()
        if self.i != len(self.s):
            raise YAMLError(f"unexpected trailing content in flow value: {self.s!r}")
        return v

    def value(self):
        self.ws()
        if self.i >= len(self.s):
            return None
        c = self.s[self.i]
        if c == "[":
            return self.seq()
        if c == "{":
            return self.map()
        if c == '"':
            return self.dq()
        if c == "'":
            return self.sq()
        return self.plain()

    def seq(self):
        self.i += 1
        out = []
        while True:
            self.ws()
            if self.i >= len(self.s):
                raise YAMLError("unterminated flow sequence")
            if self.s[self.i] == "]":
                self.i += 1
                return out
            out.append(self.value())
            self.ws()
            if self.i < len(self.s) and self.s[self.i] == ",":
                self.i += 1

    def map(self):
        self.i += 1
        out = {}
        while True:
            self.ws()
            if self.i >= len(self.s):
                raise YAMLError("unterminated flow mapping")
            if self.s[self.i] == "}":
                self.i += 1
                return out
            c = self.s[self.i]
            if c == '"':
                k = self.dq()
            elif c == "'":
                k = self.sq()
            else:
                k = self.plain(key=True)
            self.ws()
            v = None
            if self.i < len(self.s) and self.s[self.i] == ":":
                self.i += 1
                v = self.value()
            out[k] = v
            self.ws()
            if self.i < len(self.s) and self.s[self.i] == ",":
                self.i += 1

    def dq(self):
        j = self.i + 1
        while j < len(self.s):
            if self.s[j] == "\\":
                j += 2
                continue
            if self.s[j] == '"':
                break
            j += 1
        else:
            raise YAMLError("unterminated double-quoted string")
        body = self.s[self.i + 1:j]
        self.i = j + 1
        return _unescape_double(body)

    def sq(self):
        j = self.i + 1
        out = []
        while j < len(self.s):
            if self.s[j] == "'":
                if j + 1 < len(self.s) and self.s[j + 1] == "'":
                    out.append("'")
                    j += 2
                    continue
                break
            out.append(self.s[j])
            j += 1
        else:
            raise YAMLError("unterminated single-quoted string")
        self.i = j + 1
        return "".join(out)

    def plain(self, key=False):
        j = self.i
        while j < len(self.s):
            c = self.s[j]
            if c in ",]}":
                break
            if c == ":" and (j + 1 == len(self.s) or self.s[j + 1] in " ,]}"):
                break
            j += 1
        tok = self.s[self.i:j].strip()
        self.i = j
        return _parse_key(tok) if key else _resolve_plain(tok)


def _parse_scalar_text(text: str):
    text = text.strip()
    if not text:
        return None
    c = text[0]
    if c in "[{\"'":
        return _Flow(text).parse()
    return _resolve_plain(text)


# --------------------------------------------------------------------------- block parser

class _Line:
    __slots__ = ("indent", "text", "raw", "no")

    def __init__(self, indent, text, raw, no):
        self.indent, self.text, self.raw, self.no = indent, text, raw, no


class _Parser:
    def __init__(self, text: str):
        self.raw_lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        self.lines: list[_Line] = []
        for no, raw in enumerate(self.raw_lines):
            if "\t" in raw[: len(raw) - len(raw.lstrip())]:
                raise YAMLError(f"line {no + 1}: tabs are not allowed for indentation")
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                self.lines.append(_Line(-1, "", raw, no))
                continue
            if stripped in ("---", "..."):
                self.lines.append(_Line(-1, "", raw, no))
                continue
            if stripped.startswith("--- "):
                raw = raw.replace("--- ", "    ", 1)
            ind = len(raw) - len(raw.lstrip(" "))
            self.lines.append(_Line(ind, raw[ind:], raw, no))
        self.pos = 0

    # helpers
    def _skip_blank(self):
        while self.pos < len(self.lines) and self.lines[self.pos].indent < 0:
            self.pos += 1

    def _peek(self):
        self._skip_blank()
        return self.lines[self.pos] if self.pos < len(self.lines) else None

    def parse(self):
        ln = self._peek()
        if ln is None:
            return None
        v = self._node(ln.indent)
        if self._peek() is not None:
            ln = self._peek()
            raise YAMLError(f"line {ln.no + 1}: unexpected content {ln.text!r}")
        return v

    def _node(self, indent):
        ln = self._peek()
        if ln is None or ln.indent < indent:
            return None
        t = ln.text
        if t == "-" or t.startswith("- "):
            return self._seq(ln.indent)
        if _find_mapping_colon(_strip_comment(t)) >= 0:
            return self._map(ln.indent)
        # multi-line plain/flow scalar
        self.pos += 1
        parts = [_strip_comment(t)]
        while True:
            nx = self._peek()
            if nx is None or nx.indent < indent:
                break
            parts.append(_strip_comment(nx.text))
            self.pos += 1
        return _parse_scalar_text(" ".join(parts))

    def _block_scalar(self, header: str, parent_indent: int):
        style = header[0]
        chomp = "clip"
        explicit = None
        for ch in header[1:]:
            if ch == "-":
                chomp = "strip"
            elif ch == "+":
                chomp = "keep"
            elif ch.isdigit():
                explicit = int(ch)
        # raw lines after current self.pos (which already points past header line)
        body = []
        block_indent = None if explicit is None else parent_indent + explicit
        while self.pos < len(self.lines):
            ln = self.lines[self.pos]
            raw = ln.raw
            if raw.strip() == "":
                body.append("")
                self.pos += 1
                continue
            ind = len(raw) - len(raw.lstrip(" "))
            if block_indent is None:
                if ind <= parent_indent:
                    break
                block_indent = ind
            if ind < block_indent:
                break
            body.append(raw[block_indent:])
            self.pos += 1
        # trailing blank lines belong to chomping
        trailing = 0
        while body and body[-1] == "":
            body.pop()
            trailing += 1
        # un-consume trailing blank lines so they're skipped normally (harmless)
        if style == "|":
            text = "\n".join(body)
        else:
            out, prev_blank = [], False
            for b in body:
                if b == "":
                    out.append("\n")
                    prev_blank = True
                elif b.startswith(" "):
                    out.append(("\n" if out and not prev_blank else "") + b)
                    prev_blank = False
                else:
                    if out and not prev_blank and not out[-1].endswith("\n"):
                        out.append(" ")
                    out.append(b)
                    prev_blank = False
            text = "".join(out)
        if not body:
            return ""
        if chomp == "strip":
            return text
        if chomp == "keep":
            return text + "\n" * (trailing + 1)
        return text + "\n"

    def _value_after_indicator(self, rest: str, indent: int):
        """Parse the value following ``key:`` or ``-`` on the same line."""
        rest = _strip_comment(rest).strip()
        if rest and rest[0] in "|>" and re.fullmatch(r"[|>][-+0-9]*", rest):
            self.pos += 1
            return self._block_scalar(rest, indent)
        if rest == "":
            self.pos += 1
            nx = self._peek()
            if nx is None:
                return None
            if nx.indent > indent:
                return self._node(nx.indent)
            # sequences may sit at the same indent as their parent key
            if nx.indent == indent and (nx.text == "-" or nx.text.startswith("- ")):
                return self._seq(indent)
            return None
        self.pos += 1
        # continuation lines for multi-line flow / plain scalars
        if rest[0] in "[{" or rest[0] in "\"'":
            buf = rest
            while True:
                try:
                    return _Flow(buf).parse()
                except YAMLError:
                    nx = self._peek()
                    if nx is None or nx.indent <= indent:
                        raise
                    buf += " " + _strip_comment(nx.text)
                    self.pos += 1
        parts = [rest]
        while True:
            nx = self._peek()
            if nx is None or nx.indent <= indent:
                break
            if _find_mapping_colon(nx.text) >= 0 or nx.text.startswith("- "):
                break
            parts.append(_strip_comment(nx.text))
            self.pos += 1
        return _resolve_plain(" ".join(parts))

    def _map(self, indent):
        out = {}
        while True:
            ln = self._peek()
            if ln is None or ln.indent < indent:
                break
            if ln.indent > indent:
                raise YAMLError(f"line {ln.no + 1}: bad indentation")
            t = _strip_comment(ln.text)
            if t == "-" or t.startswith("- "):
                break
            c = _find_mapping_colon(t)
            if c < 0:
                raise YAMLError(f"line {ln.no + 1}: expected 'key: value', got {ln.text!r}")
            key = _parse_key(t[:c])
            # use original (uncommented) text for the value so quoted '#' survive
            ci = _find_mapping_colon(ln.text)
            out[key] = self._value_after_indicator(ln.text[ci + 1:], indent)
        return out

    def _seq(self, indent):
        out = []
        while True:
            ln = self._peek()
            if ln is None or ln.indent != indent:
                if ln is not None and ln.indent > indent:
                    raise YAMLError(f"line {ln.no + 1}: bad indentation")
                break
            t = ln.text
            if not (t == "-" or t.startswith("- ")):
                break
            rest = t[1:]
            stripped = rest.lstrip(" ")
            if stripped == "" or stripped.startswith("#"):
                out.append(self._value_after_indicator("", indent))
                continue
            inner_indent = indent + 1 + (len(rest) - len(stripped))
            sc = _strip_comment(stripped)
            is_nested_seq = sc == "-" or sc.startswith("- ")
            if (is_nested_seq or _find_mapping_colon(sc) >= 0) and sc[0] not in "[{\"'":
                # rewrite current line as an indented node and parse it in place
                self.lines[self.pos] = _Line(inner_indent, stripped, " " * inner_indent + stripped, ln.no)
                out.append(self._node(inner_indent))
            elif sc[:1] in "\"'" and _find_mapping_colon(sc) >= 0 and not _is_complete_quoted(sc):
                self.lines[self.pos] = _Line(inner_indent, stripped, " " * inner_indent + stripped, ln.no)
                out.append(self._node(inner_indent))
            else:
                out.append(self._value_after_indicator(rest, indent))
        return out


def _is_complete_quoted(s: str) -> bool:
    try:
        _Flow(s).parse()
        return True
    except YAMLError:
        return False


def load(text: str):
    """Parse YAML text into Python objects."""
    if text.startswith("﻿"):
        text = text[1:]
    return _Parser(text).parse()


# --------------------------------------------------------------------------- emitter

_PLAIN_SAFE = re.compile(r"^[A-Za-z0-9_./()$@][A-Za-z0-9 _./()$@%+&*=<>!?'\-]*$")


def _needs_quote(s: str) -> bool:
    if s == "" or s != s.strip():
        return True
    if not _PLAIN_SAFE.match(s):
        return True
    if _resolve_plain(s) is not s and not isinstance(_resolve_plain(s), str):
        return True
    if s.lower() in ("yes", "no", "on", "off", "y", "n"):
        return True
    return False


def _quote(s: str) -> str:
    out = ['"']
    for ch in s:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append(f"\\x{ord(ch):02x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _scalar(v) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return ".nan"
        if v in (float("inf"), float("-inf")):
            return ".inf" if v > 0 else "-.inf"
        r = repr(v)
        return r if ("." in r or "e" in r or "n" in r) else r + ".0"
    s = str(v)
    return _quote(s) if _needs_quote(s) else s


def _is_scalar(v) -> bool:
    return not isinstance(v, (dict, list, tuple))


def _flowable(v) -> bool:
    """Small dicts/lists of scalars are emitted inline for readability."""
    if isinstance(v, dict):
        return 0 < len(v) <= 4 and all(_is_scalar(x) and not (isinstance(x, str) and "\n" in x) for x in v.values()) \
            and all(isinstance(k, str) for k in v) and len(_flow(v)) <= 72
    if isinstance(v, (list, tuple)):
        return all(_is_scalar(x) and not (isinstance(x, str) and "\n" in x) for x in v) and len(_flow(v)) <= 72
    return False


def _flow(v) -> str:
    if isinstance(v, dict):
        return "{" + ", ".join(f"{_key(k)}: {_scalar(x)}" for k, x in v.items()) + "}"
    return "[" + ", ".join(_scalar(x) for x in v) + "]"


def _key(k) -> str:
    if isinstance(k, str):
        return _quote(k) if _needs_quote(k) or ":" in k or "#" in k else k
    return _scalar(k)


def _emit(v, indent: int, out: list[str]):
    pad = " " * indent
    if isinstance(v, dict):
        if not v:
            out.append(pad + "{}")
            return
        for k, x in v.items():
            _emit_entry(pad + _key(k) + ":", x, indent, out)
    elif isinstance(v, (list, tuple)):
        if not v:
            out.append(pad + "[]")
            return
        for x in v:
            if isinstance(x, dict) and x and not _flowable(x):
                sub: list[str] = []
                _emit(x, indent + 2, sub)
                sub[0] = pad + "- " + sub[0][indent + 2:]
                out.extend(sub)
            elif isinstance(x, (list, tuple)) and x and not _flowable(x):
                out.append(pad + "-")
                _emit(x, indent + 2, out)
            else:
                _emit_entry(pad + "-", x, indent, out)
    else:
        out.append(pad + _scalar(v))


def _emit_entry(prefix: str, x, indent: int, out: list[str]):
    if isinstance(x, str) and "\n" in x:
        chomp = "" if x.endswith("\n") and not x.endswith("\n\n") else ("-" if not x.endswith("\n") else "+")
        lines = x[:-1].split("\n") if x.endswith("\n") and chomp == "" else x.rstrip("\n").split("\n") if chomp == "+" else x.split("\n")
        if any(l.startswith(" ") for l in lines[:1]) or chomp == "+":
            out.append(prefix + " " + _quote(x))
            return
        out.append(prefix + " |" + chomp)
        for l in lines:
            out.append((" " * (indent + 2) + l) if l else "")
    elif _is_scalar(x):
        out.append(prefix + " " + _scalar(x))
    elif not x:
        out.append(prefix + (" {}" if isinstance(x, dict) else " []"))
    elif _flowable(x):
        out.append(prefix + " " + _flow(x))
    else:
        out.append(prefix)
        _emit(x, indent + 2, out)


def dump(data, header: str | None = None) -> str:
    """Serialise Python objects to YAML text."""
    out: list[str] = []
    if header:
        out.extend("# " + l if l else "#" for l in header.split("\n"))
    _emit(data, 0, out)
    return "\n".join(out) + "\n"

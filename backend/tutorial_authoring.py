"""Editing a tutorial's wording from inside the running app.

A developer tool, and deliberately a narrow one. Refining tutorial copy means reading it
in place — at the size the card is, next to the thing it describes, at the moment the step
arrives — and the loop of noticing an awkward sentence, finding it in a definition file
and coming back to look again is slow enough that awkward sentences survive it.

So the card can be edited where it stands and the edit is written back into the files the
wording ships from. That is the whole point: the alternative designs keep the improved
sentence somewhere the release never sees.

There are two such files now, and both are written. Built-ins play from
``frontend/src/tutorials/documents/<name>.tutorial.json`` and promoted drafts from
``generated/``; ``frontend/src/tutorials/<name>.js`` is the rollback the document path was
staged behind, and a test asserts the two stay equivalent. Writing only the JavaScript —
which is what this did when the documents arrived — saves the sentence into a file nobody
reads and reports that it was saved.

Writing to your own source is not a thing an application should do, so the guards matter
more than the feature:

- It is refused outright unless a source checkout is present, so a packaged build has
  nothing to edit. ``main`` gates the endpoint again on its own flag.
- It only ever replaces the value of one named text field. A section is deliberately
  shared: its step field is followed to the local ``SECTION.name`` constant, while other
  fields remain local to one named step. The scanner walks string literals rather than
  matching patterns, so it cannot run past the end of a value and eat the step around it.
- It re-reads and re-parses what it wrote before replacing the file. A rewrite that does
  not survive its own scanner is dropped rather than saved.
- The write is atomic, so an interrupted save cannot leave a half-written definition.

Interpolated values (``${REG4.symbol}``) do not survive an edit — the app has the rendered
text and no way back to the expression that made it. Rather than silently hard-code them,
a rewrite reports that it happened so the caller can say so.

A field is not always written out where the step is. ``copy: SLICE_WHOLE_REGION`` names a
constant in another module, and there are two cases: if that constant is a plain string it
is followed and edited there, which is what someone editing the card meant. If it is
computed from something else — as the region string is, from the slice's real bounds —
editing the text alone would put the tutorial and the genome out of step with each other,
so it is refused and the refusal says where to go instead.
"""

from __future__ import annotations

import json
import os
import math
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Only these. `title`, `body` and `section` are the card's words; `copy` is the value it
# offers to the clipboard. Section is the one shared field: the frontend applies it to
# every step carrying that heading, while the rewriter follows their `SECTION.name`
# references back to the single local constant. Nothing behavioural — a placement or an
# anchor edited by accident would break the step in ways the card cannot show.
EDITABLE_FIELDS = ("section", "title", "body", "copy")

# The house style for a long string: continuation lines carry the concatenation, wrapped
# a little under a hundred columns.
WRAP_COLUMN = 96

_QUOTES = "'\"`"

_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
_MEMBER_REFERENCE = re.compile(
    r"^([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)$"
)


class IndirectValue(Exception):
    """The field is a reference rather than text written out at the step."""

    def __init__(self, name: str):
        super().__init__(name)
        self.name = name


def tutorials_dir() -> Optional[Path]:
    """The tutorial definitions, if this is running from a source checkout."""
    candidate = Path(__file__).resolve().parents[1] / "frontend" / "src" / "tutorials"
    return candidate if candidate.is_dir() else None


def is_available() -> bool:
    return tutorials_dir() is not None


def find_tutorial_file(tutorial_id: str) -> Optional[Path]:
    """The definition file declaring this tutorial id."""
    directory = tutorials_dir()
    if not directory:
        return None
    wanted = re.compile(r"""\bid:\s*['"]%s['"]""" % re.escape(tutorial_id))
    for path in sorted(directory.glob("*.js")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if wanted.search(text) and "steps:" in text:
            return path
    return None


# Where a tutorial's *played* words live. The JavaScript definitions were the only source
# until built-ins moved to schema-v1 documents; `documents/` now holds them and
# `generated/` holds promoted drafts. Both are what a reader sees, so an edit that rewrote
# only the JavaScript rollback saved nothing anybody would read — silently, because the
# rewrite itself succeeded.
DOCUMENT_DIRECTORIES = ("documents", "generated")

DOCUMENT_SUFFIX = ".tutorial.json"


def tutorial_documents(tutorial_id: str) -> List[Path]:
    """Every portable document declaring this tutorial id, in load order."""
    directory = tutorials_dir()
    if not directory:
        return []
    wanted = str(tutorial_id or "").strip()
    if not wanted:
        return []
    found: List[Path] = []
    for name in DOCUMENT_DIRECTORIES:
        folder = directory / name
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*%s" % DOCUMENT_SUFFIX)):
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if str(document.get("id") or "").strip() == wanted:
                found.append(path)
    return found


def _write_source(path: Path, text: str) -> None:
    """Replace a definition file atomically, keeping the permissions it had.

    An interrupted save must not leave half a definition behind, which is what the
    temporary and the rename are for. `mkstemp` is 0600, so the mode is carried over
    explicitly: a source file that quietly loses its read bits every time a sentence is
    edited is a worse surprise than the one being prevented.
    """
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        mode = 0o644
    fd, temporary = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _write_document(path: Path, document: Dict[str, Any]) -> None:
    """Replace a document atomically, in the same shape the promotion command writes."""
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        mode = 0o644
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        # mkstemp is 0600 by design; a repository file that quietly loses its read bits
        # every time a sentence is edited is a worse surprise than the one it prevents.
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply_document_fields(
    tutorial_id: str,
    step_id: str,
    fields: Dict[str, Any],
) -> List[Path]:
    """Set fields on one step of every document declaring this tutorial.

    The counterpart to the JavaScript rewriter, and deliberately the whole of the change:
    a document is data, so there is no scanner to walk and no expression to preserve. The
    two are written together rather than one replacing the other, because the JavaScript
    is still the declared rollback path and a test asserts the pair stay equivalent.
    """
    written: List[Path] = []
    wanted = str(step_id or "").strip()
    for path in tutorial_documents(tutorial_id):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        step = next(
            (
                candidate
                for candidate in document.get("steps") or []
                if str(candidate.get("id") or "").strip() == wanted
            ),
            None,
        )
        if step is None:
            continue
        step.update(fields)
        _write_document(path, document)
        written.append(path)
    return written


def document_step_field(tutorial_id: str, step_id: str, field: str) -> Any:
    """One field of one step, as the documents currently hold it."""
    wanted = str(step_id or "").strip()
    for path in tutorial_documents(tutorial_id):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for candidate in document.get("steps") or []:
            if str(candidate.get("id") or "").strip() == wanted:
                return candidate.get(field)
    return None


def _read_expression(text: str, start: int) -> str:
    """The expression written in place of a string, as source.

    Stops at the comma that ends the property, not at the first comma it sees — the
    arguments of ``locus(SLICE_START, SLICE_END)`` are commas too, and reporting half an
    expression back to someone is worse than reporting none.
    """
    depth = 0
    i = start
    while i < len(text):
        char = text[i]
        if char in "([{":
            depth += 1
        elif char in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and (char == "," or char == "\n"):
            break
        i += 1
    return text[start:i].strip()


def _scan_string(text: str, start: int) -> int:
    """Index just past the string literal beginning at ``start``."""
    quote = text[start]
    i = start + 1
    while i < len(text):
        char = text[i]
        if char == "\\":
            i += 2
            continue
        if char == quote:
            return i + 1
        i += 1
    raise ValueError("unterminated string literal")


def _scan_value(text: str, start: int) -> int:
    """Index just past a value written as one string literal or several joined by ``+``.

    Walks the literals rather than looking for the next comma, because the values are
    prose and commas inside them are the common case, not the exception.
    """
    i = start
    while True:
        while i < len(text) and text[i] in " \t\r\n":
            i += 1
        if i >= len(text) or text[i] not in _QUOTES:
            # Not text written out here. `copy: SLICE_WHOLE_REGION` is the case: the
            # value is a name, and the words the card shows live somewhere else.
            raise IndirectValue(_read_expression(text, i))
        i = _scan_string(text, i)
        j = i
        while j < len(text) and text[j] in " \t\r\n":
            j += 1
        if j < len(text) and text[j] == "+":
            i = j + 1
            continue
        return i


def _field_span(source: str, step_id: str, field: str) -> Tuple[int, int, str]:
    """Where this step's field value lives, and the indent of the line holding it."""
    step = re.search(r"""\bid:\s*['"]%s['"]\s*,""" % re.escape(step_id), source)
    if not step:
        raise ValueError(f"no step with id {step_id!r}")

    # The step object ends at the first line that closes it at the steps-array indent.
    end_match = re.compile(r"\n\s{0,6}\},\n", re.MULTILINE).search(source, step.end())
    step_end = end_match.start() if end_match else len(source)

    field_match = re.compile(r"\n(\s*)%s:\s*" % re.escape(field)).search(source, step.end(), step_end)
    if not field_match:
        raise ValueError(f"step {step_id!r} has no {field} to edit")

    value_start = field_match.end()
    value_end = _scan_value(source, value_start)
    return value_start, value_end, field_match.group(1)


def _as_literal(value: str, indent: str, field: str) -> str:
    """A JS string literal for ``value``, wrapped in the style the definitions use.

    The first line has to make room for ``<indent><field>: `` and the quotes; continuation
    lines for ``<indent>  + `` and the quotes. Getting that arithmetic wrong is only
    visible as lines that creep past the column everything else stops at, which is exactly
    the sort of thing nobody fixes afterwards.
    """
    escaped = value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    continuation = indent + "  + "
    first_budget = WRAP_COLUMN - len(indent) - len(field) - len(": ") - 2
    rest_budget = WRAP_COLUMN - len(continuation) - 2

    lines: List[str] = []
    current = ""
    budget = first_budget
    for word in escaped.split(" "):
        candidate = word if not current else f"{current} {word}"
        if current and len(candidate) + 1 > budget:
            # The trailing space belongs to the line that ends, so the pieces still join
            # into the sentence they came from.
            lines.append(current + " ")
            current = word
            budget = rest_budget
        else:
            current = candidate
    if current:
        lines.append(current)

    literal = f"'{lines[0]}'"
    for line in lines[1:]:
        literal += f"\n{continuation}'{line}'"
    return literal


def _module_for_identifier(source: str, name: str) -> Optional[str]:
    """The module a definition file imports ``name`` from, if it imports it at all."""
    for match in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]", source):
        names = [part.strip().split(" as ")[-1].strip() for part in match.group(1).split(",")]
        if name in names:
            return match.group(2)
    return None


def _constant_span(source: str, name: str) -> Tuple[int, int, str]:
    """Where an ``export const NAME = '…'`` keeps its value."""
    # Anchored per line rather than on a preceding newline: a constant declared on the
    # first line of a module has nothing in front of it.
    match = re.search(r"^export const %s\s*=\s*" % re.escape(name), source, re.MULTILINE)
    if not match:
        raise ValueError(f"{name} is not exported from that module")
    start = match.end()
    end = _scan_value(source, start)          # raises IndirectValue when it is computed
    return start, end, ""


def _object_property_span(source: str, object_name: str, property_name: str) -> Tuple[int, int, str]:
    """Where a string property in a local frozen object keeps its value.

    Tutorial section labels live in ``const SECTION = Object.freeze({ ... })``. Steps
    refer to them as ``SECTION.download`` so changing the property is both safer and more
    faithful than replacing every reference with duplicated string literals.
    """
    declaration = re.search(
        r"^(?:export\s+)?const\s+%s\s*=\s*Object\.freeze\(\s*\{"
        % re.escape(object_name),
        source,
        re.MULTILINE,
    )
    if not declaration:
        raise ValueError(f"{object_name} is not a frozen text map in this tutorial")
    object_end = re.compile(r"^\s*\}\)\s*$", re.MULTILINE).search(source, declaration.end())
    if not object_end:
        raise ValueError(f"{object_name} has no readable closing brace")
    field_match = re.compile(
        r"^(\s*)%s:\s*" % re.escape(property_name), re.MULTILINE
    ).search(source, declaration.end(), object_end.start())
    if not field_match:
        raise ValueError(f"{object_name} has no {property_name!r} heading")
    start = field_match.end()
    end = _scan_value(source, start)
    return start, end, field_match.group(1)


def resolve_indirect_value(tutorial_path: Path, name: str) -> Tuple[Path, int, int]:
    """The file and span holding the text behind a referenced value.

    Raises with something worth reading when the reference cannot be followed: a value
    computed from something else is not a value to edit through a card, because the thing
    it is computed *from* is what the rest of the tutorial agrees with.
    """
    member = _MEMBER_REFERENCE.match(name)
    if member:
        source = tutorial_path.read_text(encoding="utf-8")
        start, end, _indent = _object_property_span(source, member.group(1), member.group(2))
        return tutorial_path, start, end
    if not _IDENTIFIER.match(name):
        raise ValueError(
            f"This line is built from an expression ({name}), so it cannot be edited here. "
            f"Change it in {tutorial_path.name}."
        )
    source = tutorial_path.read_text(encoding="utf-8")
    module = _module_for_identifier(source, name)
    if not module:
        raise ValueError(
            f"This line comes from {name}, which {tutorial_path.name} does not import. "
            "Edit it where it is defined."
        )
    target = (tutorial_path.parent / module).resolve()
    if not target.is_file():
        raise ValueError(f"This line comes from {name} in {module}, which could not be read.")

    module_source = target.read_text(encoding="utf-8")
    try:
        start, end, _indent = _constant_span(module_source, name)
    except IndirectValue as computed:
        raise ValueError(
            f"{name} is worked out from {computed.name} in {target.name}, not written out as "
            "text, so editing the words here would only put this step and the rest of the "
            f"tutorial out of step with each other. Change it in {target.name}."
        )
    return target, start, end


def rewrite_step_field(source: str, step_id: str, field: str, value: str) -> Tuple[str, bool]:
    """``source`` with one step's field replaced. Also whether interpolation was lost."""
    if field not in EDITABLE_FIELDS:
        raise ValueError(f"{field} is not an editable field")
    if not str(value).strip():
        raise ValueError("the value may not be empty")

    start, end, indent = _field_span(source, step_id, field)
    had_interpolation = "${" in source[start:end]
    replacement = _as_literal(str(value), indent, field)
    return source[:start] + replacement + source[end:], had_interpolation


# `[ \t]*$` rather than `\s*$`, and the difference is not cosmetic. These are searched
# within the bounds of one step, and a bounded search makes `$` available at the end of the
# *truncated* string as well as before a newline. A greedy `\s*` then walks past the line
# ending and eats the next line's indent, so replacing the match pulls the step's closing
# brace up onto the position line — which is exactly what happens when `cardPosition` is a
# step's last property, and what left step 19 unsaveable with "the saved card position
# could not be read back".
_CARD_POSITION_LINE = re.compile(
    r"^(\s*)cardPosition:\s*\{\s*x:\s*([0-9.+-]+),\s*y:\s*([0-9.+-]+)\s*\},?[ \t]*$",
    re.MULTILINE,
)


def _step_bounds(source: str, step_id: str) -> Tuple[int, int, str]:
    """The source range and property indent for one step object."""
    # A tutorial id is indented two spaces; properties inside step objects are indented
    # six. Requiring at least four prevents a coincidentally identical tutorial id from
    # being mistaken for the step. The closing brace is two spaces left of its fields,
    # which also avoids stopping at a nested reveal/advance object.
    step = re.search(r"""^([ ]{4,})id:\s*['"]%s['"]\s*,""" % re.escape(step_id), source, re.MULTILINE)
    if not step:
        raise ValueError(f"no step with id {step_id!r}")
    closing_indent = step.group(1)[:-2]
    end_match = re.compile(r"^%s\},\s*$" % re.escape(closing_indent), re.MULTILINE).search(source, step.end())
    if not end_match:
        raise ValueError(f"step {step_id!r} has no readable closing brace")
    return step.start(), end_match.start(), step.group(1)


def _normalized_position_number(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number) or number < 0 or number > 1:
        raise ValueError("card position coordinates must be between 0 and 1")
    return number


def _position_literal(value: float) -> str:
    return f"{value:.4f}".rstrip("0").rstrip(".") or "0"


def rewrite_step_position(source: str, step_id: str, x: Any, y: Any) -> str:
    """Insert or replace one normalized manual card position without touching behaviour."""
    x_value = _normalized_position_number(x)
    y_value = _normalized_position_number(y)
    start, end, indent = _step_bounds(source, step_id)
    replacement = (
        f"{indent}cardPosition: {{ x: {_position_literal(x_value)}, "
        f"y: {_position_literal(y_value)} }},"
    )

    existing = _CARD_POSITION_LINE.search(source, start, end)
    if existing:
        return source[:existing.start()] + replacement + source[existing.end():]

    # Keep layout metadata together. Every current step has an id, while most have a
    # placement; inserting after placement makes a hand-authored position easy to find.
    placement = re.compile(r"^\s*placement:[^\n]*\n", re.MULTILINE).search(source, start, end)
    if placement:
        insertion = placement.end()
    else:
        step_id_line = re.compile(r"^\s*id:[^\n]*\n", re.MULTILINE).search(source, start, end)
        if not step_id_line:
            raise ValueError(f"step {step_id!r} has no readable id line")
        insertion = step_id_line.end()
    return source[:insertion] + replacement + "\n" + source[insertion:]


def _read_step_position(source: str, step_id: str) -> Tuple[float, float]:
    start, end, _indent = _step_bounds(source, step_id)
    match = _CARD_POSITION_LINE.search(source, start, end)
    if not match:
        raise ValueError("the saved card position could not be read back")
    return _normalized_position_number(match.group(2)), _normalized_position_number(match.group(3))


def save_step_position(tutorial_id: str, step_id: str, x: Any, y: Any) -> Dict[str, Any]:
    """Persist one draggable card position into its tutorial definition."""
    if not is_available():
        raise ValueError("Tutorial editing needs a source checkout.")
    path = find_tutorial_file(tutorial_id)
    documents = tutorial_documents(tutorial_id)
    if not path and not documents:
        raise ValueError(f"No definition file declares the tutorial {tutorial_id!r}.")

    # Through the same literal the JavaScript gets, so the two hold the identical number
    # rather than one keeping four decimal places and the other seventeen. A test asserts
    # the pair are equivalent, and it compares values, not text.
    position = {
        "x": float(_position_literal(_normalized_position_number(x))),
        "y": float(_position_literal(_normalized_position_number(y))),
    }

    if path:
        source = path.read_text(encoding="utf-8")
        updated = rewrite_step_position(source, step_id, x, y)
        _read_step_position(updated, step_id)

        _write_source(path, updated)

    written = apply_document_fields(tutorial_id, step_id, {"cardPosition": position})

    return {
        "saved": True,
        "file": str(path) if path else str(written[0]),
        "documents": [str(document) for document in written],
        "position": {"x": float(x), "y": float(y)},
    }


# Same reasoning as _CARD_POSITION_LINE above: line-trailing whitespace only.
_CARD_SIZE_LINE = re.compile(
    r"^(\s*)cardSize:\s*\{([^}]*)\},?[ \t]*$",
    re.MULTILINE,
)


def _card_size_number(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("card dimensions must be positive finite numbers")
    return number


def _size_literal(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _size_from_match(match: Optional[re.Match]) -> Dict[str, float]:
    if not match:
        return {}
    values: Dict[str, float] = {}
    for name in ("width", "height"):
        found = re.search(r"\b%s:\s*([0-9.+-]+)" % name, match.group(2))
        if found:
            values[name] = _card_size_number(found.group(1))
    return values


def rewrite_step_size(
    source: str,
    step_id: str,
    width: Any = None,
    height: Any = None,
) -> str:
    """Insert or update the independently resizable edges of one tutorial card."""
    start, end, indent = _step_bounds(source, step_id)
    existing = _CARD_SIZE_LINE.search(source, start, end)
    values = _size_from_match(existing)
    if width is not None:
        values["width"] = _card_size_number(width)
    if height is not None:
        values["height"] = _card_size_number(height)
    if not values:
        raise ValueError("at least one card dimension is required")

    properties = ", ".join(
        f"{name}: {_size_literal(values[name])}" for name in ("width", "height") if name in values
    )
    replacement = f"{indent}cardSize: {{ {properties} }},"
    if existing:
        return source[:existing.start()] + replacement + source[existing.end():]

    # Position, size and semantic placement stay adjacent in the definition.
    after = _CARD_POSITION_LINE.search(source, start, end)
    if not after:
        after = re.compile(r"^\s*placement:[^\n]*$", re.MULTILINE).search(source, start, end)
    if not after:
        after = re.compile(r"^\s*id:[^\n]*$", re.MULTILINE).search(source, start, end)
    if not after:
        raise ValueError(f"step {step_id!r} has no readable insertion point")
    return source[:after.end()] + "\n" + replacement + source[after.end():]


def _read_step_size(source: str, step_id: str) -> Dict[str, float]:
    start, end, _indent = _step_bounds(source, step_id)
    values = _size_from_match(_CARD_SIZE_LINE.search(source, start, end))
    if not values:
        raise ValueError("the saved card dimensions could not be read back")
    return values


def save_step_size(
    tutorial_id: str,
    step_id: str,
    width: Any = None,
    height: Any = None,
) -> Dict[str, Any]:
    """Persist one or both drag-authored card dimensions."""
    if not is_available():
        raise ValueError("Tutorial editing needs a source checkout.")
    path = find_tutorial_file(tutorial_id)
    documents = tutorial_documents(tutorial_id)
    if not path and not documents:
        raise ValueError(f"No definition file declares the tutorial {tutorial_id!r}.")

    size: Dict[str, float] = {}
    if path:
        source = path.read_text(encoding="utf-8")
        updated = rewrite_step_size(source, step_id, width, height)
        size = _read_step_size(updated, step_id)

        _write_source(path, updated)
    else:
        # Either edge can be saved on its own, so an unnamed one keeps whatever the
        # document already holds rather than being dropped.
        existing = document_step_field(tutorial_id, step_id, "cardSize") or {}
        for name, value in (("width", width), ("height", height)):
            if value is not None:
                size[name] = _card_size_number(value)
            elif isinstance(existing, dict) and existing.get(name) is not None:
                size[name] = _card_size_number(existing[name])
        if not size:
            raise ValueError("at least one card dimension is required")

    written = apply_document_fields(
        tutorial_id,
        step_id,
        {"cardSize": {name: float(_size_literal(value)) for name, value in size.items()}},
    )

    return {
        "saved": True,
        "file": str(path) if path else str(written[0]),
        "documents": [str(document) for document in written],
        "size": size,
    }


def save_step_field(tutorial_id: str, step_id: str, field: str, value: str) -> Dict[str, Any]:
    """Write one step's field back into the files that actually hold its words.

    Both of them. Playback reads the portable document, so an edit that reached only the
    JavaScript would be saved into a file nobody reads and reported as a success; the
    JavaScript is still the declared rollback and a test asserts the pair agree. A
    tutorial that exists only as a promoted document — anything from the builder — has no
    JavaScript half and is written on its own.

    Within the JavaScript, the words are usually at the step. When it names a constant
    instead — ``copy: SLICE_WHOLE_REGION`` — they live in the module that constant comes
    from, and that is what gets edited, so the change lands in the one place every step
    reading it will see. A constant that is *computed* is refused; see
    ``resolve_indirect_value``.
    """
    if not is_available():
        raise ValueError("Tutorial editing needs a source checkout.")
    if field not in EDITABLE_FIELDS:
        raise ValueError(f"{field} is not an editable field")
    if not str(value).strip():
        raise ValueError("the value may not be empty")

    path = find_tutorial_file(tutorial_id)
    documents = tutorial_documents(tutorial_id)
    if not path and not documents:
        raise ValueError(f"No definition file declares the tutorial {tutorial_id!r}.")

    if not path:
        written = apply_document_fields(tutorial_id, step_id, {field: value})
        if not written:
            raise ValueError(f"No step {step_id!r} in the tutorial {tutorial_id!r}.")
        return {
            "saved": True,
            "file": str(written[0]),
            "documents": [str(document) for document in written],
            "field": field,
            "followed": "",
            "interpolation_dropped": False,
        }

    source = path.read_text(encoding="utf-8")
    followed = ""
    try:
        updated, had_interpolation = rewrite_step_field(source, step_id, field, value)
        target = path
        recheck: Any = (step_id, field)
    except IndirectValue as reference:
        target, start, end = resolve_indirect_value(path, reference.name)
        module_source = target.read_text(encoding="utf-8")
        had_interpolation = "${" in module_source[start:end]
        updated = module_source[:start] + _as_literal(str(value), "", reference.name) + module_source[end:]
        followed = reference.name
        recheck = reference.name

    # Read back what we are about to write with the same scanner. A rewrite that cannot be
    # re-parsed is a rewrite that has damaged the file, and it is dropped here rather than
    # discovered when the app next fails to start.
    if isinstance(recheck, tuple):
        start, end, _indent = _field_span(updated, recheck[0], recheck[1])
    elif _MEMBER_REFERENCE.match(recheck):
        member = _MEMBER_REFERENCE.match(recheck)
        start, end, _indent = _object_property_span(updated, member.group(1), member.group(2))
    else:
        start, end, _indent = _constant_span(updated, recheck)
    if not updated[start:end].strip():
        raise ValueError("The rewritten definition did not survive its own check.")

    _write_source(target, updated)

    # The document holds the rendered words, so a followed constant and an interpolated
    # body both write out the same literal here that the card is showing.
    written = apply_document_fields(tutorial_id, step_id, {field: value})

    return {
        "saved": True,
        "file": str(target),
        "documents": [str(document) for document in written],
        "field": field,
        "followed": followed,
        "interpolation_dropped": had_interpolation,
    }

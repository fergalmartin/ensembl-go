"""Structural rules that keep `main.py` safe to split up.

1. Nothing the app imports may import `main`. Electron and the packaged app run
   `main.py` as `__main__`, so a second module importing `main` would load a second
   copy of it: another FastAPI app, another download manager, and duplicate caches
   and locks. Shared code lives in modules that `main` imports, never the reverse.

2. Every name a test takes from `main` must exist there. When code moves out of
   `main`, `patch.object(main, ...)` and `from main import ...` fail loudly, but a
   plain `main.X = value` silently creates a new attribute that the moved code never
   reads -- and an unapplied config patch sends the test at the user's real data.
   This test turns every stale reference into a named failure.
"""

import ast
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import main

# Directories that are not part of the running app: the test suite itself,
# standalone maintenance scripts (run directly, so `import main` is fine there),
# and data.
_NOT_APP_CODE = {"tests", "scripts", "cache", "static", "data", "__pycache__"}


def _app_modules():
    for path in sorted(BACKEND.rglob("*.py")):
        relative = path.relative_to(BACKEND)
        if relative.parts[0] in _NOT_APP_CODE or relative == Path("main.py"):
            continue
        yield relative, path


def _imports_main(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(alias.name == "main" for alias in node.names):
            return node.lineno
        if isinstance(node, ast.ImportFrom) and node.module == "main" and not node.level:
            return node.lineno
    return None


def _names_tests_take_from_main(tree):
    """Yield (lineno, name) for every attribute of `main` a test file relies on."""
    aliases = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            aliases.update(alias.asname or alias.name for alias in node.names if alias.name == "main")
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "main" and not node.level:
            for alias in node.names:
                yield node.lineno, alias.name
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in aliases:
            yield node.lineno, node.attr
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Attribute) \
                and isinstance(node.value.value, ast.Name) and node.value.value.id == "self" \
                and node.value.attr in aliases:
            # `self.main = main` in setUp, then `self.main.X` in the tests.
            yield node.lineno, node.attr
        elif isinstance(node, ast.Call):
            func = node.func
            func_name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            args = node.args
            if func_name in {"object", "setattr"} and len(args) >= 2 \
                    and isinstance(args[0], ast.Name) and args[0].id in aliases \
                    and isinstance(args[1], ast.Constant) and isinstance(args[1].value, str):
                yield node.lineno, args[1].value
            elif func_name == "patch" and args and isinstance(args[0], ast.Constant) \
                    and isinstance(args[0].value, str) and args[0].value.startswith("main."):
                yield node.lineno, args[0].value.split(".")[1]


class ModuleBoundaryTests(unittest.TestCase):
    def test_no_app_module_imports_main(self):
        offenders = []
        for relative, path in _app_modules():
            line = _imports_main(ast.parse(path.read_text(encoding="utf-8")))
            if line:
                offenders.append(f"{relative}:{line}")
        self.assertEqual(offenders, [], "these modules import main; pass what they need in instead")

    def test_every_name_tests_take_from_main_exists(self):
        missing = []
        for path in sorted((BACKEND / "tests").glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
            for line, name in _names_tests_take_from_main(tree):
                if not hasattr(main, name):
                    missing.append(f"tests/{path.name}:{line}: main.{name}")
        self.assertEqual(
            missing, [],
            "these names are no longer defined in main; point the test at the module that now defines them",
        )


if __name__ == "__main__":
    unittest.main()

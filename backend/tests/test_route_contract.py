"""The HTTP surface of the backend, pinned.

Moving endpoints between modules must not change what the app serves. This compares
the live app with a recorded snapshot of every route, in registration order (FastAPI
matches the first route that fits, so order is behaviour), together with whether its
handler is `async def` (a plain `def` runs in the threadpool) and the full OpenAPI
document (request and response models).

When an intended change alters the surface, regenerate the snapshot with
    UPDATE_ROUTE_CONTRACT=1 python3 -m pytest tests/test_route_contract.py
and review the diff.
"""

import inspect
import json
import os
import sys
import typing
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main

SNAPSHOT = Path(__file__).resolve().parent / "fixtures" / "route_contract.json"


def _route_table():
    rows = []
    for route in main.app.routes:
        endpoint = getattr(route, "endpoint", None)
        response_model = getattr(route, "response_model", None)
        rows.append({
            "path": getattr(route, "path", None),
            "methods": sorted(getattr(route, "methods", None) or []),
            "name": getattr(route, "name", None),
            "endpoint": getattr(endpoint, "__name__", None),
            "async": bool(endpoint and inspect.iscoroutinefunction(endpoint)),
            "response_model": getattr(response_model, "__name__", None) or (str(response_model) if response_model else None),
        })
    return rows


def _current_contract():
    return {"routes": _route_table(), "openapi": main.app.openapi()}


def _models_reachable_from_routes():
    """Every pydantic model a route accepts or returns, keyed by class name."""
    from pydantic import BaseModel
    found = {}

    def visit(annotation):
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            models = found.setdefault(annotation.__name__, set())
            if annotation in models:
                return
            models.add(annotation)
            for field in annotation.model_fields.values():
                visit(field.annotation)
        for argument in typing.get_args(annotation):
            visit(argument)

    for route in main.app.routes:
        dependant = getattr(route, "dependant", None)
        for param in getattr(dependant, "body_params", None) or []:
            visit(param.field_info.annotation)
        visit(getattr(route, "response_model", None))
    return found


class RouteContractTests(unittest.TestCase):
    def test_no_two_api_models_share_a_name(self):
        # OpenAPI names schemas by class name. Two different models with one name
        # make FastAPI keep whichever it meets first, which varies with Python's hash
        # seed -- the published schema then changes from run to run.
        clashes = {
            name: sorted(f"{model.__module__}.{model.__qualname__}" for model in models)
            for name, models in _models_reachable_from_routes().items()
            if len(models) > 1
        }
        self.assertEqual(clashes, {}, "rename one of each pair of request/response models")

    def test_routes_and_openapi_match_snapshot(self):
        current = json.loads(json.dumps(_current_contract(), sort_keys=True))
        if os.environ.get("UPDATE_ROUTE_CONTRACT"):
            SNAPSHOT.write_text(json.dumps(current, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        expected = json.loads(SNAPSHOT.read_text(encoding="utf-8"))

        current_routes = [(r["path"], r["methods"]) for r in current["routes"]]
        expected_routes = [(r["path"], r["methods"]) for r in expected["routes"]]
        self.assertEqual(current_routes, expected_routes, "routes added, removed or reordered")
        self.assertEqual(current["routes"], expected["routes"], "a route's handler name, sync/async kind or response model changed")
        self.assertEqual(current["openapi"], expected["openapi"], "the OpenAPI document changed")


if __name__ == "__main__":
    unittest.main()

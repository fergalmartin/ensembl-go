"""HTTP endpoints, grouped by domain and registered in main.py.

Use ``def`` for handlers that do blocking work: FastAPI runs them in its worker
threadpool. Use ``async def`` when a handler needs the event loop, and move any
blocking work into ``run_in_threadpool``. Blocking the loop delays every request.

Import shared services as modules and call ``module.name`` so tests can patch
the defining module. Application modules must not import ``main``.
"""

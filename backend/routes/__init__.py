"""HTTP endpoints of the backend, one APIRouter per domain; main.py includes them.

A note on ``def`` versus ``async def`` for route handlers, because it is load-bearing
here. This process serves everything from a single event loop, so an ``async def``
handler that does blocking work -- reading the configuration, walking the output
directory, waiting on a remote registry -- stops the process answering *any* request
for as long as it runs. The symptom is never local to the slow endpoint: the whole UI
goes dead, and the user sees whichever button they happened to press do nothing.
So a handler that only does blocking work is declared ``def``, which FastAPI runs on
its worker threadpool; a handler that genuinely needs the loop (to spawn a background
task, say) stays ``async def`` and hands its blocking part to ``run_in_threadpool``.

Modules here import the shared core (config_store, genome_context, gff_index, ...)
as modules and call ``module.name``, so a test that patches the defining module is
seen by every caller. Nothing here may import ``main``.
"""

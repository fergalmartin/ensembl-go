"""Yield periodically during long annotation work to keep the API responsive.

Parsing runs on background threads but can still starve the event loop by
repeatedly reacquiring CPython's interpreter lock. Brief, regular pauses let
other threads run at a small cost to parsing speed.

Set ENSEMBL_GO_COOPERATIVE_YIELD=0 to disable yielding for benchmarks.
"""

from __future__ import annotations

import os
import time
from typing import Iterable, Iterator, Optional, TypeVar

T = TypeVar("T")

#: How long to run before standing aside, and for how long. The ratio is the
#: slowdown the parse accepts; the absolute values decide how long a request can
#: sit behind the parse before it gets its first window.
DEFAULT_WORK_SLICE = 0.025
DEFAULT_YIELD_SLICE = 0.0025

#: Iterations between clock reads. ``time.monotonic()`` is cheap, but a GFF3
#: line loop runs tens of millions of times, so it is not free.
DEFAULT_CLOCK_INTERVAL = 512

_ENV_FLAG = "ENSEMBL_GO_COOPERATIVE_YIELD"


def yielding_enabled() -> bool:
    """Whether cooperative yielding is switched on for this process."""
    return str(os.environ.get(_ENV_FLAG, "1")).strip().lower() not in {"0", "false", "no"}


class CooperativeYielder:
    """Releases the interpreter lock every ``work_slice`` seconds of work.

    Call :meth:`tick` from the innermost loop of a long CPU-bound job. Ticking is
    a decrement and a branch on all but every few hundred calls, so it is safe to
    put on a per-line path.
    """

    __slots__ = ("_work_slice", "_yield_slice", "_clock_interval", "_countdown", "_resume_at", "_enabled")

    def __init__(
        self,
        work_slice: float = DEFAULT_WORK_SLICE,
        yield_slice: float = DEFAULT_YIELD_SLICE,
        clock_interval: int = DEFAULT_CLOCK_INTERVAL,
        enabled: bool = True,
    ) -> None:
        self._work_slice = max(0.0, float(work_slice))
        self._yield_slice = max(0.0, float(yield_slice))
        self._clock_interval = max(1, int(clock_interval))
        self._countdown = self._clock_interval
        self._resume_at = time.monotonic() + self._work_slice
        self._enabled = bool(enabled) and yielding_enabled()

    def tick(self) -> None:
        """Stand aside if this slice of work has run long enough."""
        if not self._enabled:
            return
        self._countdown -= 1
        if self._countdown > 0:
            return
        self._countdown = self._clock_interval
        now = time.monotonic()
        if now < self._resume_at:
            return
        # sleep() drops the interpreter lock for its whole duration, so this is a
        # window the event loop gets to itself rather than a hint it may be
        # scheduled. Re-read the clock afterwards: the sleep can overshoot.
        time.sleep(self._yield_slice)
        self._resume_at = time.monotonic() + self._work_slice


def each(items: Iterable[T], yielder: Optional[CooperativeYielder] = None) -> Iterator[T]:
    """Iterate ``items``, standing aside periodically.

    For loops that have no natural place to call :meth:`CooperativeYielder.tick`
    — a plain pass over every parsed feature, say — wrapping the sequence is the
    least intrusive way to make them interruptible.
    """
    tick = (yielder or CooperativeYielder()).tick
    for item in items:
        tick()
        yield item

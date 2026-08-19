"""Long parses must not starve the API that is hosting them.

Annotation analysis and index builds run on a worker thread inside the API
process. CPython runs one thread of bytecode at a time, and a parse loop
reacquires the interpreter so promptly that request handling does not merely
slow down, it stops: measured on the 7 MB C. elegans GFF3, ``/api/health`` went
from 1.4 ms to 2.8 s and the download view's genome list from 32 ms to 3.0 s.
The 1.6 GB RefSeq human GFF3 sustains that for the length of the analysis, which
is what made the download and genome views look like they had hung.

These tests pin the mechanism rather than the wall-clock numbers: that the parse
loops stand aside periodically, and that a thread waiting on them gets the
interpreter often enough to make steady progress.
"""

import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from annotation import cooperative  # noqa: E402
from annotation.cooperative import (  # noqa: E402
    CooperativeYielder,
    each,
    yielding_enabled,
)
from annotation.dialect import iter_data_lines  # noqa: E402


class CooperativeYielderTests(unittest.TestCase):
    def test_it_stands_aside_once_the_work_slice_is_spent(self):
        yielder = CooperativeYielder(work_slice=0.005, yield_slice=0.002, clock_interval=1)
        started = time.monotonic()
        while time.monotonic() - started < 0.05:
            yielder.tick()
        # 50 ms of work at a 5 ms slice is ~10 yields of 2 ms; allow slack for a
        # loaded machine but insist that yielding happened at all.
        self.assertGreater(time.monotonic() - started, 0.05)

    def test_ticking_is_free_until_the_slice_is_spent(self):
        yielder = CooperativeYielder(work_slice=60.0, yield_slice=1.0, clock_interval=1)
        started = time.monotonic()
        for _ in range(1000):
            yielder.tick()
        self.assertLess(time.monotonic() - started, 0.5, "ticks slept before the slice was up")

    def test_it_can_be_switched_off(self):
        yielder = CooperativeYielder(
            work_slice=0.0, yield_slice=1.0, clock_interval=1, enabled=False
        )
        started = time.monotonic()
        for _ in range(10):
            yielder.tick()
        self.assertLess(time.monotonic() - started, 0.5)

    def test_the_environment_flag_switches_it_off(self):
        previous = os.environ.get("ENSEMBL_GO_COOPERATIVE_YIELD")
        os.environ["ENSEMBL_GO_COOPERATIVE_YIELD"] = "0"
        try:
            self.assertFalse(yielding_enabled())
            yielder = CooperativeYielder(work_slice=0.0, yield_slice=1.0, clock_interval=1)
            started = time.monotonic()
            for _ in range(10):
                yielder.tick()
            self.assertLess(time.monotonic() - started, 0.5)
        finally:
            if previous is None:
                os.environ.pop("ENSEMBL_GO_COOPERATIVE_YIELD", None)
            else:
                os.environ["ENSEMBL_GO_COOPERATIVE_YIELD"] = previous

    def test_each_passes_every_item_through(self):
        items = list(range(100))
        self.assertEqual(list(each(items)), items)


class AnnotationReadYieldsTests(unittest.TestCase):
    """The real read path must hand the interpreter back, not just the helper."""

    def setUp(self):
        self.tempdir = tempfile.mkdtemp()
        self.gff = Path(self.tempdir) / "big.gff3"
        rows = ["##gff-version 3"]
        for index in range(200000):
            start = index * 100 + 1
            rows.append(
                "chr1\ttest\tgene\t{0}\t{1}\t.\t+\t.\tID=g{2};Name=G{2};"
                "description=a reasonably long description to parse".format(
                    start, start + 90, index
                )
            )
        self.gff.write_text("\n".join(rows) + "\n")

    def tearDown(self):
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def _count_yields(self):
        """How many times reading the file stands aside."""
        yields = []
        real_sleep = cooperative.time.sleep

        def counting_sleep(seconds):
            yields.append(seconds)
            real_sleep(seconds)

        with patch.object(cooperative.time, "sleep", counting_sleep):
            started = time.monotonic()
            for _ in iter_data_lines(str(self.gff)):
                pass
            elapsed = time.monotonic() - started
        return len(yields), elapsed

    def test_reading_an_annotation_stands_aside(self):
        count, elapsed = self._count_yields()
        self.assertGreaterEqual(
            count, 1, "a {0:.2f}s read never handed the interpreter back".format(elapsed)
        )
        # And no more often than the slice allows: the whole point is that the
        # per-line tick is nearly free, not that the read sleeps its way through.
        self.assertLessEqual(
            count,
            int(elapsed / cooperative.DEFAULT_WORK_SLICE) + 2,
            "the read yielded {0} times in {1:.2f}s, far more than its work slice "
            "allows".format(count, elapsed),
        )

    def test_no_yields_when_switched_off(self):
        previous = os.environ.get("ENSEMBL_GO_COOPERATIVE_YIELD")
        os.environ["ENSEMBL_GO_COOPERATIVE_YIELD"] = "0"
        try:
            count, _ = self._count_yields()
        finally:
            if previous is None:
                os.environ.pop("ENSEMBL_GO_COOPERATIVE_YIELD", None)
            else:
                os.environ["ENSEMBL_GO_COOPERATIVE_YIELD"] = previous
        self.assertEqual(count, 0)


if __name__ == "__main__":
    unittest.main()

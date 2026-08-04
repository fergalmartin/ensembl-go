"""Browsing must never build an annotation index while a request is open.

Building a GFF3 index takes minutes on a large annotation. When the browse
endpoints did that inline they held the event loop for the whole build, so the
genome selector could not list genomes, the browser's own readiness poll could
not be answered, and a Ctrl-C had to wait for the wedged request before the
server would shut down. A missing or stale index now goes to the background
index worker and the request says so straight away.
"""

import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


TOY_GFF = (
    "##gff-version 3\n"
    "chr1\ttest\tgene\t1\t100\t.\t+\t.\tID=g1;Name=G1\n"
    "chr1\ttest\tmRNA\t1\t100\t.\t+\t.\tID=t1;Parent=g1\n"
    "chr1\ttest\texon\t1\t100\t.\t+\t.\tID=e1;Parent=t1\n"
)


class BrowseIndexReadinessTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.gff = self.root / "toy.gff3"
        self.gff.write_text(TOY_GFF)
        self.db = self.root / "toy.gff3.index.db"
        self.context = {"db_path": str(self.db), "gff_path": str(self.gff)}
        with main._index_tasks_guard:
            main._index_tasks.clear()

    def tearDown(self):
        # The worker builds into this directory, so let any build it was handed
        # finish before the directory goes away.
        deadline = time.time() + 30
        while time.time() < deadline:
            with main._index_tasks_guard:
                busy = any(
                    task.get("status") in {"queued", "running"}
                    for task in main._index_tasks.values()
                )
            if not busy:
                break
            time.sleep(0.05)
        shutil.rmtree(self.root, ignore_errors=True)

    def _await_index(self, timeout=30.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.db.exists() and main._is_existing_index_usable(str(self.db), str(self.gff)):
                return True
            time.sleep(0.05)
        return False

    def test_missing_index_is_reported_rather_than_built_inline(self):
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            with patch.object(main, "ensure_gff_index", side_effect=AssertionError("built inline")):
                with self.assertRaises(HTTPException) as caught:
                    main._get_browse_db("reference")

        self.assertEqual(caught.exception.status_code, main.INDEX_BUILDING_STATUS)
        self.assertFalse(self.db.exists(), "the request must not have produced the index itself")

    def test_the_build_is_handed_to_the_background_worker(self):
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            with self.assertRaises(HTTPException):
                main._get_browse_db("reference")

            self.assertTrue(self._await_index(), "the queued build never completed")
            self.assertEqual(
                main._get_browse_db("reference"),
                main._normalize_fs_path(str(self.db)),
            )

    def test_a_second_request_reuses_the_queued_build(self):
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            task_ids = set()
            for _ in range(3):
                with self.assertRaises(HTTPException):
                    main._get_browse_db("reference")
                with main._index_tasks_guard:
                    task_ids |= set(main._index_tasks)
            self.assertEqual(len(task_ids), 1, "each poll queued another build of the same index")

    def test_a_pending_index_is_not_reported_as_an_absent_annotation(self):
        # _get_browse_db_optional turns "no annotation" into "", which renders the
        # genome without a gene track. A build in progress must not look like that,
        # or the view would settle on an empty track and never correct itself.
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            with self.assertRaises(HTTPException) as caught:
                main._get_browse_db_optional("reference")
        self.assertEqual(caught.exception.status_code, main.INDEX_BUILDING_STATUS)

    def test_a_genome_without_an_annotation_still_reports_no_index(self):
        with patch.object(
            main,
            "_resolve_browse_genome_context",
            return_value={"db_path": "", "gff_path": ""},
        ):
            self.assertEqual(main._get_browse_db_optional("reference"), "")

    def test_resolving_an_index_does_not_block_on_a_running_build(self):
        # The lock a build holds must never be waited on by a request. A build is
        # simulated by holding the rebuild guard while resolving the index.
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            main._index_rebuild_guard.acquire()
            try:
                started = time.time()
                with self.assertRaises(HTTPException):
                    main._get_browse_db("reference")
                self.assertLess(time.time() - started, 2.0)
            finally:
                main._index_rebuild_guard.release()

    def test_queue_index_build_is_safe_to_call_from_several_threads(self):
        results = []
        barrier = threading.Barrier(4)

        def worker():
            barrier.wait()
            results.append(main.queue_index_build(str(self.gff), str(self.db))[0])

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(len(set(results)), 1, "concurrent callers queued duplicate builds")


if __name__ == "__main__":
    unittest.main()

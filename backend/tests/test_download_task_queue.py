"""Download tasks: the concurrency cap, and cancelling by task id or all at once.

Everything here runs against a swapped-in task table and a temporary directory, so
no test touches the user's real downloads or output directory.
"""

import asyncio
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import download_manager as dm  # noqa: E402
import main  # noqa: E402
from download_manager import DownloadTask  # noqa: E402


def _task(task_id, file_type="fasta", status="pending", species_key="homo_sapiens", assembly="GCA_1", destination=""):
    return DownloadTask(
        id=task_id,
        filename=f"{task_id}.gz",
        url="https://ftp.ebi.ac.uk/pub/ensemblorganisms/x",
        species_key=species_key,
        assembly=assembly,
        file_type=file_type,
        status=status,
        destination=destination,
    )


class CancelByIdTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tasks = {}
        patcher = patch.object(main.download_manager, "tasks", self.tasks)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_cancels_only_the_named_task(self):
        self.tasks["a"] = _task("a", file_type="homology", status="downloading")
        self.tasks["b"] = _task("b", file_type="cdna")

        cancelled = main._cancel_download_tasks_by_id(["a"])

        self.assertEqual(cancelled, ["a"])
        self.assertEqual(self.tasks["a"].status, "canceled")
        self.assertTrue(self.tasks["a"].cancel_requested)
        self.assertEqual(self.tasks["b"].status, "pending")

    def test_core_file_takes_its_genomes_metadata_with_it(self):
        self.tasks["fa"] = _task("fa", file_type="fasta", status="downloading")
        self.tasks["meta"] = _task("meta", file_type="metadata")
        self.tasks["other_meta"] = _task("other_meta", file_type="metadata", assembly="GCA_2")

        cancelled = main._cancel_download_tasks_by_id(["fa"])

        self.assertEqual(set(cancelled), {"fa", "meta"})
        self.assertEqual(self.tasks["other_meta"].status, "pending")

    def test_all_cancels_every_active_task_and_leaves_finished_ones(self):
        self.tasks["a"] = _task("a", status="downloading")
        self.tasks["b"] = _task("b", file_type="gff3")
        self.tasks["done"] = _task("done", status="completed")
        self.tasks["failed"] = _task("failed", status="failed")

        cancelled = main._cancel_download_tasks_by_id([], cancel_all=True)

        self.assertEqual(set(cancelled), {"a", "b"})
        self.assertEqual(self.tasks["done"].status, "completed")
        self.assertEqual(self.tasks["failed"].status, "failed")

    def test_removes_partial_file(self):
        destination = Path(self.tmp.name) / "genome.fa.gz"
        partial = destination.with_suffix(destination.suffix + ".tmp")
        partial.write_bytes(b"partial")
        self.tasks["a"] = _task("a", status="downloading", destination=str(destination))

        main._cancel_download_tasks_by_id(["a"])

        self.assertFalse(partial.exists())

    def test_endpoint_reports_not_found_when_nothing_matches(self):
        result = asyncio.run(main.cancel_download_tasks(main.CancelDownloadTasksRequest(task_ids=["missing"])))
        self.assertEqual(result, {"status": "not_found", "task_ids": [], "count": 0})


class ConcurrencyCapTests(unittest.TestCase):
    def test_only_the_cap_run_at_once_and_a_cancelled_queued_task_never_starts(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = dm.DownloadManager(Path(tmp) / "data", cache_dir=Path(tmp) / "cache")
            count = dm.MAX_CONCURRENT_DOWNLOADS + 2
            for index in range(count):
                manager.tasks[str(index)] = _task(str(index), destination=str(Path(tmp) / f"{index}.gz"))

            lock = threading.Lock()
            state = {"running": 0, "peak": 0, "calls": 0}

            def fake_to_thread(fn):
                state["calls"] += 1

                async def run():
                    with lock:
                        state["running"] += 1
                        state["peak"] = max(state["peak"], state["running"])
                    await asyncio.sleep(0.05)
                    with lock:
                        state["running"] -= 1
                return run()

            async def scenario():
                with patch.object(dm.asyncio, "to_thread", new=fake_to_thread):
                    jobs = [
                        asyncio.create_task(manager.download_file("https://x", Path(tmp) / f"{i}.gz", str(i)))
                        for i in range(count)
                    ]
                    await asyncio.sleep(0)
                    # The last task is still queued; cancelling it must keep it from running.
                    manager.tasks[str(count - 1)].cancel_requested = True
                    manager.tasks[str(count - 1)].status = "canceled"
                    await asyncio.gather(*jobs)

            asyncio.run(scenario())

            self.assertEqual(state["peak"], dm.MAX_CONCURRENT_DOWNLOADS)
            self.assertEqual(state["running"], 0)
            self.assertEqual(state["calls"], count - 1)


if __name__ == "__main__":
    unittest.main()

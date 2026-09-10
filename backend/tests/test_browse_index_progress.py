"""A genome browses while its genes are still being indexed, and says how far along.

Indexing is deliberately serial — two multi-gigabyte parses at once starve
everything else in the process — so loading two genomes at once means the second
waits minutes for the first. What the user saw for that whole time was an
indeterminate spinner on both panels and nothing else.

Two things changed. Regions come from the FASTA, which is ready immediately, so
the browser draws the assembly and the sequence track and leaves only the gene
track outstanding. And ``/api/browse/index-status`` reports the build behind that
gene track: whether it is running or queued, how far through the file it is, and
where it sits in the line.

The failure path changed with it. A failed build is remembered so that polling
does not turn an unparseable file into an endless rebuild loop, but it used to be
remembered for the lifetime of the process, with no way out but a restart.
"""

import shutil
import sys
import tempfile
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


class IndexProgressTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.gff = self.root / "toy.gff3"
        self.gff.write_text(TOY_GFF)
        self.db = self.root / "toy.gff3.index.db"
        self.context = {"db_path": str(self.db), "gff_path": str(self.gff)}
        self._clear_tasks()

    def tearDown(self):
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
        self._clear_tasks()
        shutil.rmtree(self.root, ignore_errors=True)

    def _clear_tasks(self):
        with main._index_tasks_guard:
            main._index_tasks.clear()

    def _record_task(self, task_id, **fields):
        task = {
            "status": "queued",
            "db_path": main._normalize_fs_path(str(self.db)),
            "gff_path": main._normalize_fs_path(str(self.gff)),
            "gff_signature": main._annotation_signature(str(self.gff)),
            "index_path": None,
            "error": None,
            "progress": None,
            "queued_at": main.now_iso(),
        }
        task.update(fields)
        with main._index_tasks_guard:
            main._index_tasks[task_id] = task
        return task

    # -- regions while the index is still coming ---------------------------

    def test_regions_do_not_wait_for_the_gene_index(self):
        # The assembly is in the FASTA and is ready at once. Holding the whole
        # panel back for a build that takes minutes was the entire complaint.
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            db_path, pending = main._get_browse_db_for_regions("reference")
        self.assertEqual(db_path, "")
        self.assertTrue(pending, "the caller was not told genes are still coming")

    def test_a_genome_with_no_annotation_is_not_reported_as_pending(self):
        # "There are no genes" and "the genes are not here yet" must stay
        # distinguishable, or the browser waits for ever on an empty track.
        with patch.object(
            main,
            "_resolve_browse_genome_context",
            return_value={"db_path": "", "gff_path": ""},
        ):
            self.assertEqual(main._get_browse_db_for_regions("reference"), ("", False))

    def test_a_built_index_is_handed_over_with_nothing_outstanding(self):
        main.ensure_gff_index(str(self.gff), str(self.db))
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            db_path, pending = main._get_browse_db_for_regions("reference")
        self.assertEqual(db_path, main._normalize_fs_path(str(self.db)))
        self.assertFalse(pending)

    def test_gene_queries_still_refuse_to_answer_without_an_index(self):
        # Regions may be served early; genes may not. An empty gene list would be
        # cached by the browser as "nothing here" and never corrected.
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            with self.assertRaises(HTTPException) as caught:
                main._get_browse_db("reference")
        self.assertEqual(caught.exception.status_code, main.INDEX_BUILDING_STATUS)

    # -- what the meter is drawn from --------------------------------------

    def test_status_reports_a_running_build_with_its_progress(self):
        self._record_task("running", status="running", progress={
            "stage": "parsing",
            "processed_bytes": 500,
            "total_bytes": 1000,
            "genes": 12,
            "transcripts": 30,
        })
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            status = main._index_status_for_genome("reference")

        self.assertEqual(status["state"], main.INDEX_STATE_BUILDING)
        self.assertEqual(status["percent"], 48.0)
        self.assertEqual(status["genes"], 12)
        self.assertEqual(status["queue_position"], 1)

    def test_the_meter_stops_short_of_full_while_transcripts_are_written(self):
        # Reading the file is not the whole job. Sitting on 100% through the
        # write-out reads as a finished build that has hung.
        self._record_task("running", status="running", progress={
            "stage": "writing",
            "processed_bytes": 1000,
            "total_bytes": 1000,
            "genes": 900,
            "transcripts": 2000,
        })
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            status = main._index_status_for_genome("reference")
        self.assertEqual(status["percent"], 96.0)
        self.assertLess(status["percent"], 100.0)

    def test_a_genome_waiting_behind_another_build_is_told_where_it_is(self):
        other_gff = self.root / "other.gff3"
        other_gff.write_text(TOY_GFF)
        self._record_task(
            "running",
            status="running",
            gff_path=main._normalize_fs_path(str(other_gff)),
            db_path=main._normalize_fs_path(str(self.root / "other.index.db")),
        )
        self._record_task("waiting", status="queued")

        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            status = main._index_status_for_genome("reference")

        self.assertEqual(status["state"], main.INDEX_STATE_QUEUED)
        self.assertEqual(status["queue_position"], 2)
        self.assertEqual(status["queue_length"], 2)

    def test_status_reports_a_built_index_as_ready(self):
        main.ensure_gff_index(str(self.gff), str(self.db))
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            status = main._index_status_for_genome("reference")
        self.assertEqual(status["state"], main.INDEX_STATE_READY)
        self.assertEqual(status["percent"], 100.0)

    def test_a_genome_without_an_annotation_reports_no_gene_track(self):
        with patch.object(
            main,
            "_resolve_browse_genome_context",
            return_value={"db_path": "", "gff_path": ""},
        ):
            status = main._index_status_for_genome("reference")
        self.assertEqual(status["state"], main.INDEX_STATE_NONE)

    def test_asking_for_status_never_starts_a_build(self):
        # Views that only watch progress must not be the thing that begins work.
        with patch.object(main, "_resolve_browse_genome_context", return_value=self.context):
            with patch.object(main, "queue_index_build", side_effect=AssertionError("queued")):
                status = main._index_status_for_genome("reference")
        self.assertEqual(status["state"], main.INDEX_STATE_ABSENT)

    # -- getting out of a failed build -------------------------------------

    def test_a_remembered_failure_can_be_discarded(self):
        self._record_task("failed", status="failed", error="bad line 4", completed_at=main.now_iso())
        self.assertEqual(main._index_build_error_for(str(self.gff), str(self.db)), "bad line 4")

        self.assertEqual(main.forget_index_failures(str(self.gff), str(self.db)), 1)
        self.assertEqual(main._index_build_error_for(str(self.gff), str(self.db)), "")

    def test_replacing_the_annotation_clears_the_failure_by_itself(self):
        # The failure belongs to the bytes that caused it. Re-download a
        # truncated file and the genome must start building again unaided.
        self._record_task("failed", status="failed", error="unexpected end of file",
                          completed_at=main.now_iso())
        self.assertNotEqual(main._index_build_error_for(str(self.gff), str(self.db)), "")

        self.gff.write_text(TOY_GFF + "chr1\ttest\tgene\t200\t300\t.\t-\t.\tID=g2;Name=G2\n")
        self.assertEqual(main._index_build_error_for(str(self.gff), str(self.db)), "")

    def test_a_failure_survives_a_poll_of_the_same_unchanged_file(self):
        self._record_task("failed", status="failed", error="bad line 4", completed_at=main.now_iso())
        for _ in range(3):
            self.assertEqual(main._index_build_error_for(str(self.gff), str(self.db)), "bad line 4")

    def test_the_task_registry_does_not_grow_without_limit(self):
        for n in range(main.MAX_FINISHED_INDEX_TASKS + 15):
            self._record_task(f"done-{n:04d}", status="success", completed_at=f"2020-01-01T00:00:{n:02d}Z")
        main._prune_finished_index_tasks()
        with main._index_tasks_guard:
            self.assertEqual(len(main._index_tasks), main.MAX_FINISHED_INDEX_TASKS)
            # The newest are what a caller might still be asking about.
            self.assertIn("done-0054", main._index_tasks)
            self.assertNotIn("done-0000", main._index_tasks)

    # -- the numbers behind the meter --------------------------------------

    def test_building_an_index_reports_progress_as_it_goes(self):
        big = self.root / "big.gff3"
        rows = ["##gff-version 3\n"]
        for n in range(60000):
            rows.append(f"chr1\ttest\tgene\t{n * 10 + 1}\t{n * 10 + 9}\t.\t+\t.\tID=g{n};Name=G{n}\n")
        big.write_text("".join(rows))

        seen = []
        main.create_gff_index(str(big), str(self.root / "big.index.db"), progress_cb=seen.append)

        self.assertTrue(seen, "the build reported nothing at all")
        self.assertTrue(any(item["stage"] == "parsing" for item in seen))
        self.assertTrue(any(item["stage"] == "writing" for item in seen))
        self.assertTrue(
            all(item["total_bytes"] == big.stat().st_size for item in seen),
            "progress was measured against the wrong total",
        )
        positions = [item["processed_bytes"] for item in seen if item["stage"] == "parsing"]
        self.assertEqual(positions, sorted(positions), "progress went backwards")
        self.assertGreater(max(positions), 0, "progress never moved off zero")

    def test_progress_reporting_never_breaks_a_build(self):
        def explode(_progress):
            raise RuntimeError("the meter blew up")

        db = self.root / "resilient.index.db"
        main.create_gff_index(str(self.gff), str(db), progress_cb=explode)
        self.assertTrue(main._is_existing_index_usable(str(db), str(self.gff)))


class ConfigCacheTests(unittest.TestCase):
    """Loading the configuration is on every request path, including the polls."""

    def tearDown(self):
        main.invalidate_config_cache()

    def test_repeated_loads_do_not_re_read_the_file(self):
        main.invalidate_config_cache()
        with patch.object(main, "_load_config_uncached", wraps=main._load_config_uncached) as loader:
            for _ in range(20):
                main.load_config()
        self.assertEqual(loader.call_count, 1)

    def test_each_caller_gets_its_own_copy_to_mutate(self):
        main.invalidate_config_cache()
        first = main.load_config()
        first["output_dir"] = "/somewhere/a-caller-scribbled-here"
        second = main.load_config()
        self.assertNotEqual(second.get("output_dir"), "/somewhere/a-caller-scribbled-here")

    def test_invalidating_forces_the_next_load_to_go_to_disk(self):
        main.load_config()
        main.invalidate_config_cache()
        with patch.object(main, "_load_config_uncached", wraps=main._load_config_uncached) as loader:
            main.load_config()
        self.assertEqual(loader.call_count, 1)


if __name__ == "__main__":
    unittest.main()

"""A genome must browse with the index that is on disk, not the one it was saved with.

``active_species[].files`` is a snapshot taken when a genome is registered. A
genome registered before its index existed — which is every RefSeq download,
since the annotation arrives unindexed — keeps an empty ``index`` entry for
ever. Browsing used to read that entry and nothing else, so the index could be
built, land beside the GFF, and the browser would still report a genome with no
genes, with no way for the user to get out of it.

Resolution now goes to the filesystem when the saved entry has no usable index,
and names the file the build would write when there is nothing there yet, so the
missing index becomes "still building" (which the browser polls on) rather than
"no annotation" (which it renders as an empty gene track).
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


class BrowseIndexRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        # Mirror the layout a RefSeq download produces: the annotation sits in a
        # dataset release folder under local_data/<provider>/<species>/<assembly>.
        self.release_dir = (
            self.root / "local_data" / "ncbi" / "Homo_sapiens" / "GCF_000001405.40"
            / "datasets" / "ncbi" / "current"
        )
        self.release_dir.mkdir(parents=True)
        self.gff = self.release_dir / "GCF_000001405.40.genomic.gff"
        self.gff.write_text(TOY_GFF)
        self.cfg = {"output_dir": str(self.root)}
        self._reset_state()

    def tearDown(self):
        self._await_quiet_worker()
        self._reset_state()
        shutil.rmtree(self.root, ignore_errors=True)

    def _reset_state(self):
        with main._index_tasks_guard:
            main._index_tasks.clear()
        with main._RECOVERED_INDEX_GUARD:
            main._RECOVERED_INDEX_PATHS.clear()

    def _await_quiet_worker(self, timeout=60.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with main._index_tasks_guard:
                busy = any(
                    task.get("status") in {"queued", "running"}
                    for task in main._index_tasks.values()
                )
            if not busy:
                return
            time.sleep(0.05)

    def _build_index(self, name):
        """Build a real index beside the GFF, as the selector's Build does."""
        db = self.release_dir / name
        main.ensure_gff_index(str(self.gff), str(db))
        return db

    # ── recovering an index the saved entry never learned about ──────────────

    def test_an_index_built_after_registration_is_found_on_disk(self):
        db = self._build_index("GCF_000001405.40.genomic.gff3.index.db")
        resolved = main._resolve_annotation_index(str(self.gff), self.cfg, "GCF_000001405.40")
        self.assertEqual(
            main._normalize_fs_path(resolved),
            main._normalize_fs_path(str(db)),
        )

    def test_browsing_uses_the_index_on_disk_when_the_saved_entry_has_none(self):
        db = self._build_index("GCF_000001405.40.genomic.gff3.index.db")
        species = {
            "assembly": "GCF_000001405.40",
            "files": {"gff3": str(self.gff)},  # exactly what a RefSeq download saves
        }
        cfg = dict(self.cfg, active_species=[species], ref_gff="", target_gff="")

        with patch.object(main, "load_config", return_value=cfg):
            with patch.object(main, "_dedupe_active_species", return_value=[species]):
                with patch.object(main, "_active_species_item_key", return_value="genome-key"):
                    self.assertEqual(
                        main._get_browse_db("genome-key"),
                        main._normalize_fs_path(str(db)),
                    )

    def test_a_stale_saved_index_path_does_not_hide_the_real_one(self):
        db = self._build_index("GCF_000001405.40.genomic.gff3.index.db")
        removed = self.release_dir / "gone.gff3.index.db"
        resolved = main._browse_index_for(
            str(self.gff), str(removed), self.cfg, {"assembly": "GCF_000001405.40"}
        )
        self.assertEqual(
            main._normalize_fs_path(resolved),
            main._normalize_fs_path(str(db)),
        )

    def test_a_genome_with_no_annotation_resolves_to_no_index(self):
        self.assertEqual(main._resolve_annotation_index("", self.cfg), "")
        self.assertEqual(
            main._resolve_annotation_index(str(self.release_dir / "absent.gff"), self.cfg),
            "",
        )

    # ── nothing built yet: build it, do not report an absent annotation ──────

    def test_an_unindexed_annotation_names_a_target_so_the_build_can_be_queued(self):
        resolved = main._resolve_annotation_index(str(self.gff), self.cfg, "GCF_000001405.40")
        self.assertTrue(resolved, "an unindexed annotation must still name its index")
        self.assertFalse(Path(resolved).exists())
        self.assertEqual(Path(resolved).parent, self.release_dir.resolve())

    def test_browsing_an_unindexed_annotation_builds_it_instead_of_showing_no_genes(self):
        species = {"assembly": "GCF_000001405.40", "files": {"gff3": str(self.gff)}}
        cfg = dict(self.cfg, active_species=[species], ref_gff="", target_gff="")

        with patch.object(main, "load_config", return_value=cfg):
            with patch.object(main, "_dedupe_active_species", return_value=[species]):
                with patch.object(main, "_active_species_item_key", return_value="genome-key"):
                    with self.assertRaises(HTTPException) as caught:
                        # _optional is what the region list uses: it must not turn
                        # this into "" and render a genome with an empty gene track.
                        main._get_browse_db_optional("genome-key")
                    self.assertEqual(caught.exception.status_code, main.INDEX_BUILDING_STATUS)

                    self._await_quiet_worker()
                    self.assertEqual(
                        main._get_browse_db("genome-key"),
                        main._normalize_fs_path(
                            main._resolve_annotation_index(str(self.gff), cfg, "GCF_000001405.40")
                        ),
                    )

    def test_a_build_already_running_is_adopted_rather_than_started_again(self):
        # The selector builds to a name derived from the file; the browse path
        # derives its own from the assembly. Two names for one annotation must
        # not mean two parses of a multi-gigabyte GFF3.
        with main._index_tasks_guard:
            main._index_tasks["task"] = {
                "status": "running",
                "db_path": main._normalize_fs_path(str(self.release_dir / "selector.index.db")),
                "gff_path": main._normalize_fs_path(str(self.gff)),
            }
        resolved = main._resolve_annotation_index(str(self.gff), self.cfg, "GCF_000001405.40")
        self.assertEqual(Path(resolved).name, "selector.index.db")

    def test_queueing_the_same_annotation_under_another_name_reuses_the_build(self):
        first, _ = main.queue_index_build(str(self.gff), str(self.release_dir / "a.index.db"))
        second, _ = main.queue_index_build(str(self.gff), str(self.release_dir / "b.index.db"))
        self.assertEqual(first, second)

    # ── a build that cannot succeed must not be retried on every poll ────────

    def test_a_failed_build_is_reported_instead_of_queued_again(self):
        db = self.release_dir / "GCF_000001405.40.gff3.index.db"
        with main._index_tasks_guard:
            main._index_tasks["failed"] = {
                "status": "failed",
                "db_path": main._normalize_fs_path(str(db)),
                "gff_path": main._normalize_fs_path(str(self.gff)),
                "error": "unreadable attributes on line 4",
                "completed_at": main.now_iso(),
            }

        context = {"db_path": str(db), "gff_path": str(self.gff)}
        with patch.object(main, "_resolve_browse_genome_context", return_value=context):
            with patch.object(main, "queue_index_build", side_effect=AssertionError("requeued")):
                with self.assertRaises(HTTPException) as caught:
                    main._get_browse_db("genome-key")

        self.assertEqual(caught.exception.status_code, 500)
        self.assertIn("unreadable attributes", caught.exception.detail)

    def test_a_later_successful_build_clears_the_reported_failure(self):
        db = self._build_index("GCF_000001405.40.gff3.index.db")
        with main._index_tasks_guard:
            main._index_tasks["failed"] = {
                "status": "failed",
                "db_path": main._normalize_fs_path(str(db)),
                "gff_path": main._normalize_fs_path(str(self.gff)),
                "error": "transient disk error",
                "completed_at": "2020-01-01T00:00:00Z",
            }
            main._index_tasks["ok"] = {
                "status": "success",
                "db_path": main._normalize_fs_path(str(db)),
                "gff_path": main._normalize_fs_path(str(self.gff)),
                "error": None,
                "completed_at": "2030-01-01T00:00:00Z",
            }
        self.assertEqual(main._index_build_error_for(str(self.gff), str(db)), "")


if __name__ == "__main__":
    unittest.main()

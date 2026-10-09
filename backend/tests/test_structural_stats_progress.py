"""Structural stats must report real progress while they run.

The Stats view runs one genome per task, and progress used to be counted in finished
genomes, so it sat at 0% for the whole run and then jumped to done. The work is a pass
over each protein-coding gene's canonical transcript, with a known total, so it can
say how far through it is.
"""

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
import routes.stats  # noqa: E402
from stats_utils import compute_structural_stats  # noqa: E402

GENE_COUNT = 250


def _write_index(path: Path, gene_count: int = GENE_COUNT) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE genes (id TEXT PRIMARY KEY, biotype TEXT)")
        conn.execute(
            "CREATE TABLE transcripts (id TEXT PRIMARY KEY, chrom TEXT, start INTEGER, strand TEXT,"
            " parent_gene_id TEXT, is_canonical INTEGER, data TEXT)"
        )
        for i in range(gene_count):
            start = 1000 + (i * 5000)
            data = {
                "exons": [{"start": start, "end": start + 99}, {"start": start + 400, "end": start + 499}],
                "cds_list": [{"start": start + 10, "end": start + 99}, {"start": start + 400, "end": start + 489}],
                "utrs": [],
            }
            conn.execute("INSERT INTO genes VALUES (?, 'protein_coding')", (f"G{i}",))
            conn.execute(
                "INSERT INTO transcripts VALUES (?, 'chr1', ?, '+', ?, 1, ?)",
                (f"T{i}", start, f"G{i}", json.dumps(data)),
            )
        conn.commit()
    finally:
        conn.close()


class ComputeStructuralStatsProgressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.index = Path(self.tmp.name) / "genes.index.db"
        _write_index(self.index)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reports_from_zero_to_the_transcript_total(self):
        calls = []
        result = compute_structural_stats(
            str(self.index), "", include_sequence_checks=False, on_progress=lambda done, total: calls.append((done, total)),
        )
        self.assertEqual(result["transcript_count"], GENE_COUNT)
        self.assertEqual(calls[0], (0, GENE_COUNT))
        self.assertEqual(calls[-1], (GENE_COUNT, GENE_COUNT))
        done_values = [done for done, _ in calls]
        self.assertEqual(done_values, sorted(done_values))
        # Often enough to move a bar smoothly, not once per transcript.
        self.assertGreater(len(calls), 50)
        self.assertLess(len(calls), GENE_COUNT)

    def test_raising_from_a_report_abandons_the_run(self):
        class Stop(Exception):
            pass

        def report(done, total):
            if done >= total // 2:
                raise Stop()

        with self.assertRaises(Stop):
            compute_structural_stats(str(self.index), "", include_sequence_checks=False, on_progress=report)


class StructuralProgressReporterTest(unittest.TestCase):
    TASK_ID = "test-structural-progress-task"
    GENOME = "genome-a"

    def setUp(self):
        with routes.stats._stats_tasks_guard:
            routes.stats._stats_tasks[self.TASK_ID] = {
                "id": self.TASK_ID,
                "task_type": "structural",
                "status": "running",
                "progress": 0.0,
                "message": "",
                "genome_keys": [self.GENOME],
                "results": {self.GENOME: {"status": "running"}},
                "total": 1,
                "completed": 0,
                "cancelled_genome_keys": [],
            }

    def tearDown(self):
        with routes.stats._stats_tasks_guard:
            routes.stats._stats_tasks.pop(self.TASK_ID, None)

    def test_sequence_pass_progress_lands_after_the_quick_pass_share(self):
        share = routes.stats._STRUCTURAL_QUICK_PASS_SHARE
        report = routes.stats._structural_progress_reporter(self.TASK_ID, self.GENOME, share, 1.0 - share, "Checking")
        report(50, 100)
        task = routes.stats._read_stats_task(self.TASK_ID)
        expected = share + ((1.0 - share) * 0.5)
        self.assertAlmostEqual(task["results"][self.GENOME]["progress"], expected)
        self.assertAlmostEqual(task["progress"], expected)
        self.assertEqual(task["results"][self.GENOME]["message"], "Checking")
        self.assertEqual(task["results"][self.GENOME]["status"], "running")

    def test_a_cancelled_genome_stops_at_the_next_report(self):
        report = routes.stats._structural_progress_reporter(self.TASK_ID, self.GENOME, 0.0, 0.25, "Measuring")
        with routes.stats._stats_tasks_guard:
            routes.stats._stats_tasks[self.TASK_ID]["cancelled_genome_keys"] = [self.GENOME]
        with self.assertRaises(routes.stats._StructuralRunCancelled):
            report(10, 100)


if __name__ == "__main__":
    unittest.main()

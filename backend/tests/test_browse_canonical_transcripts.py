import asyncio
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import browse_canonical_transcripts  # noqa: E402


class BrowseCanonicalTranscriptsTests(unittest.TestCase):
    def _write_db(self, path: Path):
        conn = sqlite3.connect(path)
        conn.execute(
            """
            CREATE TABLE genes (
                id TEXT PRIMARY KEY,
                name TEXT,
                description TEXT,
                version TEXT,
                chrom TEXT,
                start INTEGER,
                end INTEGER,
                strand TEXT,
                biotype TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE transcripts (
                id TEXT PRIMARY KEY,
                chrom TEXT,
                start INTEGER,
                end INTEGER,
                strand TEXT,
                parent_gene_id TEXT,
                is_canonical INTEGER DEFAULT 0,
                data TEXT
            )
            """
        )
        conn.commit()
        return conn

    def test_returns_one_canonical_transcript_per_gene(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db = Path(tmpdir) / "browse.sqlite"
            conn = self._write_db(db)
            conn.execute(
                "INSERT INTO genes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("gene1", "GENE1", "desc", "1", "chr1", 100, 300, "+", "protein_coding"),
            )
            conn.execute(
                "INSERT INTO transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("tx_noncanon", "chr1", 110, 290, "+", "gene1", 0, json.dumps({"exons": [{"start": 110, "end": 150}]})),
            )
            conn.execute(
                "INSERT INTO transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("tx_canon", "chr1", 120, 280, "+", "gene1", 1, json.dumps({"exons": [{"start": 120, "end": 200}], "cds_list": [{"start": 140, "end": 190}]})),
            )
            conn.commit()
            conn.close()

            with patch("main._get_browse_db", return_value=str(db)):
                payload = asyncio.run(
                    browse_canonical_transcripts(
                        genome="reference",
                        chrom="1",
                        start=50,
                        end=350,
                    )
                )

        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0].gene.id, "gene1")
        self.assertEqual(payload[0].transcript.id, "tx_canon")
        self.assertTrue(payload[0].transcript.is_canonical)
        self.assertEqual(len(payload[0].transcript.exons), 1)
        self.assertEqual(len(payload[0].transcript.cds_list), 1)

    def test_falls_back_to_first_transcript_when_none_marked_canonical(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db = Path(tmpdir) / "browse.sqlite"
            conn = self._write_db(db)
            conn.execute(
                "INSERT INTO genes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("gene2", "GENE2", "", "", "chr2", 1000, 1600, "-", "lncRNA"),
            )
            conn.execute(
                "INSERT INTO transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("tx_early", "chr2", 1020, 1300, "-", "gene2", 0, json.dumps({"exons": [{"start": 1020, "end": 1100}]})),
            )
            conn.execute(
                "INSERT INTO transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("tx_late", "chr2", 1200, 1550, "-", "gene2", 0, json.dumps({"exons": [{"start": 1200, "end": 1300}]})),
            )
            conn.commit()
            conn.close()

            with patch("main._get_browse_db", return_value=str(db)):
                payload = asyncio.run(
                    browse_canonical_transcripts(
                        genome="target",
                        chrom="chr2",
                        start=900,
                        end=1700,
                    )
                )

        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0].transcript.id, "tx_early")
        self.assertFalse(payload[0].transcript.is_canonical)
        self.assertEqual(payload[0].transcript.strand, "-")

    def test_synthesizes_transcript_from_gene_if_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db = Path(tmpdir) / "browse.sqlite"
            conn = self._write_db(db)
            conn.execute(
                "INSERT INTO genes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("gene3", "GENE3", "", "", "chr3", 200, 500, "+", "protein_coding"),
            )
            conn.commit()
            conn.close()

            with patch("main._get_browse_db", return_value=str(db)):
                payload = asyncio.run(
                    browse_canonical_transcripts(
                        genome="reference",
                        chrom="3",
                        start=100,
                        end=600,
                    )
                )

        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0].gene.id, "gene3")
        self.assertEqual(payload[0].transcript.start, 200)
        self.assertEqual(payload[0].transcript.end, 500)
        self.assertEqual(payload[0].transcript.strand, "+")


if __name__ == "__main__":
    unittest.main()

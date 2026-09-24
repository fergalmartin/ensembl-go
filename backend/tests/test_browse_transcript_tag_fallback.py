"""The GFF tag fallback behind gene search and the gene drawer.

The index records `tags` for every transcript, as an empty list when it has none.
Only an index old enough to lack the key should send the request back to the GFF:
treating an empty list as missing re-read the whole annotation on every search.
"""
import asyncio
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import browse_transcripts, resolve_id  # noqa: E402


class TranscriptTagFallbackTests(unittest.TestCase):
    def _write_db(self, path: Path, transcripts):
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE genes (id TEXT PRIMARY KEY, name TEXT, description TEXT, version TEXT,"
            " chrom TEXT, start INTEGER, end INTEGER, strand TEXT, biotype TEXT)"
        )
        conn.execute(
            "CREATE TABLE transcripts (id TEXT PRIMARY KEY, chrom TEXT, start INTEGER, end INTEGER,"
            " strand TEXT, parent_gene_id TEXT, is_canonical INTEGER DEFAULT 0, data TEXT)"
        )
        conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO metadata VALUES ('source_gff', '/nonexistent.gff3.gz')")
        conn.execute(
            "INSERT INTO genes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("gene1", "GENE1", "desc", "1", "13", 100, 300, "+", "protein_coding"),
        )
        for tx_id, data in transcripts:
            conn.execute(
                "INSERT INTO transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (tx_id, "13", 110, 290, "+", "gene1", 0, json.dumps(data)),
            )
        conn.commit()
        conn.close()

    def _run_both(self, db: Path, fallback):
        with patch("main._get_browse_db", return_value=str(db)), \
                patch("main._resolve_transcript_tags_for_db", side_effect=fallback) as spy:
            asyncio.run(resolve_id(genome="reference", query="GENE1"))
            asyncio.run(browse_transcripts(genome="reference", gene_id="gene1", include_tags_fallback=True))
        return spy

    def test_indexed_empty_tags_do_not_rescan_the_gff(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db = Path(tmpdir) / "browse.sqlite"
            self._write_db(db, [
                ("tx_tagged", {"tags": ["MANE_Select"]}),
                ("tx_untagged", {"tags": []}),
            ])
            spy = self._run_both(db, lambda *_: {})
        spy.assert_not_called()

    def test_index_without_tags_key_still_falls_back(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db = Path(tmpdir) / "browse.sqlite"
            self._write_db(db, [("tx_legacy", {"exons": []})])
            spy = self._run_both(db, lambda _db, ids: {tid: ["basic"] for tid in ids})
        self.assertEqual(spy.call_count, 2)
        for call in spy.call_args_list:
            self.assertEqual(call.args[1], {"tx_legacy"})


if __name__ == "__main__":
    unittest.main()

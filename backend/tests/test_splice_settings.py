import asyncio
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    SpliceBlockTileRequest,
    SpliceBlockTilesRequest,
    _is_canonical_splice_motif,
    _normalize_splice_settings,
    browse_splice_junctions,
    browse_splice_junctions_block_tiles,
)


class SpliceSettingsTests(unittest.TestCase):
    def test_normalize_splice_settings(self):
        raw = {
            "min_support": "5",
            "canonical_mode": "canonical",
            "annotated_mode": "novel",
            "show_arrows": "false",
            "max_junctions": "800",
            "weak_max_support": "6",
            "low_max_support": "8",
            "medium_max_support": "12",
        }
        normalized = _normalize_splice_settings(raw)
        self.assertEqual(normalized["min_support"], 5)
        self.assertEqual(normalized["canonical_mode"], "canonical")
        self.assertEqual(normalized["annotated_mode"], "novel")
        self.assertFalse(normalized["show_arrows"])
        self.assertEqual(normalized["max_junctions"], 800)
        self.assertEqual(normalized["weak_max_support"], 6)
        self.assertEqual(normalized["low_max_support"], 8)
        self.assertEqual(normalized["medium_max_support"], 12)

    def test_canonical_motif_classifier(self):
        self.assertTrue(_is_canonical_splice_motif("GT/AG"))
        self.assertTrue(_is_canonical_splice_motif("CT/AC"))
        self.assertTrue(_is_canonical_splice_motif("GC-AG"))
        self.assertFalse(_is_canonical_splice_motif("non-canonical"))
        self.assertFalse(_is_canonical_splice_motif("unknown"))

    def test_splice_endpoint_filters(self):
        content = "\n".join([
            # chrom start end strand motif annotated unique multi overhang
            "chr1\t100\t200\t1\t1\t1\t3\t0\t50",   # canonical + annotated + support=3
            "chr1\t220\t300\t1\t0\t1\t8\t1\t50",   # non-canonical + annotated
            "chr1\t310\t390\t1\t3\t0\t6\t0\t50",   # canonical + novel
            "chr1\t410\t490\t1\t1\t1\t1\t0\t50",   # canonical + annotated but low support
        ]) + "\n"

        with tempfile.TemporaryDirectory() as tmpdir:
            sj = Path(tmpdir) / "test.SJ.out.tab"
            sj.write_text(content, encoding="utf-8")
            with patch("main._get_browse_db", side_effect=HTTPException(status_code=404, detail="no db")):
                payload = asyncio.run(
                    browse_splice_junctions(
                        path=str(sj),
                        chrom="chr1",
                        start=1,
                        end=1000,
                        min_support=3,
                        canonical_mode="canonical",
                        annotated_mode="annotated",
                        level="fine",
                    )
                )

        junctions = payload.get("junctions") or []
        self.assertEqual(len(junctions), 1)
        self.assertTrue(junctions[0]["canonical"])
        self.assertTrue(junctions[0]["annotated"])
        self.assertGreaterEqual(junctions[0]["n_total"], 3)
        applied = payload.get("applied_filters") or {}
        self.assertEqual(applied.get("canonical_mode"), "canonical")
        self.assertEqual(applied.get("annotated_mode"), "annotated")
        self.assertEqual(applied.get("min_support"), 3)

    def test_splice_annotation_uses_loaded_transcript_boundaries(self):
        content = "\n".join([
            # chrom start end strand motif annotated unique multi overhang
            "chr1\t100\t200\t1\t1\t0\t10\t0\t50",  # STAR says novel, but matches transcript intron
            "chr1\t220\t300\t1\t1\t1\t10\t0\t50",  # STAR says annotated, but not in transcript model
        ]) + "\n"

        with tempfile.TemporaryDirectory() as tmpdir:
            sj = Path(tmpdir) / "test.SJ.out.tab"
            sj.write_text(content, encoding="utf-8")

            db = Path(tmpdir) / "browse.sqlite"
            conn = sqlite3.connect(db)
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
            tx_payload = {
                "exons": [
                    {"start": 51, "end": 99, "feature_type": "exon", "strand": "+"},
                    {"start": 201, "end": 260, "feature_type": "exon", "strand": "+"},
                ]
            }
            conn.execute(
                "INSERT INTO transcripts (id, chrom, start, end, strand, parent_gene_id, is_canonical, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("tx1", "chr1", 51, 260, "+", "gene1", 1, json.dumps(tx_payload)),
            )
            conn.commit()
            conn.close()

            with patch("main._get_browse_db", return_value=str(db)):
                payload = asyncio.run(
                    browse_splice_junctions(
                        path=str(sj),
                        chrom="chr1",
                        start=1,
                        end=1000,
                        genome="reference",
                        annotated_mode="all",
                        level="fine",
                    )
                )

        junctions = payload.get("junctions") or []
        self.assertEqual(len(junctions), 2)
        by_bounds = {(j["start"], j["end"]): j for j in junctions}
        self.assertTrue(by_bounds[(100, 200)]["annotated"])
        self.assertFalse(by_bounds[(220, 300)]["annotated"])
        self.assertFalse(by_bounds[(100, 200)]["star_annotated"])
        self.assertTrue(by_bounds[(220, 300)]["star_annotated"])

    def test_splice_block_tiles_aggregate_junction_spans(self):
        content = "\n".join([
            # chrom start end strand motif annotated unique multi overhang
            "chr1\t100\t200\t1\t1\t1\t3\t0\t50",
            "chr1\t150\t260\t1\t1\t1\t8\t0\t50",
            "chr1\t500\t900\t1\t1\t1\t5\t0\t50",
        ]) + "\n"

        with tempfile.TemporaryDirectory() as tmpdir:
            sj = Path(tmpdir) / "test.SJ.out.tab"
            sj.write_text(content, encoding="utf-8")
            with patch("main._get_browse_db", side_effect=HTTPException(status_code=404, detail="no db")):
                payload = asyncio.run(
                    browse_splice_junctions_block_tiles(
                        SpliceBlockTilesRequest(
                            path=str(sj),
                            chrom="chr1",
                            genome="reference",
                            tiles=[SpliceBlockTileRequest(start=0, end=1000, level_id="L0", block_bp=100)],
                        )
                    )
                )

        tiles = payload.get("tiles") or []
        self.assertEqual(len(tiles), 1)
        spans = tiles[0].get("block_spans") or []
        self.assertEqual(len(spans), 2)
        self.assertEqual((spans[0]["start"], spans[0]["end"]), (100, 300))
        self.assertEqual((spans[1]["start"], spans[1]["end"]), (500, 900))
        self.assertEqual(int(spans[0]["max_support"]), 8)
        self.assertEqual(int(spans[1]["max_support"]), 5)

    def test_splice_block_tiles_respect_filters(self):
        content = "\n".join([
            # canonical
            "chr1\t100\t200\t1\t1\t1\t8\t0\t50",
            # non-canonical
            "chr1\t220\t300\t1\t0\t1\t9\t0\t50",
        ]) + "\n"

        with tempfile.TemporaryDirectory() as tmpdir:
            sj = Path(tmpdir) / "test.SJ.out.tab"
            sj.write_text(content, encoding="utf-8")
            with patch("main._get_browse_db", side_effect=HTTPException(status_code=404, detail="no db")):
                payload = asyncio.run(
                    browse_splice_junctions_block_tiles(
                        SpliceBlockTilesRequest(
                            path=str(sj),
                            chrom="chr1",
                            genome="reference",
                            canonical_mode="canonical",
                            tiles=[SpliceBlockTileRequest(start=0, end=400, level_id="L0", block_bp=100)],
                        )
                    )
                )

        spans = (payload.get("tiles") or [{}])[0].get("block_spans") or []
        self.assertEqual(len(spans), 1)
        self.assertEqual((spans[0]["start"], spans[0]["end"]), (100, 200))


if __name__ == "__main__":
    unittest.main()

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    BigBedBlockTileRequest,
    BigBedBlockTilesRequest,
    BigBedFeatureTileRequest,
    BigBedFeatureTilesRequest,
    browse_bigbed_block_tiles,
    browse_bigbed_feature_tiles,
)


class _FakeBigBed:
    def chroms(self):
        return {"chr1": 1_000_000}

    def SQL(self):
        return b"""
table fakeBed
"fake"
(
  string chrom;
  uint chromStart;
  uint chromEnd;
  string name;
  uint score;
  char[1] strand;
  uint thickStart;
  uint thickEnd;
  uint reserved;
  int blockCount;
  int[blockCount] blockSizes;
  int[blockCount] blockStarts;
)
"""

    def entries(self, chrom, start, end):
        if chrom != "chr1":
            return []
        base = [
            (100, 180, "peakA\t42\t+\t100\t180\t255,0,0\t1\t80\t0\tsourceA"),
            (220, 260, "peakB\t7\t-\t220\t260\t0,128,255\t1\t40\t0\tsourceB"),
        ]
        out = []
        for row in base:
            if row[1] <= start or row[0] >= end:
                continue
            out.append(row)
        return out

    def close(self):
        return None


class _FakeBigBedBed12ChromStarts:
    def chroms(self):
        return {"chr1": 1_000_000}

    def SQL(self):
        return b"""
table fakeBed
"fake"
(
  string chrom;
  uint chromStart;
  uint chromEnd;
  string name;
  uint score;
  char[1] strand;
  uint thickStart;
  uint thickEnd;
  uint reserved;
  int blockCount;
  int[blockCount] blockSizes;
  int[blockCount] chromStarts;
  string prediction;
)
"""

    def entries(self, chrom, start, end):
        if chrom != "chr1":
            return []
        rows = [
            (100, 260, "txA\t77\t+\t120\t230\t255,0,0\t3\t20,30,40\t0,60,120\tPRINCIPAL:1"),
            (300, 460, "txBroken\t10\t+\t320\t420\t10,20,30\t3\t20,30\t0,60,120\tALTERNATIVE"),
        ]
        out = []
        for row in rows:
            if row[1] <= start or row[0] >= end:
                continue
            out.append(row)
        return out

    def close(self):
        return None


class BigBedTileEndpointTests(unittest.TestCase):
    def test_block_tiles_return_spans(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bb_path = Path(tmpdir) / "tile_test.bb"
            bb_path.write_bytes(b"BB")
            fake_module = SimpleNamespace(open=lambda _path: _FakeBigBed())

            with patch("main.pyBigWig", fake_module):
                payload = BigBedBlockTilesRequest(
                    path=str(bb_path),
                    chrom="1",
                    genome="reference",
                    tiles=[BigBedBlockTileRequest(start=0, end=500, level_id="L2", block_bp=100)],
                )
                out = asyncio.run(browse_bigbed_block_tiles(payload))

        self.assertEqual(out["chrom"], "chr1")
        self.assertEqual(len(out["tiles"]), 1)
        tile = out["tiles"][0]
        self.assertTrue(tile["has_data"])
        self.assertGreater(len(tile["block_spans"]), 0)
        self.assertIn("max_score", tile["block_spans"][0])

    def test_feature_tiles_return_parsed_fields(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bb_path = Path(tmpdir) / "tile_test.bb"
            bb_path.write_bytes(b"BB")
            fake_module = SimpleNamespace(open=lambda _path: _FakeBigBed())

            with patch("main.pyBigWig", fake_module):
                payload = BigBedFeatureTilesRequest(
                    path=str(bb_path),
                    chrom="chr1",
                    genome="reference",
                    max_features_per_tile=3000,
                    tiles=[BigBedFeatureTileRequest(start=0, end=500, level_id="detail", max_features=3000)],
                )
                out = asyncio.run(browse_bigbed_feature_tiles(payload))

        self.assertEqual(out["chrom"], "chr1")
        self.assertEqual(len(out["tiles"]), 1)
        tile = out["tiles"][0]
        self.assertTrue(tile["has_data"])
        self.assertFalse(tile["truncated"])
        self.assertEqual(len(tile["features"]), 2)
        first = tile["features"][0]
        self.assertEqual(first["name"], "peakA")
        self.assertEqual(first["itemRgb"], "255,0,0")
        self.assertEqual(first["thick_start"], 100)
        self.assertEqual(first["thick_end"], 180)
        self.assertEqual(first["extra_fields"], ["sourceA"])

    def test_feature_tiles_extracts_transcript_blocks_and_cds_from_sql_aliases(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bb_path = Path(tmpdir) / "tile_test.bb"
            bb_path.write_bytes(b"BB")
            fake_module = SimpleNamespace(open=lambda _path: _FakeBigBedBed12ChromStarts())

            with patch("main.pyBigWig", fake_module):
                payload = BigBedFeatureTilesRequest(
                    path=str(bb_path),
                    chrom="chr1",
                    genome="reference",
                    max_features_per_tile=3000,
                    tiles=[BigBedFeatureTileRequest(start=0, end=500, level_id="detail", max_features=3000)],
                )
                out = asyncio.run(browse_bigbed_feature_tiles(payload))

        tile = out["tiles"][0]
        self.assertEqual(len(tile["features"]), 2)
        tx = next((f for f in tile["features"] if f.get("name") == "txA"), None)
        self.assertIsNotNone(tx)
        self.assertEqual(tx["render_kind"], "transcript")
        self.assertTrue(tx["structure_valid"])
        self.assertEqual(tx["exon_blocks"], [
            {"start": 100, "end": 120},
            {"start": 160, "end": 190},
            {"start": 220, "end": 260},
        ])
        self.assertEqual(tx["cds_blocks"], [
            {"start": 160, "end": 190},
            {"start": 220, "end": 230},
        ])

    def test_invalid_block_lists_fall_back_to_interval_render_kind(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bb_path = Path(tmpdir) / "tile_test.bb"
            bb_path.write_bytes(b"BB")
            fake_module = SimpleNamespace(open=lambda _path: _FakeBigBedBed12ChromStarts())

            with patch("main.pyBigWig", fake_module):
                payload = BigBedFeatureTilesRequest(
                    path=str(bb_path),
                    chrom="chr1",
                    genome="reference",
                    max_features_per_tile=3000,
                    tiles=[BigBedFeatureTileRequest(start=250, end=520, level_id="detail", max_features=3000)],
                )
                out = asyncio.run(browse_bigbed_feature_tiles(payload))

        tile = out["tiles"][0]
        broken = next((f for f in tile["features"] if f.get("name") == "txBroken"), None)
        self.assertIsNotNone(broken)
        self.assertEqual(broken["render_kind"], "interval")
        self.assertFalse(broken["structure_valid"])
        self.assertEqual(broken["exon_blocks"], [])


if __name__ == "__main__":
    unittest.main()

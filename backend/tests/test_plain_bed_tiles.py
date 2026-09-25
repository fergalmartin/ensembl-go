import asyncio
import gzip
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bed_index import PlainBedIndex, get_plain_bed_index  # noqa: E402
from main import (  # noqa: E402
    BigBedBlockTileRequest,
    BigBedBlockTilesRequest,
    BigBedFeatureTileRequest,
    BigBedFeatureTilesRequest,
    _normalize_bed_settings,
    browse_bed,
    browse_bigbed_block_tiles,
    browse_bigbed_feature_tiles,
)

BED_ROWS = [
    "track name=peaks",
    "# a comment",
    "1\t300\t400\tpeak_c\t500\t-",
    "1\t100\t180\tpeak_a\t1000\t+",
    "1\t150\t5000\tlong_d\t10\t.",  # long feature starting early, reaching far
    "1\t220\t260\tpeak_b\t7\t.",
    "2\t10\t20\tpeak_e\t1\t.",
]


class PlainBedTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "peaks.bed"
        self.path.write_text("\n".join(BED_ROWS) + "\n")

    def tearDown(self):
        self.tmp.cleanup()


class PlainBedIndexTests(PlainBedTestCase):
    def test_entries_are_sorted_and_find_long_features_starting_before_the_window(self):
        index = PlainBedIndex(self.path)
        self.assertEqual(index.feature_count, 5)
        rows = index.entries("1", 1000, 1100)
        # Only the long feature reaches this far; it starts well before the window.
        self.assertEqual([(s, e) for s, e, _ in rows], [(150, 5000)])
        rows = index.entries("1", 0, 250)
        self.assertEqual([(s, e) for s, e, _ in rows], [(100, 180), (150, 5000), (220, 260)])
        self.assertEqual(rows[0][2], "peak_a\t1000\t+")

    def test_half_open_boundaries(self):
        index = PlainBedIndex(self.path)
        self.assertEqual(index.entries("1", 180, 220), [(150, 5000, "long_d\t10\t.")])
        self.assertEqual(index.entries("2", 20, 30), [])
        self.assertEqual(index.entries("missing", 0, 10), [])

    def test_gzip_and_space_separated_input(self):
        gz = Path(self.tmp.name) / "peaks.bed.gz"
        with gzip.open(gz, "wt") as fh:
            fh.write("chrX 5 9 spaced\n")
        index = PlainBedIndex(gz)
        self.assertEqual(index.entries("chrX", 0, 100), [(5, 9, "spaced")])

    def test_cache_rebuilds_when_the_file_changes(self):
        first = get_plain_bed_index(self.path)
        self.assertIs(get_plain_bed_index(self.path), first)
        self.path.write_text("1\t1\t2\tonly\n")
        future = time.time() + 5
        os.utime(self.path, (future, future))
        second = get_plain_bed_index(self.path)
        self.assertIsNot(second, first)
        self.assertEqual(second.feature_count, 1)


class PlainBedEndpointTests(PlainBedTestCase):
    def test_block_tiles_serve_plain_bed_with_counts(self):
        payload = BigBedBlockTilesRequest(
            path=str(self.path),
            chrom="1",
            include_counts=True,
            tiles=[BigBedBlockTileRequest(start=0, end=1000, level_id="L3", block_bp=100)],
        )
        result = asyncio.run(browse_bigbed_block_tiles(payload))
        tile = result["tiles"][0]
        self.assertEqual(result["resolved_chrom"], "1")
        # BED has no chromosome length, so the tile is not clipped to the last feature.
        self.assertEqual((tile["start"], tile["end"]), (0, 1000))
        self.assertTrue(tile["has_data"])
        self.assertEqual(tile["counts"], [0, 2, 2, 2, 1, 1, 1, 1, 1, 1])

    def test_block_tiles_omit_counts_unless_asked(self):
        payload = BigBedBlockTilesRequest(
            path=str(self.path),
            chrom="1",
            tiles=[BigBedBlockTileRequest(start=0, end=1000, level_id="L3", block_bp=100)],
        )
        tile = asyncio.run(browse_bigbed_block_tiles(payload))["tiles"][0]
        self.assertNotIn("counts", tile)

    def test_feature_tiles_serve_plain_bed_with_parsed_columns(self):
        payload = BigBedFeatureTilesRequest(
            path=str(self.path),
            chrom="1",
            tiles=[BigBedFeatureTileRequest(start=0, end=250)],
        )
        features = asyncio.run(browse_bigbed_feature_tiles(payload))["tiles"][0]["features"]
        self.assertEqual([f["name"] for f in features], ["peak_a", "long_d", "peak_b"])
        self.assertEqual(features[0]["score"], "1000")
        self.assertEqual(features[0]["strand"], "+")
        self.assertEqual(features[0]["render_kind"], "interval")

    def test_unknown_chromosome_returns_empty_tiles(self):
        payload = BigBedBlockTilesRequest(
            path=str(self.path),
            chrom="nope",
            tiles=[BigBedBlockTileRequest(start=0, end=1000, level_id="L3", block_bp=100)],
        )
        result = asyncio.run(browse_bigbed_block_tiles(payload))
        self.assertIsNone(result["resolved_chrom"])
        self.assertFalse(result["tiles"][0]["has_data"])

    def test_legacy_bed_endpoint_uses_the_index(self):
        result = asyncio.run(browse_bed(path=str(self.path), chrom="1", start=200, end=320))
        self.assertEqual([iv["name"] for iv in result["intervals"]], ["long_d", "peak_b", "peak_c"])


class BedSettingsTests(unittest.TestCase):
    def test_colour_is_normalised_and_empty_means_automatic(self):
        self.assertEqual(_normalize_bed_settings(None), {"color": ""})
        self.assertEqual(_normalize_bed_settings({"color": "#AABBCC"}), {"color": "#aabbcc"})
        self.assertEqual(_normalize_bed_settings({"color": "red"}), {"color": ""})
        self.assertEqual(_normalize_bed_settings({}, previous={"color": "#112233"}), {"color": "#112233"})
        self.assertEqual(_normalize_bed_settings({"color": ""}, previous={"color": "#112233"}), {"color": ""})


if __name__ == "__main__":
    unittest.main()

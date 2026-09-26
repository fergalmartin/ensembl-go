import asyncio
import gzip
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bed_index import PlainBedIndex, _split_gff_line, get_plain_bed_index, is_gff_path  # noqa: E402
from main import (  # noqa: E402
    BigBedBlockTileRequest,
    BigBedBlockTilesRequest,
    BigBedFeatureTileRequest,
    BigBedFeatureTilesRequest,
    TRACK_DISPLAY_MODES,
    _detect_track_type,
    browse_bigbed_block_tiles,
    browse_bigbed_feature_tiles,
)

GFF3 = "\n".join([
    "##gff-version 3",
    "1\tEnsembl\tenhancer\t21301\t22141\t.\t.\t.\tID=ENSSSCR1_B55;color=#f8c041",
    "1\tEnsembl\tpromoter\t22142\t22642\t7.5\t+\t.\tID=ENSSSCR1_98G;Name=P%3B1;color=217,0,0",
    "1\tRepeatMasker\trepeat_region\t500\t400\t.\t-\t.\t.",
    "##FASTA",
    ">1",
    "ACGT",
]) + "\n"

GTF = "\n".join([
    '2\thavana\texon\t100\t200\t.\t+\t0\tgene_id "G1"; transcript_id "T1"; gene_name "ABC";',
    '2\thavana\tCDS\t150\t200\t.\t+\t2\tgene_id "G1"; transcript_id "T1";',
]) + "\n"


class GffParsingTests(unittest.TestCase):
    def test_gff3_line_becomes_a_zero_based_named_coloured_row(self):
        chrom, start, end, rest = _split_gff_line(GFF3.splitlines()[1])
        self.assertEqual((chrom, start, end), ("1", 21300, 22141))
        name, score, strand, rgb, ftype, source, phase, attrs = rest.split("\t")
        self.assertEqual((name, score, strand, rgb, ftype, source, phase), ("ENSSSCR1_B55", "", ".", "248,192,65", "enhancer", "Ensembl", ""))
        self.assertEqual(attrs, "ID=ENSSSCR1_B55;color=#f8c041")

    def test_name_prefers_name_and_decodes_it_and_rgb_colours_pass_through(self):
        _, _, _, rest = _split_gff_line(GFF3.splitlines()[2])
        cols = rest.split("\t")
        self.assertEqual(cols[:4], ["P;1", "7.5", "+", "217,0,0"])

    def test_featureless_lines_fall_back_to_type_and_reversed_coordinates_are_ordered(self):
        chrom, start, end, rest = _split_gff_line(GFF3.splitlines()[3])
        self.assertEqual((start, end), (399, 500))
        self.assertEqual(rest.split("\t")[0], "repeat_region")

    def test_gtf_attributes(self):
        _, start, end, rest = _split_gff_line(GTF.splitlines()[0])
        self.assertEqual((start, end), (99, 200))
        cols = rest.split("\t")
        self.assertEqual(cols[0], "ABC")
        self.assertEqual(cols[6], "0")
        _, _, _, rest = _split_gff_line(GTF.splitlines()[1])
        self.assertEqual(rest.split("\t")[0], "T1")

    def test_detection(self):
        for name in ("a.gff", "a.gff3", "a.gtf", "a.GFF.gz", "a.gff3.gz", "a.gtf.gz"):
            self.assertTrue(is_gff_path(Path(name)), name)
            self.assertEqual(_detect_track_type(name), "gff", name)
        self.assertFalse(is_gff_path(Path("a.bed")))
        self.assertEqual(TRACK_DISPLAY_MODES["gff"], ["intervals", "transcripts", "density"])


class GffEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.gff = Path(self.tmp.name) / "reg.gff.gz"
        with gzip.open(self.gff, "wt") as fh:
            fh.write(GFF3)

    def tearDown(self):
        self.tmp.cleanup()

    def test_index_stops_at_fasta_and_sorts(self):
        index = PlainBedIndex(self.gff)
        self.assertEqual(index.feature_count, 3)
        self.assertEqual([s for s, _, _ in index.entries("1", 0, 30000)], [399, 21300, 22141])
        self.assertIsNotNone(get_plain_bed_index(self.gff).SQL())

    def test_feature_tiles_name_the_gff_columns(self):
        payload = BigBedFeatureTilesRequest(path=str(self.gff), chrom="1", tiles=[BigBedFeatureTileRequest(start=20000, end=30000)])
        features = asyncio.run(browse_bigbed_feature_tiles(payload))["tiles"][0]["features"]
        promoter = next(f for f in features if f["name"] == "P;1")
        self.assertEqual(promoter["itemRgb"], "217,0,0")
        self.assertEqual(promoter["strand"], "+")
        self.assertEqual(promoter["extra_field_names"], ["Type", "Source", "Attributes"])
        self.assertEqual(promoter["extra_fields"][:2], ["promoter", "Ensembl"])
        enhancer = next(f for f in features if f["name"] == "ENSSSCR1_B55")
        self.assertFalse(enhancer["has_score"])

    def test_block_tiles_carry_colour_and_counts(self):
        payload = BigBedBlockTilesRequest(
            path=str(self.gff), chrom="1", include_counts=True,
            tiles=[BigBedBlockTileRequest(start=0, end=30000, level_id="B3", block_bp=1000)],
        )
        tile = asyncio.run(browse_bigbed_block_tiles(payload))["tiles"][0]
        self.assertTrue(tile["has_data"])
        self.assertEqual(sum(1 for c in tile["counts"] if c), 3)
        self.assertIn("248,192,65", {span["color_hint"] for span in tile["block_spans"]})


if __name__ == "__main__":
    unittest.main()

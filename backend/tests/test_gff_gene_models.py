import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bed_index import build_gene_model_rows, looks_like_gene_models  # noqa: E402
from main import BigBedFeatureTileRequest, BigBedFeatureTilesRequest, browse_bigbed_feature_tiles  # noqa: E402

# 1-based, inclusive, as GFF writes them.
GFF3 = "\n".join([
    "##gff-version 3",
    "1\tensembl\tregion\t1\t100000\t.\t.\t.\tID=region:1",
    "1\tensembl\tgene\t101\t400\t.\t+\t.\tID=gene:G1;Name=ABC;biotype=protein_coding;gene_id=G1",
    "1\tensembl\tmRNA\t101\t400\t.\t+\t.\tID=transcript:T1;Parent=gene:G1;Name=ABC-201;biotype=protein_coding;transcript_id=T1",
    "1\tensembl\texon\t101\t200\t.\t+\t.\tParent=transcript:T1",
    "1\tensembl\tfive_prime_UTR\t101\t149\t.\t+\t.\tParent=transcript:T1",
    "1\tensembl\tCDS\t150\t200\t.\t+\t0\tParent=transcript:T1",
    "1\tensembl\texon\t301\t400\t.\t+\t.\tParent=transcript:T1",
    "1\tensembl\tCDS\t301\t350\t.\t+\t0\tParent=transcript:T1",
    # A second transcript given only as CDS + UTR, no exon lines.
    "1\tensembl\tmRNA\t101\t350\t.\t+\t.\tID=transcript:T2;Parent=gene:G1;transcript_id=T2",
    "1\tensembl\tfive_prime_UTR\t101\t149\t.\t+\t.\tParent=transcript:T2",
    "1\tensembl\tCDS\t150\t200\t.\t+\t0\tParent=transcript:T2",
    "1\tensembl\tCDS\t301\t350\t.\t+\t0\tParent=transcript:T2",
    # A gene with no transcripts, and a feature that is nobody's parent.
    "1\tensembl\tgene\t5001\t6000\t.\t-\t.\tID=gene:G2;Name=LONELY",
    "1\trepeatmasker\trepeat_region\t7001\t7100\t.\t.\t.\tName=AluY",
]) + "\n"

GTF = "\n".join([
    '2\thavana\tgene\t1000\t2000\t.\t-\t.\tgene_id "G9"; gene_name "XYZ"; gene_biotype "lncRNA";',
    '2\thavana\ttranscript\t1000\t2000\t.\t-\t.\tgene_id "G9"; transcript_id "T9"; gene_name "XYZ"; transcript_name "XYZ-201";',
    '2\thavana\texon\t1000\t1100\t.\t-\t.\tgene_id "G9"; transcript_id "T9";',
    '2\thavana\texon\t1901\t2000\t.\t-\t.\tgene_id "G9"; transcript_id "T9";',
]) + "\n"


def _rows(text, suffix):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f"models{suffix}"
        path.write_text(text)
        return build_gene_model_rows(path), looks_like_gene_models(path)


def _fields(rest):
    return rest.split("\t")


class GeneModelTests(unittest.TestCase):
    def test_gff3_transcripts_become_bed12_rows_and_the_rest_stay_intervals(self):
        rows, looks = _rows(GFF3, ".gff3")
        self.assertTrue(looks)
        by_name = {_fields(r[2])[0]: r for r in rows["1"]}
        # Two transcripts (the unnamed one takes its gene's name), the lonely gene and
        # the repeat; the drawn gene, its mRNA lines and the whole-chromosome region are
        # not rows of their own.
        self.assertEqual(sorted(by_name), ["ABC", "ABC-201", "AluY", "LONELY"])

        start, end, rest = by_name["ABC-201"]
        f = _fields(rest)
        self.assertEqual((start, end), (100, 400))
        self.assertEqual(f[2:9], ["+", "149", "350", "", "2", "100,100,", "0,200,"])
        self.assertEqual(f[9:14], ["ABC", "G1", "T1", "protein_coding", "mRNA"])

        # No exon lines: its exons are its CDS and UTRs, merged where they touch.
        start, end, rest = by_name["ABC"]
        f = _fields(rest)
        self.assertEqual((start, end), (100, 350))
        self.assertEqual(f[6:9], ["2", "100,50,", "0,200,"])

        self.assertEqual(_fields(by_name["LONELY"][2])[6], "")  # plain interval, no blocks

    def test_gtf_transcripts_and_their_gene_line_is_not_drawn_twice(self):
        rows, looks = _rows(GTF, ".gtf")
        self.assertTrue(looks)
        self.assertEqual(len(rows["2"]), 1)
        start, end, rest = rows["2"][0]
        f = _fields(rest)
        self.assertEqual((start, end), (999, 2000))
        self.assertEqual(f[0], "XYZ-201")
        self.assertEqual(f[2:9], ["-", "999", "999", "", "2", "101,100,", "0,901,"])
        self.assertEqual(f[9:13], ["XYZ", "G9", "T9", "lncRNA"])

    def test_flat_feature_files_are_not_gene_models(self):
        text = "1\tEnsembl\tenhancer\t10\t20\t.\t.\t.\tID=E1\n" * 5
        _, looks = _rows(text, ".gff")
        self.assertFalse(looks)

    def test_endpoint_serves_transcript_structures(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "models.gff3"
            path.write_text(GFF3)
            payload = BigBedFeatureTilesRequest(
                path=str(path), chrom="1", feature_model="transcripts",
                tiles=[BigBedFeatureTileRequest(start=0, end=1000)],
            )
            features = asyncio.run(browse_bigbed_feature_tiles(payload))["tiles"][0]["features"]
            tx = next(f for f in features if f["name"] == "ABC-201")
            self.assertEqual(tx["render_kind"], "transcript")
            self.assertEqual(tx["exon_blocks"], [{"start": 100, "end": 200}, {"start": 300, "end": 400}])
            self.assertEqual(tx["cds_blocks"], [{"start": 149, "end": 200}, {"start": 300, "end": 350}])
            self.assertEqual(dict(zip(tx["extra_field_names"], tx["extra_fields"]))["Biotype"], "protein_coding")
            # The same file without the model is one interval per line.
            payload.feature_model = ""
            flat = asyncio.run(browse_bigbed_feature_tiles(payload))["tiles"][0]["features"]
            self.assertTrue(all(f["render_kind"] == "interval" for f in flat))
            self.assertGreater(len(flat), len(features))


if __name__ == "__main__":
    unittest.main()

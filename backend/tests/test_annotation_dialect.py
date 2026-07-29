import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from annotation.dialect import (  # noqa: E402
    BARE_ATTRIBUTE_KEY,
    GFF2,
    GFF3,
    GTF,
    attr_first,
    attr_get,
    attr_list,
    iter_data_lines,
    parse_attributes,
    sniff_annotation,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"


class ParseAttributesTests(unittest.TestCase):
    def test_gff3_pairs_are_percent_decoded(self):
        attrs = parse_attributes("ID=gene1;Name=my%20gene;Note=a%3Bb", GFF3)
        self.assertEqual(attrs["ID"], "gene1")
        self.assertEqual(attrs["Name"], "my gene")
        self.assertEqual(attrs["Note"], "a;b")

    def test_gtf_quoted_pairs(self):
        attrs = parse_attributes('gene_id "STRG.1"; transcript_id "STRG.1.1"; cov "5.0";', GTF)
        self.assertEqual(attrs["gene_id"], "STRG.1")
        self.assertEqual(attrs["transcript_id"], "STRG.1.1")
        self.assertEqual(attrs["cov"], "5.0")

    def test_gtf_unquoted_values(self):
        attrs = parse_attributes("gene_id g1; transcript_id g1.t1;", GTF)
        self.assertEqual(attrs["gene_id"], "g1")
        self.assertEqual(attrs["transcript_id"], "g1.t1")

    def test_semicolon_inside_quotes_is_not_a_separator(self):
        attrs = parse_attributes('gene_id "a;b"; transcript_id "t1";', GTF)
        self.assertEqual(attrs["gene_id"], "a;b")
        self.assertEqual(attrs["transcript_id"], "t1")

    def test_bare_token_column(self):
        attrs = parse_attributes("g1.t1", GTF)
        self.assertEqual(attrs, {BARE_ATTRIBUTE_KEY: "g1.t1"})

    def test_column_shape_wins_over_declared_dialect(self):
        # An AUGUSTUS file is sniffed as GTF but its child rows are still quoted
        # pairs and its gene rows are bare; both must parse regardless.
        self.assertEqual(parse_attributes("ID=g1;Parent=x", GTF)["Parent"], "x")
        self.assertEqual(parse_attributes("g1", GFF3), {BARE_ATTRIBUTE_KEY: "g1"})

    def test_empty_and_dot_columns(self):
        self.assertEqual(parse_attributes("", GFF3), {})
        self.assertEqual(parse_attributes(".", GFF3), {})

    def test_value_containing_equals_is_kept_whole(self):
        attrs = parse_attributes("ID=g1;Note=x=y", GFF3)
        self.assertEqual(attrs["Note"], "x=y")


class AttributeAccessorTests(unittest.TestCase):
    def test_attr_get_is_case_insensitive_fallback(self):
        self.assertEqual(attr_get({"id": "g1"}, "ID"), "g1")
        self.assertEqual(attr_get({"ID": "g1"}, "ID"), "g1")

    def test_attr_get_prefers_exact_match_order(self):
        attrs = {"biotype": "lncRNA", "gene_biotype": "protein_coding"}
        self.assertEqual(attr_get(attrs, "biotype", "gene_biotype"), "lncRNA")

    def test_attr_list_splits_multi_values(self):
        self.assertEqual(attr_list({"Parent": "a,b , c"}, "Parent"), ["a", "b", "c"])
        self.assertEqual(attr_first({"Parent": "a,b"}, "Parent"), "a")
        self.assertEqual(attr_list({}, "Parent"), [])


class IterDataLinesTests(unittest.TestCase):
    def _write(self, text):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".gff3", delete=False)
        tmp.write(text)
        tmp.close()
        self.addCleanup(lambda: Path(tmp.name).unlink(missing_ok=True))
        return tmp.name

    def test_stops_at_fasta_directive(self):
        path = self._write(
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t1\t9\t.\t+\t.\tID=g1\n"
            "##FASTA\n"
            ">chr1\n"
            "ACGTACGTAC\n"
        )
        rows = list(iter_data_lines(path))
        self.assertEqual(len(rows), 1)
        self.assertIn("ID=g1", rows[0][1])

    def test_skips_comments_and_blank_lines(self):
        path = self._write(
            "# comment\n\n##pragma\nchr1\tsrc\tgene\t1\t9\t.\t+\t.\tID=g1\n\n"
        )
        rows = list(iter_data_lines(path))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], 4)

    def test_crlf_line_endings_are_stripped(self):
        path = self._write("##gff-version 3\r\nchr1\tsrc\tgene\t1\t9\t.\t+\t.\tID=g1\r\n")
        rows = list(iter_data_lines(path))
        self.assertTrue(rows[0][1].endswith("ID=g1"))


class SniffTests(unittest.TestCase):
    def test_stringtie_is_gtf(self):
        info = sniff_annotation(str(FIXTURES / "stringtie.gtf"))
        self.assertEqual(info.dialect, GTF)
        self.assertEqual(info.producer_guess, "StringTie")
        self.assertEqual(info.compression, "none")

    def test_scallop_is_gtf(self):
        info = sniff_annotation(str(FIXTURES / "scallop.gtf"))
        self.assertEqual(info.dialect, GTF)
        self.assertEqual(info.producer_guess, "Scallop")

    def test_braker_bare_tokens_are_gtf(self):
        info = sniff_annotation(str(FIXTURES / "braker.gtf"))
        self.assertEqual(info.dialect, GTF)
        self.assertGreater(info.bare_lines, 0)
        self.assertEqual(info.producer_guess, "AUGUSTUS")

    def test_gff3_pragma_wins(self):
        info = sniff_annotation(str(FIXTURES / "ensembl.gff3"))
        self.assertEqual(info.dialect, GFF3)
        self.assertEqual(info.gff_version, "3")
        self.assertEqual(info.producer_guess, "Ensembl")

    def test_helixer_and_gnomon_are_recognised(self):
        self.assertEqual(
            sniff_annotation(str(FIXTURES / "helixer.gff3")).producer_guess, "Helixer"
        )
        self.assertEqual(
            sniff_annotation(str(FIXTURES / "egapx.gff3")).producer_guess, "NCBI Gnomon"
        )

    def test_feature_types_are_collected(self):
        info = sniff_annotation(str(FIXTURES / "refseq.gff3"))
        self.assertIn("gene", info.feature_types)
        self.assertIn("CDS", info.feature_types)


if __name__ == "__main__":
    unittest.main()

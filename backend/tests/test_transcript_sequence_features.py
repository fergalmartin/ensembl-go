import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    _available_feature_types,
    _build_fasta_header,
    _canonical_info_for_header,
    _split_fasta_record,
)

HEADER_FIELDS = {
    "exon_number": True, "location": True, "strand": True,
    "length": True, "biotype": True, "canonical_status": True,
}


class AvailableFeatureTypesTests(unittest.TestCase):
    # Two exons with the CDS starting inside the first and ending inside the
    # second, so both UTRs have to be inferred rather than read off.
    CODING_EXONS = [{"start": 100, "end": 200}, {"start": 400, "end": 500}]
    CODING_CDS = [{"start": 150, "end": 200}, {"start": 400, "end": 450}]

    def test_coding_transcript_offers_everything(self):
        available = _available_feature_types(
            self.CODING_EXONS, self.CODING_CDS, [], "+", True
        )
        self.assertTrue(all(available.values()), available)

    def test_non_coding_transcript_offers_no_cds_protein_or_utrs(self):
        available = _available_feature_types(self.CODING_EXONS, [], [], "+", True)
        self.assertEqual(available, {
            "genomic": True,
            "transcript": True,
            "cds": False,
            "protein": False,
            "utr5": False,
            "utr3": False,
            "utr": False,
            "exons": True,
            "introns": True,
        })

    def test_the_two_utr_ends_collapse_into_one_offered_entry(self):
        # Either end alone is enough for the viewer's single "UTR" entry.
        available = _available_feature_types(
            [{"start": 100, "end": 300}], [{"start": 150, "end": 300}], [], "+", True
        )
        self.assertEqual(
            (available["utr5"], available["utr3"], available["utr"]),
            (True, False, True),
        )

    def test_protein_tracks_cds(self):
        without = _available_feature_types(self.CODING_EXONS, [], [], "+", True)
        with_cds = _available_feature_types(self.CODING_EXONS, self.CODING_CDS, [], "+", True)
        self.assertFalse(without["protein"])
        self.assertTrue(with_cds["protein"])

    def test_single_exon_transcript_has_no_introns(self):
        available = _available_feature_types([{"start": 1, "end": 90}], [], [], "+", True)
        self.assertTrue(available["exons"])
        self.assertFalse(available["introns"])

    def test_utr_sides_swap_on_the_reverse_strand(self):
        # Exon overhang below the CDS is the 5' end reading forward and the 3'
        # end reading back.
        exons = [{"start": 100, "end": 300}]
        cds = [{"start": 150, "end": 300}]
        forward = _available_feature_types(exons, cds, [], "+", True)
        reverse = _available_feature_types(exons, cds, [], "-", True)
        self.assertEqual((forward["utr5"], forward["utr3"]), (True, False))
        self.assertEqual((reverse["utr5"], reverse["utr3"]), (False, True))

    def test_explicit_utr_annotation_is_honoured(self):
        available = _available_feature_types(
            [{"start": 1, "end": 90}], [],
            [{"feature_type": "five_prime_UTR", "start": 1, "end": 20}],
            "+", True,
        )
        self.assertTrue(available["utr5"])
        self.assertFalse(available["utr3"])


class FastaHeaderTests(unittest.TestCase):
    def test_rank_is_a_field_rather_than_a_suffix(self):
        header = _build_fasta_header(
            "TX1", "GENE1", "exon", "13", 100, 200, "+", 101,
            HEADER_FIELDS, "protein_coding", "canonical", rank=3,
        )
        self.assertIn("feature=exon", header)
        self.assertIn("exon_rank:3", header)
        # The feature name itself stays greppable.
        self.assertNotIn("feature=exon_3", header)

    def test_rank_is_omitted_when_numbering_is_off(self):
        header = _build_fasta_header(
            "TX1", "GENE1", "exon", "13", 100, 200, "+", 101,
            {**HEADER_FIELDS, "exon_number": False}, "", "", rank=3,
        )
        self.assertNotIn("rank", header)

    def test_protein_length_is_reported_in_amino_acids(self):
        header = _build_fasta_header(
            "TX1", "GENE1", "protein", "13", 100, 200, "+", 33,
            HEADER_FIELDS, "protein_coding", "", length_unit="aa",
        )
        self.assertIn("len=33aa", header)
        self.assertNotIn("bp", header)

    def test_mane_status_is_read_from_tags_as_well_as_the_field(self):
        # It arrives as a GFF tag far more often than as a field; keying off the
        # field alone dropped the note from every MANE transcript.
        from_tags = _canonical_info_for_header(
            {"is_canonical": True, "tags": ["gencode_basic", "MANE_Select"]}
        )
        from_field = _canonical_info_for_header(
            {"is_canonical": True, "mane_status": "MANE Select"}
        )
        self.assertEqual(from_tags, "canonical, MANE-select")
        self.assertEqual(from_field, "canonical, MANE-select")

    def test_a_plain_transcript_carries_no_canonical_note(self):
        self.assertEqual(_canonical_info_for_header({"tags": ["gencode_basic"]}), "")

    def test_comma_separated_tag_strings_are_accepted(self):
        info = _canonical_info_for_header({"tags": "basic,MANE_Select"})
        self.assertEqual(info, "MANE-select")


class SplitFastaRecordTests(unittest.TestCase):
    def test_header_and_body_are_separated_at_the_first_newline(self):
        header, body = _split_fasta_record(">TX1 feature=cds\nACGT\nACGT")
        self.assertEqual(header, ">TX1 feature=cds")
        self.assertEqual(body, "ACGT\nACGT")

    def test_a_header_only_record_yields_an_empty_body(self):
        header, body = _split_fasta_record(">TX1")
        self.assertEqual(header, ">TX1")
        self.assertEqual(body, "")


if __name__ == "__main__":
    unittest.main()

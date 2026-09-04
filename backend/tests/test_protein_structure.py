"""Protein structure lookup, cross-reference parsing, and exon->residue mapping.

The mapping tests are the important ones. AlphaFold models the UniProt canonical
sequence, so for any transcript that is not the canonical isoform the local
translation and the model disagree, and an exon overlay built on the naive
assumption that residue *n* is residue *n* would be confidently wrong. What is
pinned here is that the disagreement is measured rather than papered over: split
codons get one owning exon, unmappable residues are counted, and a fragmented or
mismatched model produces a warning the UI is expected to show.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import protein_structure as ps  # noqa: E402
from security_utils import validate_annotation_service_url  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def segment(coord_start, coord_end, genomic_start, genomic_end, phase=None):
    return {
        "coord_start": coord_start,
        "coord_end": coord_end,
        "genomic_start": genomic_start,
        "genomic_end": genomic_end,
        "phase": phase,
    }


class AnnotationAllowlistTests(unittest.TestCase):
    def test_accepts_the_three_annotation_services(self):
        for url in (
            "https://alphafold.ebi.ac.uk/api/prediction/O43175",
            "https://alphafold.ebi.ac.uk/files/AF-O43175-F1-model_v4.cif",
            "https://rest.uniprot.org/uniprotkb/search?query=xref:ENSP1",
            "https://www.ebi.ac.uk/interpro/api/entry/all/protein/uniprot/O43175",
        ):
            self.assertEqual(validate_annotation_service_url(url), url)

    def test_rejects_other_hosts_and_paths(self):
        for url in (
            "https://example.com/api/prediction/O43175",
            "https://alphafold.ebi.ac.uk/admin",
            "https://rest.uniprot.org/idmapping/run",
            "https://www.ebi.ac.uk/pdbe/api/anything",
            "http://alphafold.ebi.ac.uk/api/prediction/O43175",
            "https://user:pw@alphafold.ebi.ac.uk/api/prediction/O43175",
            "https://alphafold.ebi.ac.uk/files/../../etc/passwd",
        ):
            with self.assertRaises(HTTPException, msg=url):
                validate_annotation_service_url(url)


class AccessionTests(unittest.TestCase):
    def test_normalizes_valid_accessions(self):
        self.assertEqual(ps.normalize_accession(" o43175 "), "O43175")
        self.assertEqual(ps.normalize_accession("Q9BYF1"), "Q9BYF1")
        self.assertEqual(ps.normalize_accession("A0A0B4J2D5"), "A0A0B4J2D5")
        self.assertEqual(ps.normalize_accession("P12345-2"), "P12345-2")

    def test_rejects_non_accessions(self):
        for token in ("", "ENSP00000123456", "NP_001234", "1ABC", "hello"):
            self.assertEqual(ps.normalize_accession(token), "", token)

    def test_search_params_query_the_cross_reference_index_without_a_version(self):
        params = ps.uniprot_search_params("ENSP00000418160.2")
        self.assertEqual(params["query"], "xref:ENSP00000418160")
        self.assertEqual(params["format"], "json")


class SearchResultTests(unittest.TestCase):
    """Choosing between the entries a protein ID cross-references."""

    @staticmethod
    def _payload(*entries):
        return {"results": [
            {
                "primaryAccession": accession,
                "entryType": entry_type,
                "sequence": {"length": length},
            }
            for accession, entry_type, length in entries
        ]}

    def test_prefers_the_reviewed_entry(self):
        payload = self._payload(
            ("A0A2C9F2M7", "UniProtKB unreviewed (TrEMBL)", 532),
            ("O43175", "UniProtKB reviewed (Swiss-Prot)", 533),
        )
        self.assertEqual(ps.extract_search_accession(payload), "O43175")

    def test_an_exact_length_match_beats_a_reviewed_entry(self):
        # The entry whose sequence is the same length as our translation is the
        # one that will map residue-for-residue, which matters more for an exon
        # overlay than curation status does.
        payload = self._payload(
            ("A0A2C9F2M7", "UniProtKB unreviewed (TrEMBL)", 532),
            ("O43175", "UniProtKB reviewed (Swiss-Prot)", 533),
        )
        self.assertEqual(ps.extract_search_accession(payload, preferred_length=532), "A0A2C9F2M7")

    def test_unreviewed_is_not_mistaken_for_reviewed(self):
        payload = self._payload(("A0A2C9F2M7", "UniProtKB unreviewed (TrEMBL)", 532))
        self.assertEqual(ps.extract_search_accession(payload), "A0A2C9F2M7")

    def test_falls_back_to_the_first_hit_when_nothing_is_reviewed(self):
        payload = self._payload(
            ("A0A0B4J2D5", "UniProtKB unreviewed (TrEMBL)", 100),
            ("A0A2C9F2M7", "UniProtKB unreviewed (TrEMBL)", 200),
        )
        self.assertEqual(ps.extract_search_accession(payload), "A0A0B4J2D5")

    def test_no_results_yields_nothing(self):
        self.assertEqual(ps.extract_search_accession({"results": []}), "")
        self.assertEqual(ps.extract_search_accession(None), "")


class MappingFileTests(unittest.TestCase):
    def test_parses_a_simple_two_column_file_without_a_header(self):
        mapping = ps.parse_uniprot_mapping_tsv("ENSP00000418160\tO43175\nNP_006614\tQ04721\n")
        self.assertEqual(mapping.format, "simple")
        self.assertEqual(mapping.lookup("ENSP00000418160"), "O43175")
        self.assertEqual(mapping.lookup("NP_006614"), "Q04721")
        self.assertEqual(mapping.matched_count, 2)

    def test_matches_across_a_version_suffix_in_either_direction(self):
        mapping = ps.parse_uniprot_mapping_tsv("ENSP00000418160.3\tO43175\n")
        self.assertEqual(mapping.lookup("ENSP00000418160"), "O43175")
        self.assertEqual(mapping.lookup("ENSP00000418160.7"), "O43175")

    def test_parses_an_ensembl_xref_dump_and_prefers_the_reviewed_entry(self):
        text = (
            "gene_stable_id\ttranscript_stable_id\tprotein_stable_id\txref\tdb_name\n"
            "ENSG1\tENST1\tENSP00000418160\tA0A024RBG1\tUniprot/SPTREMBL\n"
            "ENSG1\tENST1\tENSP00000418160\tO43175\tUniprot/SWISSPROT\n"
            "ENSG2\tENST2\tENSP00000000001\tENSG2\tEntrezGene\n"
        )
        mapping = ps.parse_uniprot_mapping_tsv(text)
        self.assertEqual(mapping.format, "ensembl_xref")
        self.assertEqual(mapping.lookup("ENSP00000418160"), "O43175")
        # The non-UniProt row is skipped rather than mapped to a bogus accession.
        self.assertEqual(mapping.lookup("ENSP00000000001"), "")

    def test_a_reviewed_entry_seen_first_is_not_overwritten(self):
        text = (
            "protein_stable_id\txref\tdb_name\n"
            "ENSP1\tO43175\tUniprot/SWISSPROT\n"
            "ENSP1\tA0A024RBG1\tUniprot/SPTREMBL\n"
        )
        self.assertEqual(ps.parse_uniprot_mapping_tsv(text).lookup("ENSP1"), "O43175")

    def test_ignores_rows_with_an_unparseable_accession(self):
        mapping = ps.parse_uniprot_mapping_tsv("ENSP1\tnot-an-accession\nENSP2\tO43175\n")
        self.assertEqual(mapping.lookup("ENSP1"), "")
        self.assertEqual(mapping.lookup("ENSP2"), "O43175")

    def test_empty_input_yields_an_empty_mapping(self):
        self.assertEqual(ps.parse_uniprot_mapping_tsv("   ").by_id, {})


class AlphaFoldMetadataTests(unittest.TestCase):
    def test_reads_the_current_field_names(self):
        model = ps.parse_alphafold_prediction([{
            "modelEntityId": "AF-O43175-F1",
            "uniprotAccession": "O43175",
            "sequence": "MAFAN",
            "sequenceStart": 1,
            "sequenceEnd": 5,
            "latestVersion": 4,
            "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-O43175-F1-model_v4.cif",
        }], "O43175")
        self.assertEqual(model.model_entity_id, "AF-O43175-F1")
        self.assertEqual(model.sequence, "MAFAN")
        self.assertEqual(model.version, 4)
        self.assertFalse(model.is_fragmented)

    def test_still_reads_the_sunset_field_names(self):
        model = ps.parse_alphafold_prediction([{
            "entryId": "AF-O43175-F1",
            "uniprotSequence": "MAFAN",
            "uniprotStart": 1,
            "uniprotEnd": 5,
        }], "O43175")
        self.assertEqual(model.model_entity_id, "AF-O43175-F1")
        self.assertEqual(model.sequence, "MAFAN")

    def test_counts_fragments(self):
        model = ps.parse_alphafold_prediction(
            [{"sequence": "MAFAN"}, {"sequence": "NNNNN"}], "Q9Y6K9"
        )
        self.assertEqual(model.fragment_count, 2)
        self.assertTrue(model.is_fragmented)

    def test_empty_payload_yields_no_model(self):
        self.assertIsNone(ps.parse_alphafold_prediction([], "O43175"))
        self.assertIsNone(ps.parse_alphafold_prediction(None, "O43175"))

    def test_cache_filename_is_sanitised(self):
        self.assertEqual(ps.model_cache_filename("O43175", 4), "AF-O43175-F1-model_v4.cif")
        self.assertEqual(ps.model_cache_filename("../../etc", 4), "AF-etc-F1-model_v4.cif")


class ExonAssignmentTests(unittest.TestCase):
    def test_whole_codons_belong_to_their_own_exon(self):
        # Two exons of exactly two codons each.
        owners = ps.assign_exon_per_residue([
            segment(1, 6, 100, 105),
            segment(7, 12, 200, 205),
        ])
        self.assertEqual(owners, [0, 0, 1, 1])

    def test_a_split_codon_goes_to_the_exon_contributing_most_bases(self):
        # Exon 0 gives 4 bases, so codon 2 (bases 4-6) is 1 base from exon 0 and
        # 2 from exon 1: exon 1 wins.
        owners = ps.assign_exon_per_residue([
            segment(1, 4, 100, 103),
            segment(5, 9, 200, 204),
        ])
        self.assertEqual(owners, [0, 1, 1])

    def test_the_majority_share_wins_when_two_exons_split_a_codon(self):
        # Codon 2 is bases 4-6: exon 0 contributes 4 and 5, exon 1 contributes 6.
        owners = ps.assign_exon_per_residue([
            segment(1, 5, 100, 104),
            segment(6, 9, 200, 203),
        ])
        self.assertEqual(owners, [0, 0, 1])

    def test_a_three_way_tie_goes_to_the_five_prime_exon(self):
        # Three single-base exons spanning one codon: every share is 1, so the
        # documented tie-break (earliest segment) is the only thing deciding it.
        owners = ps.assign_exon_per_residue([
            segment(1, 1, 100, 100),
            segment(2, 2, 200, 200),
            segment(3, 3, 300, 300),
        ])
        self.assertEqual(owners, [0])

    def test_no_segments_yields_nothing(self):
        self.assertEqual(ps.assign_exon_per_residue([]), [])


class GenomicAnchorTests(unittest.TestCase):
    def test_forward_strand_walks_forwards(self):
        segments = [segment(1, 6, 100, 105), segment(7, 12, 200, 205)]
        self.assertEqual(ps.aa_to_genomic(segments, "+", 1), 100)
        self.assertEqual(ps.aa_to_genomic(segments, "+", 2), 103)
        self.assertEqual(ps.aa_to_genomic(segments, "+", 3), 200)

    def test_reverse_strand_walks_backwards_from_the_segment_end(self):
        segments = [segment(1, 6, 100, 105), segment(7, 12, 200, 205)]
        self.assertEqual(ps.aa_to_genomic(segments, "-", 1), 105)
        self.assertEqual(ps.aa_to_genomic(segments, "-", 2), 102)
        self.assertEqual(ps.aa_to_genomic(segments, "-", 3), 205)

    def test_out_of_range_returns_none(self):
        self.assertIsNone(ps.aa_to_genomic([segment(1, 6, 100, 105)], "+", 99))


class GenomicToCdsTests(unittest.TestCase):
    """The inverse of the anchor above — where a variant lands in the CDS."""

    def test_forward_strand_is_the_inverse_of_the_anchor(self):
        segments = [segment(1, 6, 100, 105), segment(7, 12, 200, 205)]
        for aa in (1, 2, 3, 4):
            position = ps.aa_to_genomic(segments, "+", aa)
            coord = ps.genomic_to_cds_coord(segments, "+", position)
            self.assertEqual((coord + 2) // 3, aa)

    def test_reverse_strand_is_the_inverse_of_the_anchor(self):
        segments = [segment(1, 6, 100, 105), segment(7, 12, 200, 205)]
        for aa in (1, 2, 3, 4):
            position = ps.aa_to_genomic(segments, "-", aa)
            coord = ps.genomic_to_cds_coord(segments, "-", position)
            self.assertEqual((coord + 2) // 3, aa)

    def test_every_base_of_a_segment_is_reachable(self):
        segments = [segment(1, 6, 100, 105)]
        coords = [ps.genomic_to_cds_coord(segments, "+", pos) for pos in range(100, 106)]
        self.assertEqual(coords, [1, 2, 3, 4, 5, 6])

    def test_an_intronic_position_is_not_coding(self):
        segments = [segment(1, 6, 100, 105), segment(7, 12, 200, 205)]
        self.assertIsNone(ps.genomic_to_cds_coord(segments, "+", 150))

    def test_a_five_prime_partial_cds_keeps_the_padded_frame(self):
        # phase 1 pads the coordinate space by two, so the first annotated base
        # is coord 3 and belongs to amino acid 1 along with two virtual bases.
        segments = [segment(3, 8, 100, 105, phase=1)]
        self.assertEqual(ps.genomic_to_cds_coord(segments, "+", 100), 3)
        self.assertEqual((ps.genomic_to_cds_coord(segments, "+", 100) + 2) // 3, 1)
        self.assertEqual((ps.genomic_to_cds_coord(segments, "+", 101) + 2) // 3, 2)

    def test_the_owning_exon_is_reported_for_a_coordinate(self):
        segments = [segment(1, 6, 100, 105), segment(7, 12, 200, 205)]
        self.assertEqual(ps.exon_index_for_coord(segments, 6), 0)
        self.assertEqual(ps.exon_index_for_coord(segments, 7), 1)
        self.assertEqual(ps.exon_index_for_coord(segments, 99), -1)


class ReverseComplementTests(unittest.TestCase):
    def test_a_single_base_is_complemented(self):
        self.assertEqual(ps.reverse_complement("A"), "T")
        self.assertEqual(ps.reverse_complement("g"), "c")

    def test_a_run_is_reversed_as_well_as_complemented(self):
        self.assertEqual(ps.reverse_complement("ACGT"), "ACGT")
        self.assertEqual(ps.reverse_complement("AACG"), "CGTT")

    def test_an_unknown_letter_is_left_alone(self):
        self.assertEqual(ps.reverse_complement("AXT"), "AXT")


class ConsequenceTests(unittest.TestCase):
    """Consequences come from the codon, so an unannotated VCF still works."""

    def test_an_unchanged_residue_is_synonymous(self):
        self.assertEqual(ps.classify_substitution("L", "L", 40), "synonymous")
        self.assertEqual(ps.variant_impact("synonymous"), "silent")

    def test_a_new_stop_is_truncating(self):
        self.assertEqual(ps.classify_substitution("Q", "*", 40), "stop_gained")
        self.assertEqual(ps.variant_impact("stop_gained"), "truncating")

    def test_losing_the_stop_is_also_truncating(self):
        self.assertEqual(ps.classify_substitution("*", "W", 400), "stop_lost")
        self.assertEqual(ps.variant_impact("stop_lost"), "truncating")

    def test_a_change_at_the_first_residue_is_a_lost_start(self):
        self.assertEqual(ps.classify_substitution("M", "V", 1), "start_lost")
        # A synonymous change there is still synonymous.
        self.assertEqual(ps.classify_substitution("M", "M", 1), "synonymous")

    def test_an_ordinary_change_is_missense(self):
        self.assertEqual(ps.classify_substitution("R", "H", 40), "missense")
        self.assertEqual(ps.variant_impact("missense"), "missense")

    def test_an_untranslatable_codon_is_reported_as_protein_altering(self):
        self.assertEqual(ps.classify_substitution("", "", 40), "protein_altering")

    def test_an_indel_off_the_frame_is_a_frameshift(self):
        self.assertEqual(ps.classify_indel("A", "AT"), "frameshift")
        self.assertEqual(ps.classify_indel("ATT", "A"), "frameshift")
        self.assertEqual(ps.variant_impact("frameshift"), "truncating")

    def test_an_indel_in_frame_keeps_the_reading_frame(self):
        self.assertEqual(ps.classify_indel("A", "ATTC"), "inframe_insertion")
        self.assertEqual(ps.classify_indel("ATTC", "A"), "inframe_deletion")
        self.assertEqual(ps.variant_impact("inframe_deletion"), "missense")

    def test_a_same_length_replacement_is_only_known_to_alter_the_protein(self):
        self.assertEqual(ps.classify_indel("AT", "GC"), "protein_altering")

    def test_an_unknown_term_falls_back_to_other(self):
        self.assertEqual(ps.variant_impact("regulatory_region_variant"), "other")


class AlignmentTests(unittest.TestCase):
    def test_identical_sequences_skip_the_aligner(self):
        def explode(_a, _b):
            raise AssertionError("aligner must not be called for identical sequences")

        mapping, identity, aligned, matches = ps.align_local_to_model("MAFAN", "MAFAN", explode)
        self.assertEqual(mapping, {1: 1, 2: 2, 3: 3, 4: 4, 5: 5})
        self.assertEqual(identity, 1.0)
        self.assertFalse(aligned)
        self.assertEqual(matches, 5)

    def test_a_deletion_in_the_local_sequence_shifts_the_mapping(self):
        # Local is missing the model's third residue.
        def align(_local, _model):
            return "MA-AN", "MAFAN"

        mapping, identity, aligned, _ = ps.align_local_to_model("MAAN", "MAFAN", align)
        self.assertEqual(mapping, {1: 1, 2: 2, 3: 4, 4: 5})
        self.assertTrue(aligned)
        self.assertEqual(identity, 1.0)

    def test_mismatches_lower_the_identity(self):
        def align(_local, _model):
            return "MAFAN", "MAFAQ"

        _, identity, _, matches = ps.align_local_to_model("MAFAN", "MAFAQ", align)
        self.assertEqual(matches, 4)
        self.assertAlmostEqual(identity, 0.8)

    def test_without_an_aligner_differing_sequences_map_to_nothing(self):
        mapping, _, aligned, _ = ps.align_local_to_model("MAFAN", "MAFAQ", None)
        self.assertEqual(mapping, {})
        self.assertFalse(aligned)


class ResidueMapTests(unittest.TestCase):
    def _model(self, sequence, **kwargs):
        return ps.AlphaFoldModel(accession="O43175", sequence=sequence, **kwargs)

    def test_identical_sequence_gives_one_range_per_exon(self):
        segments = [segment(1, 6, 100, 105), segment(7, 12, 200, 205)]
        result = ps.build_residue_map("MAFA", self._model("MAFA"), segments, "+")

        self.assertTrue(result.identical)
        self.assertFalse(result.aligned)
        self.assertEqual(result.coverage, 1.0)
        self.assertEqual(result.exon_count, 2)
        self.assertEqual(result.unmapped_residues, 0)
        self.assertEqual(
            [(s.exon_index, s.aa_start, s.aa_end, s.model_start, s.model_end) for s in result.segments],
            [(0, 1, 2, 1, 2), (1, 3, 4, 3, 4)],
        )
        self.assertEqual(result.segments[0].genomic_start, 100)
        self.assertEqual(result.segments[1].genomic_start, 200)
        self.assertEqual(result.warnings, [])

    def test_a_skipped_exon_isoform_maps_with_an_offset_and_warns(self):
        # Local translation lacks the two residues the model's middle exon gives.
        local = "MAKL"
        model_seq = "MAFFKL"
        segments = [segment(1, 6, 100, 105), segment(7, 12, 300, 305)]

        def align(_local, _model):
            return "MA--KL", "MAFFKL"

        result = ps.build_residue_map(local, self._model(model_seq), segments, "+", align)

        self.assertFalse(result.identical)
        self.assertTrue(result.aligned)
        self.assertEqual(result.coverage, 1.0)
        self.assertEqual(
            [(s.exon_index, s.aa_start, s.aa_end, s.model_start, s.model_end) for s in result.segments],
            [(0, 1, 2, 1, 2), (1, 3, 4, 5, 6)],
        )
        self.assertTrue(any("differs from the modelled" in w for w in result.warnings))

    def test_unmapped_local_residues_are_counted_and_excluded(self):
        # Local has an insertion the model does not carry.
        def align(_local, _model):
            return "MAXXFA", "MA--FA"

        segments = [segment(1, 18, 100, 117)]
        result = ps.build_residue_map("MAXXFA", self._model("MAFA"), segments, "+", align)

        self.assertEqual(result.unmapped_residues, 2)
        self.assertAlmostEqual(result.coverage, 4 / 6)
        # The run breaks where the insertion sits rather than spanning it.
        self.assertEqual(
            [(s.aa_start, s.aa_end, s.model_start, s.model_end) for s in result.segments],
            [(1, 2, 1, 2), (5, 6, 3, 4)],
        )

    def test_fragment_start_offsets_the_model_numbering(self):
        segments = [segment(1, 6, 100, 105)]
        model = self._model("MA", sequence_start=201, sequence_end=202, fragment_count=1)
        result = ps.build_residue_map("MA", model, segments, "+")
        self.assertEqual((result.segments[0].model_start, result.segments[0].model_end), (201, 202))

    def test_a_fragmented_model_warns_that_the_view_is_partial(self):
        segments = [segment(1, 6, 100, 105)]
        model = self._model("MA", fragment_count=3)
        result = ps.build_residue_map("MA", model, segments, "+")
        self.assertTrue(any("3 fragments" in w for w in result.warnings))

    def test_missing_model_sequence_reports_rather_than_crashes(self):
        result = ps.build_residue_map("MA", self._model(""), [segment(1, 6, 1, 6)], "+")
        self.assertEqual(result.segments, [])
        self.assertTrue(result.warnings)

    def test_no_aligner_and_differing_sequences_reports_rather_than_guesses(self):
        result = ps.build_residue_map("MAFA", self._model("MAFQ"), [segment(1, 12, 1, 12)], "+")
        self.assertEqual(result.segments, [])
        self.assertTrue(any("No aligner" in w for w in result.warnings))


if __name__ == "__main__":
    unittest.main()

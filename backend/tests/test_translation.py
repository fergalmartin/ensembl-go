"""Unit tests for the translation rules in backend/translation.py.

These are self-contained: no genome data, no network.  The real Ensembl/RefSeq
comparisons live in test_translation_reference.py.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from translation import (  # noqa: E402
    MOLECULE_MITOCHONDRION,
    MOLECULE_NUCLEAR,
    MOLECULE_PLASTID,
    TABLE_BACTERIAL_PLASTID,
    TABLE_CILIATE_NUCLEAR,
    TABLE_INVERTEBRATE_MITO,
    TABLE_STANDARD,
    TABLE_VERTEBRATE_MITO,
    TABLE_YEAST_MITO,
    autodetect_organelle_table,
    build_translation_layout,
    classify_contig_molecule,
    internal_stop_count,
    normalize_cds_intervals,
    translate_cds_dna,
    translation_table_for_lineage,
)

# Lineages as backend/data/taxonomy_classification.json carries them (root → species).
HUMAN_LINEAGE = (2759, 33208, 7711, 7742, 40674, 9606)
FLY_LINEAGE = (2759, 33208, 33317, 6656, 50557, 7227)
YEAST_LINEAGE = (2759, 4751, 4890, 4893, 4932)
ARABIDOPSIS_LINEAGE = (2759, 33090, 3193, 3702)
ECOLI_LINEAGE = (2, 1224, 1236, 561, 562)
TETRAHYMENA_LINEAGE = (2759, 33630, 5878, 5911)


class TestContigMolecule(unittest.TestCase):
    def test_names_that_mean_mitochondrion(self):
        for name in ("MT", "chrM", "chrMT", "mtDNA", "MtDNA", "mitochondrion_genome", "M"):
            with self.subTest(name=name):
                self.assertEqual(classify_contig_molecule(name), MOLECULE_MITOCHONDRION)

    def test_names_that_mean_plastid(self):
        for name in ("Pltd", "chrPltd", "chloroplast", "PT"):
            with self.subTest(name=name):
                self.assertEqual(classify_contig_molecule(name), MOLECULE_PLASTID)

    def test_chromosomes_are_nuclear(self):
        for name in ("1", "chr1", "X", "chrX", "KI270713.1", "NC_000001.11", "2L", "scaffold_12"):
            with self.subTest(name=name):
                self.assertEqual(classify_contig_molecule(name), MOLECULE_NUCLEAR)

    def test_assembly_report_wins_over_name(self):
        # RefSeq's mitochondrion is an accession; only the report identifies it.
        self.assertEqual(
            classify_contig_molecule("NC_012920.1", "Mitochondrion"), MOLECULE_MITOCHONDRION
        )
        # And a contig called "MT" that the report calls a chromosome is nuclear.
        self.assertEqual(classify_contig_molecule("MT", "Chromosome"), MOLECULE_NUCLEAR)


class TestGeneticCodeSelection(unittest.TestCase):
    def test_nuclear_genomes_use_the_standard_code(self):
        self.assertEqual(translation_table_for_lineage(MOLECULE_NUCLEAR, HUMAN_LINEAGE), TABLE_STANDARD)
        self.assertEqual(translation_table_for_lineage(MOLECULE_NUCLEAR, ARABIDOPSIS_LINEAGE), TABLE_STANDARD)

    def test_bacteria_use_the_bacterial_code(self):
        self.assertEqual(
            translation_table_for_lineage(MOLECULE_NUCLEAR, ECOLI_LINEAGE), TABLE_BACTERIAL_PLASTID
        )

    def test_ciliates_use_the_ciliate_nuclear_code(self):
        self.assertEqual(
            translation_table_for_lineage(MOLECULE_NUCLEAR, TETRAHYMENA_LINEAGE), TABLE_CILIATE_NUCLEAR
        )

    def test_mitochondrial_codes_follow_the_clade(self):
        cases = (
            (HUMAN_LINEAGE, TABLE_VERTEBRATE_MITO),
            (FLY_LINEAGE, TABLE_INVERTEBRATE_MITO),
            (YEAST_LINEAGE, TABLE_YEAST_MITO),
            (ARABIDOPSIS_LINEAGE, TABLE_STANDARD),  # plant mitochondria use the standard code
        )
        for lineage, expected in cases:
            with self.subTest(lineage=lineage[-1]):
                self.assertEqual(translation_table_for_lineage(MOLECULE_MITOCHONDRION, lineage), expected)

    def test_plastids_use_the_plant_plastid_code(self):
        self.assertEqual(
            translation_table_for_lineage(MOLECULE_PLASTID, ARABIDOPSIS_LINEAGE), TABLE_BACTERIAL_PLASTID
        )

    def test_unknown_lineage_is_reported_as_unresolved(self):
        # Callers need to tell "no rule matched" from "use table 1", so that an
        # organelle contig of an unknown species can fall back to detection.
        self.assertIsNone(translation_table_for_lineage(MOLECULE_MITOCHONDRION, ()))
        self.assertIsNone(translation_table_for_lineage(MOLECULE_NUCLEAR, ()))


class TestCdsNormalization(unittest.TestCase):
    def test_minus_strand_is_ordered_five_to_three(self):
        cds = [{"start": 100, "end": 120}, {"start": 200, "end": 230}]
        ordered = normalize_cds_intervals(cds, "-")
        self.assertEqual([seg["start"] for seg in ordered], [200, 100])

    def test_exact_duplicates_are_dropped(self):
        # A merged or hand-edited GFF can list the same CDS twice; counting it
        # twice would double those bases and shift the frame.
        cds = [
            {"start": 100, "end": 120, "phase": 0},
            {"start": 100, "end": 120, "phase": 0},
            {"start": 200, "end": 230, "phase": 0},
        ]
        self.assertEqual(len(normalize_cds_intervals(cds, "+")), 2)

    def test_reversed_and_invalid_coordinates(self):
        cds = [{"start": 120, "end": 100}, {"start": 0, "end": 50}, {"start": -3, "end": -1}]
        ordered = normalize_cds_intervals(cds, "+")
        self.assertEqual(ordered, [{"start": 100, "end": 120, "phase": None}])

    def test_phase_strings_are_accepted(self):
        ordered = normalize_cds_intervals([{"start": 1, "end": 9, "phase": "2"}], "+")
        self.assertEqual(ordered[0]["phase"], 2)
        ordered = normalize_cds_intervals([{"start": 1, "end": 9, "phase": "."}], "+")
        self.assertIsNone(ordered[0]["phase"])


class TestTranslationLayout(unittest.TestCase):
    def test_complete_cds_starts_at_coordinate_one(self):
        layout = build_translation_layout([{"start": 1, "end": 9, "phase": 0}], "+")
        self.assertEqual(layout.pad, 0)
        self.assertEqual(layout.segments[0].coord_start, 1)
        self.assertEqual(layout.segments[0].coord_end, 9)
        self.assertFalse(layout.five_prime_partial)
        self.assertFalse(layout.three_prime_partial)

    def test_phase_one_pads_two_virtual_bases(self):
        # phase 1: one leading base belongs to a codon that started upstream, so
        # amino acid 1 is that partial codon and occupies coordinates 1..3.
        layout = build_translation_layout([{"start": 1, "end": 10, "phase": 1}], "+")
        self.assertEqual(layout.pad, 2)
        self.assertEqual(layout.segments[0].coord_start, 3)
        self.assertEqual(layout.segments[0].coord_end, 12)
        self.assertTrue(layout.five_prime_partial)

    def test_phase_two_pads_one_virtual_base(self):
        layout = build_translation_layout([{"start": 1, "end": 11, "phase": 2}], "+")
        self.assertEqual(layout.pad, 1)
        self.assertEqual(layout.segments[0].coord_start, 2)

    def test_amino_acids_map_onto_segments(self):
        # The client maps a CDS nucleotide to an amino acid with
        # floor((nt - 1) / 3) + 1, so codon-aligned coordinates must cover every
        # amino acid exactly once.
        cds = [
            {"start": 100, "end": 120, "phase": 1},   # 21 bases
            {"start": 200, "end": 229, "phase": 0},   # 30 bases
            {"start": 300, "end": 311, "phase": 0},   # 12 bases
        ]
        layout = build_translation_layout(cds, "+")
        protein_length = 1 + (63 - 1) // 3           # leading X + whole codons
        self.assertEqual(layout.coord_max, protein_length * 3)
        covered = set()
        for segment in layout.segments:
            for nt in range(segment.coord_start, segment.coord_end + 1):
                covered.add((nt - 1) // 3 + 1)
        self.assertEqual(covered, set(range(1, protein_length + 1)))

    def test_trailing_partial_codon_is_trimmed_from_segments(self):
        # 20 bases: 6 whole codons plus 2 spare, which must not appear in the
        # coordinate space or the client would map them to a missing amino acid.
        layout = build_translation_layout([{"start": 1, "end": 20, "phase": 0}], "+")
        self.assertEqual(layout.coord_max, 18)
        self.assertEqual(layout.segments[-1].genomic_end, 18)
        self.assertTrue(layout.three_prime_partial)

    def test_trailing_trim_on_minus_strand_moves_the_low_coordinate(self):
        layout = build_translation_layout([{"start": 1, "end": 20, "phase": 0}], "-")
        self.assertEqual(layout.segments[-1].genomic_start, 3)
        self.assertEqual(layout.segments[-1].genomic_end, 20)

    def test_trailing_trim_can_drop_a_whole_segment(self):
        cds = [{"start": 1, "end": 9, "phase": 0}, {"start": 20, "end": 21, "phase": 0}]
        layout = build_translation_layout(cds, "+")
        self.assertEqual(len(layout.segments), 1)
        self.assertEqual(layout.coord_max, 9)

    def test_empty_cds(self):
        layout = build_translation_layout([], "+")
        self.assertEqual(layout.segments, ())
        self.assertEqual(layout.coord_max, 0)


class TestTranslateCdsDna(unittest.TestCase):
    def test_terminal_stop_is_stripped_and_internal_stops_are_kept(self):
        # ATG TGA ATG TAA -> M * M, terminal stop removed
        self.assertEqual(translate_cds_dna("ATGTGAATGTAA"), "M*M")
        self.assertEqual(internal_stop_count("M*M"), 1)

    def test_phase_shifts_the_frame_and_reports_a_leading_x(self):
        # Reading the same bases in the wrong frame gives a different protein.
        dna = "GCTTATCGACTAA"
        self.assertEqual(translate_cds_dna(dna, start_phase=0), "AYRL")
        self.assertEqual(translate_cds_dna(dna, start_phase=1), "XLID")

    def test_trailing_partial_codon_is_dropped(self):
        self.assertEqual(translate_cds_dna("ATGGCTAA"), "MA")

    def test_ambiguous_bases_translate_to_x(self):
        self.assertEqual(translate_cds_dna("ATGNNNGCT"), "MXA")

    def test_alternative_initiation_codons_are_reported_as_met(self):
        # CTG and TTG initiate in the standard code; GTG does not.
        self.assertEqual(translate_cds_dna("CTGGCTTAA")[0], "M")
        self.assertEqual(translate_cds_dna("TTGGCTTAA")[0], "M")
        self.assertEqual(translate_cds_dna("GTGGCTTAA")[0], "V")
        # ATT initiates in the vertebrate mitochondrial code but not in the standard one.
        self.assertEqual(translate_cds_dna("ATTGCTTAA", table=TABLE_VERTEBRATE_MITO)[0], "M")
        self.assertEqual(translate_cds_dna("ATTGCTTAA")[0], "I")

    def test_a_5_prime_partial_cds_is_not_given_a_met(self):
        self.assertTrue(translate_cds_dna("CCTGGCTTAA", start_phase=1).startswith("X"))

    def test_vertebrate_mitochondrial_code(self):
        # TGA is Trp and AGA is a stop in table 2.
        self.assertEqual(translate_cds_dna("ATGTGAGCT", table=TABLE_VERTEBRATE_MITO), "MWA")
        self.assertEqual(translate_cds_dna("ATGTGAAGA", table=TABLE_VERTEBRATE_MITO), "MW")
        # …and the same bases under the standard code are visibly broken.
        self.assertEqual(translate_cds_dna("ATGTGAGCT"), "M*A")

    def test_invertebrate_mitochondrial_code(self):
        # AGA is Ser in table 5 but Arg in table 1 and a stop in table 2.
        self.assertEqual(translate_cds_dna("ATGAGAGCT", table=TABLE_INVERTEBRATE_MITO), "MSA")
        self.assertEqual(translate_cds_dna("ATGAGAGCT"), "MRA")

    def test_ciliate_nuclear_code(self):
        # TAA encodes Gln in table 6, so it is not a stop.
        self.assertEqual(translate_cds_dna("ATGTAAGCT", table=TABLE_CILIATE_NUCLEAR), "MQA")

    def test_empty_input(self):
        self.assertEqual(translate_cds_dna(""), "")
        self.assertEqual(translate_cds_dna("AT"), "")


class TestOrganelleAutodetect(unittest.TestCase):
    def test_detects_the_vertebrate_mitochondrial_code(self):
        # A stretch that only reads through under table 2 (TGA -> Trp, ATA -> Met).
        dna = "ATGTGAATATGGTGAGCTTGATAA"
        self.assertEqual(autodetect_organelle_table(dna), TABLE_VERTEBRATE_MITO)

    def test_falls_back_when_nothing_reads_through(self):
        # Stops in every candidate code: return a code rather than raising.
        self.assertIn(autodetect_organelle_table("ATGTAATAGTAA"), (1, 2, 3, 4, 5, 9, 11))

    def test_standard_code_wins_when_it_is_clean(self):
        # Plant mitochondria use the standard code; a clean standard-code ORF with
        # TGA-as-stop absent must not be dragged onto a mitochondrial table.
        dna = "ATGGCTGCTAGAGCTTAA"
        table = autodetect_organelle_table(dna, candidates=(TABLE_STANDARD, TABLE_VERTEBRATE_MITO))
        self.assertEqual(table, TABLE_STANDARD)


if __name__ == "__main__":
    unittest.main()

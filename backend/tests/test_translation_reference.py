"""Check our proteins against the ones Ensembl and RefSeq publish.

The fixture in tests/data is cut from real GRCh38 data by
backend/scripts/build_translation_fixture.py: one contig per transcript (CDS span
plus flanks, coordinates shifted), the matching GFF3 and assembly report, and the
provider's own protein sequence as the expectation.  Cases were chosen to cover
what has actually broken translations in the past:

  * complete multi-exon CDS on both strands (APEX1 318 aa / TTC5 440 aa, both MANE
    Select, lengths agreeing with UniProt P27695 and Q8ND56)
  * 5'-incomplete CDS with first-CDS phase 1 and 2, on both strands — ignoring the
    phase shifts the reading frame and produces a protein full of stops
  * 3'-incomplete CDS, where the trailing partial codon must be dropped
  * mitochondrial genes, which need the vertebrate mitochondrial code: ATA/ATT
    initiation, TGA as Trp, AGA as a stop
  * a selenoprotein, where Ensembl's U comes from annotation the GFF3 does not
    carry and ours is expected to differ at exactly that residue

The whole chain is exercised, from indexing the GFF3 to the amino-acid string, so a
regression anywhere between the two shows up here.  For a genome-scale check
against a full proteome, see backend/scripts/validate_translations.py.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pysam  # noqa: E402

from assembly_report import load_assembly_synonym_rows  # noqa: E402
from taxonomy_classifier import TaxonomyLineageClassifier  # noqa: E402
from translation import (  # noqa: E402
    MOLECULE_MITOCHONDRION,
    MOLECULE_NUCLEAR,
    TABLE_STANDARD,
    TABLE_VERTEBRATE_MITO,
    classify_contig_molecule,
    internal_stop_count,
    translation_table_for_lineage,
)

import main  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"
FASTA_PATH = DATA_DIR / "translation_fixture.fa"
GFF_PATH = DATA_DIR / "translation_fixture.gff3"
REPORT_PATH = DATA_DIR / "translation_fixture_assembly_report.txt"
EXPECTED_PATH = DATA_DIR / "translation_fixture_expected.json"


def _molecule_map(report_path: Path) -> dict:
    molecules = {}
    for row in load_assembly_synonym_rows(str(report_path)):
        molecule = classify_contig_molecule(row.sequence_name, row.molecule_type)
        if molecule != MOLECULE_NUCLEAR:
            for alias in row.ordered_aliases():
                molecules[str(alias).strip().lower()] = molecule
    return molecules


class TranslationFixtureTestCase(unittest.TestCase):
    """Shared fixture: index the GFF3 once, then translate from the index."""

    @classmethod
    def setUpClass(cls):
        cls.fasta = pysam.FastaFile(str(FASTA_PATH))
        cls.cases = json.loads(EXPECTED_PATH.read_text(encoding="utf-8"))["cases"]
        cls.molecules = _molecule_map(REPORT_PATH)
        cls.lineages = {}
        classifier = TaxonomyLineageClassifier()
        for case in cls.cases:
            taxid = int(case["taxid"])
            if taxid not in cls.lineages:
                _resolved, lineage = classifier.lineage_for_taxid(taxid)
                cls.lineages[taxid] = tuple(lineage)

        cls._tmp = tempfile.TemporaryDirectory()
        db_path = str(Path(cls._tmp.name) / "fixture.index.db")
        main.ensure_gff_index(str(GFF_PATH), db_path, force_rebuild=True)
        cls.transcripts = {}
        import sqlite3

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        for row in conn.execute("SELECT id, chrom, strand, data FROM transcripts"):
            data = json.loads(row["data"] or "{}")
            cls.transcripts[str(row["id"])] = {
                "chrom": str(row["chrom"]),
                "strand": str(row["strand"]),
                "cds_list": data.get("cds_list") or [],
            }
        conn.close()

    @classmethod
    def tearDownClass(cls):
        cls.fasta.close()
        cls._tmp.cleanup()

    def _indexed(self, case):
        record = self.transcripts.get(case["transcript"])
        self.assertIsNotNone(record, f"{case['case_id']}: transcript missing from the index")
        self.assertTrue(record["cds_list"], f"{case['case_id']}: no CDS survived indexing")
        return record

    def _table_for(self, case, record):
        """Resolve the genetic code the way the endpoint does."""
        molecule = self.molecules.get(record["chrom"].lower()) or classify_contig_molecule(record["chrom"])
        table = translation_table_for_lineage(molecule, self.lineages[int(case["taxid"])])
        self.assertIsNotNone(table, f"{case['case_id']}: no genetic code resolved")
        return table, molecule

    def _translate(self, case, **kwargs):
        record = self._indexed(case)
        table, molecule = self._table_for(case, record)
        protein, layout, used_table = main._translate_transcript(
            self.fasta,
            record["chrom"],
            record["strand"],
            record["cds_list"],
            table=table,
            molecule=molecule,
            **kwargs,
        )
        return record, protein, layout, used_table

    @staticmethod
    def _expected_protein(case):
        expected = case["protein"]
        if case.get("known_divergence") == "selenocysteine":
            # The TGA is a stop as far as the GFF3 is concerned; Ensembl recodes it
            # to U from a SeqEdit that the file does not carry.
            expected = expected.replace("U", "*")
        return expected


class TestProteinsMatchProvider(TranslationFixtureTestCase):
    def test_every_case_matches_the_published_protein(self):
        for case in self.cases:
            with self.subTest(case=case["case_id"]):
                _record, protein, _layout, _table = self._translate(case)
                expected = self._expected_protein(case)
                self.assertEqual(
                    protein,
                    expected,
                    f"{case['case_id']} ({case['note']}): translation does not match "
                    f"{case['source']}\n  ours {len(protein)} aa: {protein[:60]}\n"
                    f"  ref  {len(expected)} aa: {expected[:60]}",
                )

    def test_mane_select_lengths(self):
        lengths = {case["case_id"]: len(case["protein"]) for case in self.cases}
        self.assertEqual(lengths["ensembl_complete_plus"], 318, "APEX1 is 318 aa (UniProt P27695)")
        self.assertEqual(lengths["ensembl_complete_minus"], 440, "TTC5 is 440 aa (UniProt Q8ND56)")

    def test_complete_proteins_start_with_met_and_have_no_internal_stops(self):
        for case in self.cases:
            if case["start_phase"] or case.get("known_divergence"):
                continue
            with self.subTest(case=case["case_id"]):
                _record, protein, _layout, _table = self._translate(case)
                self.assertTrue(protein.startswith("M"), f"{case['case_id']}: {protein[:5]}")
                self.assertEqual(internal_stop_count(protein), 0, f"{case['case_id']}: {protein}")

    def test_five_prime_partial_proteins_start_with_x(self):
        partials = [case for case in self.cases if case["start_phase"]]
        self.assertTrue(partials, "fixture should contain 5'-incomplete transcripts")
        for case in partials:
            with self.subTest(case=case["case_id"]):
                _record, protein, layout, _table = self._translate(case)
                self.assertTrue(protein.startswith("X"))
                self.assertTrue(layout.five_prime_partial)
                self.assertEqual(layout.pad, (3 - case["start_phase"]) % 3)


class TestPhaseRegression(TranslationFixtureTestCase):
    """Guards the bug that produced visibly broken proteins: ignoring CDS phase."""

    def test_ignoring_the_phase_breaks_partial_transcripts(self):
        from translation import translate_cds_dna

        partials = [case for case in self.cases if case["start_phase"]]
        for case in partials:
            with self.subTest(case=case["case_id"]):
                record, protein, layout, table = self._translate(case)
                dna = main._cds_dna_from_layout(self.fasta, record["chrom"], record["strand"], layout)
                unphased = translate_cds_dna(dna, start_phase=0, table=table)
                self.assertNotEqual(
                    unphased, protein,
                    f"{case['case_id']}: reading the wrong frame should not agree with the reference",
                )
                self.assertGreater(
                    internal_stop_count(unphased), 0,
                    f"{case['case_id']}: the wrong frame is expected to hit stop codons",
                )


class TestMitochondrialCode(TranslationFixtureTestCase):
    def test_mitochondrial_contigs_use_table_2(self):
        mito = [case for case in self.cases if "mito" in case["case_id"]]
        self.assertEqual(len(mito), 5, "fixture should cover the mitochondrial cases")
        for case in mito:
            with self.subTest(case=case["case_id"]):
                record = self._indexed(case)
                table, molecule = self._table_for(case, record)
                self.assertEqual(molecule, MOLECULE_MITOCHONDRION)
                self.assertEqual(table, TABLE_VERTEBRATE_MITO)

    def test_standard_code_breaks_mitochondrial_genes(self):
        for case in self.cases:
            if "mito" not in case["case_id"]:
                continue
            with self.subTest(case=case["case_id"]):
                record = self._indexed(case)
                protein, _layout, _table = main._translate_transcript(
                    self.fasta, record["chrom"], record["strand"], record["cds_list"],
                    table=TABLE_STANDARD,
                )
                self.assertGreater(
                    internal_stop_count(protein), 0,
                    f"{case['case_id']}: the nuclear code should visibly misread this gene",
                )

    def test_autodetection_recovers_the_code_without_a_lineage(self):
        # The path a manually imported genome takes: no taxid, so the code is
        # inferred from the sequence itself.
        for case in self.cases:
            if "mito" not in case["case_id"]:
                continue
            with self.subTest(case=case["case_id"]):
                record = self._indexed(case)
                protein, _layout, table = main._translate_transcript(
                    self.fasta, record["chrom"], record["strand"], record["cds_list"],
                    table=TABLE_STANDARD,
                    molecule=MOLECULE_MITOCHONDRION,
                    autodetect=True,
                )
                self.assertEqual(table, TABLE_VERTEBRATE_MITO)
                self.assertEqual(protein, self._expected_protein(case))


class TestSegmentsMatchTheProtein(TranslationFixtureTestCase):
    """The client maps amino acids to genome positions through these segments."""

    def test_coordinates_cover_exactly_the_protein(self):
        for case in self.cases:
            with self.subTest(case=case["case_id"]):
                _record, protein, layout, _table = self._translate(case)
                # Whole codons only, and at most one more than the protein: the
                # stop codon is inside the annotated CDS unless it is 3'-incomplete.
                self.assertEqual(layout.coord_max % 3, 0)
                self.assertIn(layout.coord_max // 3, (len(protein), len(protein) + 1))

                covered = set()
                for segment in layout.segments:
                    for nt in range(segment.coord_start, segment.coord_end + 1):
                        covered.add((nt - 1) // 3 + 1)
                self.assertEqual(covered, set(range(1, layout.coord_max // 3 + 1)))
                self.assertTrue(covered.issuperset(range(1, len(protein) + 1)))

    def test_segments_are_contiguous_in_cds_space(self):
        for case in self.cases:
            with self.subTest(case=case["case_id"]):
                _record, _protein, layout, _table = self._translate(case)
                for index in range(1, len(layout.segments)):
                    self.assertEqual(
                        layout.segments[index].coord_start,
                        layout.segments[index - 1].coord_end + 1,
                    )

    def test_genomic_anchors_read_back_the_right_codon(self):
        # Mirrors getGenomicAnchor() in FeatureExplorerProteinsPanel.jsx: the
        # nucleotides it points at must translate to the residue on screen.
        from Bio.Seq import Seq

        for case in self.cases:
            with self.subTest(case=case["case_id"]):
                record, protein, layout, table = self._translate(case)
                strand = record["strand"]
                # Skip amino acid 1: a leading partial codon starts outside the CDS,
                # and an initiation codon is reported as Met whatever the codon says.
                for aa_index in (2, len(protein)):
                    cds_nt = (aa_index - 1) * 3 + 1
                    anchor = None
                    for segment in layout.segments:
                        if segment.coord_start <= cds_nt <= segment.coord_end:
                            offset = cds_nt - segment.coord_start
                            anchor = (
                                segment.genomic_end - offset if strand == "-"
                                else segment.genomic_start + offset
                            )
                            break
                    self.assertIsNotNone(anchor, f"{case['case_id']}: aa {aa_index} has no anchor")
                    if strand == "-":
                        bases = self.fasta.fetch(record["chrom"], anchor - 3, anchor).upper()
                        bases = str(Seq(bases).reverse_complement())
                    else:
                        bases = self.fasta.fetch(record["chrom"], anchor - 1, anchor + 2).upper()
                    # Only the first base of the codon is guaranteed to be in this
                    # exon, so compare just where the codon is not split.
                    if len(bases) == 3 and "N" not in bases:
                        residue = str(Seq(bases).translate(table=table))
                        if residue != "*":
                            self.assertEqual(
                                residue, protein[aa_index - 1],
                                f"{case['case_id']}: aa {aa_index} anchor points at {bases}",
                            )


class TestManualAnnotationRobustness(TranslationFixtureTestCase):
    """Hand-made GFF3s are messier than provider files; translation should cope."""

    def _case(self, case_id):
        return next(case for case in self.cases if case["case_id"] == case_id)

    def test_missing_phase_is_treated_as_frame_zero(self):
        case = self._case("ensembl_complete_plus")
        record = self._indexed(case)
        stripped = [
            {key: value for key, value in cds.items() if key != "phase"}
            for cds in record["cds_list"]
        ]
        protein, _layout, _table = main._translate_transcript(
            self.fasta, record["chrom"], record["strand"], stripped, table=TABLE_STANDARD
        )
        self.assertEqual(protein, case["protein"])

    def test_duplicated_cds_lines_do_not_shift_the_frame(self):
        case = self._case("ensembl_complete_minus")
        record = self._indexed(case)
        duplicated = list(record["cds_list"]) + list(record["cds_list"])
        protein, _layout, _table = main._translate_transcript(
            self.fasta, record["chrom"], record["strand"], duplicated, table=TABLE_STANDARD
        )
        self.assertEqual(protein, case["protein"])

    def test_unsorted_cds_lines_are_ordered_before_translation(self):
        case = self._case("ensembl_five_prime_partial_phase1_minus")
        _record, expected, _layout, _table = self._translate(case)
        record = self._indexed(case)
        shuffled = list(reversed(record["cds_list"]))
        protein, _layout, _table = main._translate_transcript(
            self.fasta, record["chrom"], record["strand"], shuffled, table=TABLE_STANDARD
        )
        self.assertEqual(protein, expected)

    def test_cds_off_the_end_of_the_contig_does_not_shift_the_frame(self):
        # A manual annotation can point past the end of a scaffold; the missing
        # bases become N rather than silently dropping out of the sequence, so
        # everything up to that point still reads in frame.
        case = self._case("ensembl_complete_plus")
        record = self._indexed(case)
        length = self.fasta.get_reference_length(record["chrom"])
        cds_list = list(record["cds_list"]) + [{
            "feature_type": "CDS", "start": length - 2, "end": length + 30, "strand": "+",
        }]
        protein, _layout, _table = main._translate_transcript(
            self.fasta, record["chrom"], record["strand"], cds_list, table=TABLE_STANDARD
        )
        # The real CDS ended with a stop codon, which is now internal.
        self.assertTrue(protein.startswith(case["protein"] + "*"))
        self.assertIn("X", protein[len(case["protein"]) + 1:])


if __name__ == "__main__":
    unittest.main()

"""
Tests for CDS extraction and protein translation.

Uses real GRCh38 chr14 FASTA + GFF3 test data against well-characterised
MANE Select transcripts whose expected protein lengths are established in
UniProt:

  APEX1  ENST00000216714  +  318 aa  (UniProt P27695)
  PNP    ENST00000361505  +  289 aa  (UniProt P00491)
  TTC5   ENST00000258821  -  440 aa  (UniProt Q8ND56)

All three have multiple CDS exons with non-zero GFF3 phase values, so they
directly exercise the bug where _build_phase_aware_cds_segments was trimming
coding bases before translation.
"""

import sys
import unittest
from pathlib import Path

import pysam
from Bio.Seq import Seq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import _build_mode_segments, _ordered_five_to_three, _translate_cds  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FASTA_PATH = DATA_DIR / "GRCh38.chr14.fa"
GFF3_PATH = DATA_DIR / "GRCh38.chr14.gff3"

# chr name as stored in the FASTA (typically "14" for Ensembl, "chr14" for UCSC)
CHROM = "14"


def _parse_gff_attrs(attr_str: str) -> dict:
    result = {}
    for part in attr_str.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            result[k.strip()] = v.strip()
    return result


def _load_cds_list(transcript_id: str) -> list:
    """Return CDS dicts for *transcript_id* parsed directly from the GFF3."""
    cds_list = []
    with open(GFF3_PATH) as fh:
        for line in fh:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9 or parts[2] != "CDS":
                continue
            attrs = _parse_gff_attrs(parts[8])
            parent = attrs.get("Parent", "").replace("transcript:", "")
            if parent != transcript_id:
                continue
            phase_raw = parts[7].strip()
            item = {
                "feature_type": "CDS",
                "start": int(parts[3]),
                "end": int(parts[4]),
                "strand": parts[6],
            }
            if phase_raw in {"0", "1", "2"}:
                item["phase"] = int(phase_raw)
            cds_list.append(item)
    cds_list.sort(key=lambda x: x["start"])
    return cds_list


def _reference_protein(fasta, cds_list: list, strand: str, chrom: str = CHROM) -> str:
    """
    Compute protein by simple 5'→3' concatenation of all CDS bases — no phase
    trimming — then translate.  This is the ground-truth reference implementation
    used to validate _translate_cds.
    """
    ordered = _ordered_five_to_three(cds_list, strand)
    dna = ""
    for seg in ordered:
        raw = fasta.fetch(chrom, seg["start"] - 1, seg["end"]).upper()
        if strand == "-":
            raw = str(Seq(raw).reverse_complement())
        dna += raw

    trim = len(dna) - (len(dna) % 3)
    if trim == 0:
        return ""
    dna = dna[:trim]
    aa = str(Seq(dna).translate(to_stop=False))
    if aa.endswith("*"):
        aa = aa[:-1]
    return aa


@unittest.skipUnless(FASTA_PATH.exists() and GFF3_PATH.exists(), "Test data not available")
class TestCdsLength(unittest.TestCase):
    """Verify that the raw CDS base-counts add up to the expected coding length."""

    def _cds_total_bp(self, cds_list):
        return sum(seg["end"] - seg["start"] + 1 for seg in cds_list)

    def test_apex1_cds_bp(self):
        cds = _load_cds_list("ENST00000216714")
        self.assertEqual(len(cds), 4)
        # 318 AA + stop = 319 codons = 957 bp
        self.assertEqual(self._cds_total_bp(cds), 957)

    def test_pnp_cds_bp(self):
        cds = _load_cds_list("ENST00000361505")
        self.assertEqual(len(cds), 6)
        # 289 AA + stop = 290 codons = 870 bp
        self.assertEqual(self._cds_total_bp(cds), 870)

    def test_ttc5_cds_bp(self):
        cds = _load_cds_list("ENST00000258821")
        self.assertEqual(len(cds), 10)
        # 440 AA + stop = 441 codons = 1323 bp
        self.assertEqual(self._cds_total_bp(cds), 1323)


@unittest.skipUnless(FASTA_PATH.exists() and GFF3_PATH.exists(), "Test data not available")
class TestProteinTranslation(unittest.TestCase):
    """
    End-to-end tests: _translate_cds must produce the correct protein.

    For each MANE Select transcript we check:
      1. Length matches the UniProt reference.
      2. Sequence starts with Met (M).
      3. No internal stop codons (clean ORF).
      4. Sequence is identical to the phase-unaware reference implementation.
    """

    @classmethod
    def setUpClass(cls):
        cls.fasta = pysam.FastaFile(str(FASTA_PATH))

    @classmethod
    def tearDownClass(cls):
        cls.fasta.close()

    # ── helpers ──────────────────────────────────────────────────────────────

    def _check_transcript(self, tx_id, strand, expected_len, label):
        cds_list = _load_cds_list(tx_id)
        self.assertTrue(cds_list, f"{label}: CDS list must not be empty")

        protein = _translate_cds(self.fasta, CHROM, strand, cds_list)

        with self.subTest(check="length"):
            self.assertEqual(
                len(protein), expected_len,
                f"{label}: expected {expected_len} AA, got {len(protein)}"
                + (f" ({protein[:30]}...)" if protein else ""),
            )
        with self.subTest(check="starts_with_Met"):
            self.assertTrue(protein.startswith("M"), f"{label}: must start with Met, got {protein[:5]}")
        with self.subTest(check="no_internal_stop"):
            self.assertNotIn("*", protein, f"{label}: unexpected internal stop codon")
        with self.subTest(check="matches_reference"):
            ref = _reference_protein(self.fasta, cds_list, strand)
            self.assertEqual(
                protein, ref,
                f"{label}: _translate_cds disagrees with reference concatenation.\n"
                f"  _translate_cds : len={len(protein)} {protein[:40]}...\n"
                f"  reference      : len={len(ref)} {ref[:40]}...",
            )

    # ── per-transcript tests ──────────────────────────────────────────────────

    def test_apex1_mane_select(self):
        """APEX1 ENST00000216714 (+), 4 CDS exons, phases 0,2,0,2 → 318 AA (P27695)."""
        self._check_transcript("ENST00000216714", "+", 318, "APEX1")

    def test_pnp_mane_select(self):
        """PNP ENST00000361505 (+), 6 CDS exons, phases 0,1,2,0,1,2 → 289 AA (P00491)."""
        self._check_transcript("ENST00000361505", "+", 289, "PNP")

    def test_ttc5_mane_select_minus_strand(self):
        """TTC5 ENST00000258821 (-), 10 CDS exons, various phases → 440 AA (Q8ND56)."""
        self._check_transcript("ENST00000258821", "-", 440, "TTC5")


@unittest.skipUnless(FASTA_PATH.exists() and GFF3_PATH.exists(), "Test data not available")
class TestCdsSegmentsAlignment(unittest.TestCase):
    """
    Verify that the CDS segments returned alongside the protein sequence have
    coord ranges that correctly cover every amino acid in the protein.

    _build_mode_segments produces 1-based nucleotide coordinates in CDS space.
    The frontend converts these to amino-acid positions via floor((nt-1)/3)+1,
    so every amino acid 1..L must be covered by at least one segment.
    """

    @classmethod
    def setUpClass(cls):
        cls.fasta = pysam.FastaFile(str(FASTA_PATH))

    @classmethod
    def tearDownClass(cls):
        cls.fasta.close()

    def _check_segment_coverage(self, tx_id, strand, label):
        cds_list = _load_cds_list(tx_id)
        protein = _translate_cds(self.fasta, CHROM, strand, cds_list)
        self.assertTrue(protein, f"{label}: empty protein")

        _, _, segments, status = _build_mode_segments(1, 1, strand, [], cds_list, "cds")
        self.assertEqual(status, "ok")
        self.assertTrue(segments)

        # Build per-AA exon index exactly as the frontend does
        seq_len = len(protein)
        covered = [False] * seq_len
        for seg in segments:
            first_aa = (seg["coord_start"] - 1) // 3 + 1
            last_aa = (seg["coord_end"] - 1) // 3 + 1
            for aa in range(first_aa, min(last_aa, seq_len) + 1):
                covered[aa - 1] = True

        uncovered = [i + 1 for i, c in enumerate(covered) if not c]
        self.assertEqual(
            uncovered, [],
            f"{label}: amino acid positions not covered by any segment: {uncovered[:10]}",
        )

        # Segments must be contiguous and non-overlapping in coord space
        for i in range(1, len(segments)):
            prev_end = segments[i - 1]["coord_end"]
            cur_start = segments[i]["coord_start"]
            self.assertEqual(
                cur_start, prev_end + 1,
                f"{label}: segment gap between seg {i-1} end={prev_end} and seg {i} start={cur_start}",
            )

    def test_apex1_segment_coverage(self):
        self._check_segment_coverage("ENST00000216714", "+", "APEX1")

    def test_pnp_segment_coverage(self):
        self._check_segment_coverage("ENST00000361505", "+", "PNP")

    def test_ttc5_segment_coverage(self):
        self._check_segment_coverage("ENST00000258821", "-", "TTC5")


if __name__ == "__main__":
    unittest.main()

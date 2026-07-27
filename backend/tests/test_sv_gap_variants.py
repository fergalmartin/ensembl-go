import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import _build_sv_gap_variants  # noqa: E402


class StructuralVariationGapVariantTests(unittest.TestCase):
    def test_derives_deletion_from_larger_reference_gap(self):
        blocks = [
            {"chain_id": "c1", "strand": "+", "ref_start": 100, "ref_end": 149, "tgt_start": 200, "tgt_end": 249},
            {"chain_id": "c1", "strand": "+", "ref_start": 160, "ref_end": 210, "tgt_start": 250, "tgt_end": 300},
        ]

        variants = _build_sv_gap_variants(blocks, "1", 90, 220)

        self.assertEqual(len(variants), 1)
        self.assertEqual(variants[0]["type"], "deletion")
        self.assertEqual(variants[0]["location"]["start"], 150)
        self.assertEqual(variants[0]["location"]["end"], 159)

    def test_derives_insertion_from_larger_target_gap(self):
        blocks = [
            {"chain_id": "c1", "strand": "+", "ref_start": 100, "ref_end": 149, "tgt_start": 200, "tgt_end": 249},
            {"chain_id": "c1", "strand": "+", "ref_start": 150, "ref_end": 210, "tgt_start": 270, "tgt_end": 330},
        ]

        variants = _build_sv_gap_variants(blocks, "1", 90, 220)

        self.assertEqual(len(variants), 1)
        self.assertEqual(variants[0]["type"], "insertion")
        self.assertEqual(variants[0]["location"]["start"], 149)
        self.assertEqual(variants[0]["location"]["end"], 149)

    def test_derives_snv_for_single_base_balanced_gap(self):
        blocks = [
            {"chain_id": "c1", "strand": "+", "ref_start": 100, "ref_end": 149, "tgt_start": 200, "tgt_end": 249},
            {"chain_id": "c1", "strand": "+", "ref_start": 151, "ref_end": 210, "tgt_start": 251, "tgt_end": 310},
        ]

        variants = _build_sv_gap_variants(blocks, "1", 90, 220)

        self.assertEqual(len(variants), 1)
        self.assertEqual(variants[0]["type"], "snv")
        self.assertEqual(variants[0]["location"]["start"], 150)
        self.assertEqual(variants[0]["location"]["end"], 150)
        self.assertEqual(variants[0]["ref_length"], 1)
        self.assertEqual(variants[0]["alt_length"], 1)


if __name__ == "__main__":
    unittest.main()

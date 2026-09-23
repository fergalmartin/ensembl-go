import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from download_manager import _classify_species  # noqa: E402
from taxonomy_classifier import TaxonomyLineageClassifier  # noqa: E402


def _artifact_for(lineages):
    return {
        "schema_version": 1,
        "taxids": {
            str(taxid): {
                "resolved_taxid": taxid,
                "lineage": lineage,
                "rank": "species",
                "scientific_name": f"Species {taxid}",
            }
            for taxid, lineage in lineages.items()
        },
        "merged_taxids": {},
    }


class TaxonomyLineageClassifierTests(unittest.TestCase):
    def setUp(self):
        base = [1, 131567, 2759]
        metazoa = base + [33208]
        self.classifier = TaxonomyLineageClassifier(artifact=_artifact_for({
            1001: metazoa + [6656, 50557, 7041, 1001],
            1002: metazoa + [6656, 50557, 7147, 1002],
            1003: metazoa + [6656, 50557, 7088, 1003],
            1004: metazoa + [6656, 50557, 7399, 1004],
            1005: metazoa + [40674, 9443, 1005],
            1006: metazoa + [8782, 1006],
            1007: metazoa + [1294634, 1007],
            1008: metazoa + [8292, 1008],
            1009: metazoa + [7898, 1009],
            1010: base + [33090, 4479, 1010],
            1011: base + [4751, 1011],
            1012: [1, 131567, 2, 1012],
            1013: [1, 131567, 2157, 1013],
            1014: base + [33630, 1014],
            1015: metazoa + [6447, 1015],
            1016: [1, 131567, 1016],
            1017: metazoa + [40674, 1017],
            1018: metazoa + [7711, 7742, 1018],
            1019: metazoa + [40674, 9397, 1019],
            1020: metazoa + [40674, 9362, 1020],
            1021: metazoa + [40674, 9263, 1021],
            1022: metazoa + [40674, 33554, 1022],
            1023: metazoa + [40674, 91561, 1023],
            1024: metazoa + [40674, 9787, 1024],
            1025: metazoa + [40674, 9975, 1025],
            1026: metazoa + [40674, 9254, 9255, 1026],
            1027: metazoa + [40674, 311790, 1027],
            1028: metazoa + [40674, 9348, 1028],
            1029: metazoa + [40674, 9971, 1029],
            # Real lineage shapes from the current NCBI taxonomy, for the cases that
            # used to be misfiled.
            1030: metazoa + [7711, 7742, 8287, 32523, 8457, 32561, 1329799, 8459, 1030],  # turtle
            1031: metazoa + [6656, 197563, 197562, 3701028, 3701029, 6681, 1031],       # shrimp
            1032: metazoa + [6656, 197563, 197562, 3701028, 3701030, 6658, 1032],       # Daphnia
            1033: metazoa + [6656, 197563, 197562, 3701028, 3701030, 6960, 30001, 1033],# springtail
            1034: base + [3027, 589342, 1034],                                          # Guillardia
            1035: metazoa + [7711, 7742, 7745, 1035],                                    # lamprey
        }))

    def _classify(self, taxid, scientific_name="Species example", common_name=""):
        return self.classifier.classify(
            scientific_name,
            common_name,
            taxid,
            taxid,
            fallback_classifier=_classify_species,
        )

    def test_insect_subgroups_use_lineage(self):
        self.assertEqual((self._classify(1001).group, self._classify(1001).sub_group), ("Insects", "Beetles"))
        self.assertEqual((self._classify(1002).group, self._classify(1002).sub_group), ("Insects", "Flies"))
        self.assertEqual((self._classify(1003).group, self._classify(1003).sub_group), ("Insects", "Moths"))
        self.assertEqual((self._classify(1004).group, self._classify(1004).sub_group), ("Insects", "Bees & Wasps"))

    def test_major_clades_use_lineage(self):
        expectations = {
            1005: ("Mammals", "Primates"),
            1006: ("Birds", None),
            1007: ("Reptiles", None),
            1008: ("Amphibians", None),
            1009: ("Fish", None),
            1010: ("Plants", "Cereals"),
            1011: ("Microbes", "Fungi & Yeasts"),
            1012: ("Microbes", "Bacteria"),
            1013: ("Microbes", "Archaea"),
            1014: ("Microbes", "Protists"),
            1015: ("Other Invertebrates", "Molluscs"),
            1018: ("Fish", None),
            1019: ("Mammals", "Bats"),
            1020: ("Mammals", "True insectivores"),
            1021: ("Mammals", "Marsupials"),
            1022: ("Mammals", "Carnivores"),
            1023: ("Mammals", "Even-toed ungulates & whales"),
            1024: ("Mammals", "Odd-toed ungulates"),
            1025: ("Mammals", "Rabbits & hares"),
            1026: ("Mammals", "Monotremes"),
            1027: ("Mammals", "Afrotheria"),
            1028: ("Mammals", "Xenarthra"),
            1029: ("Mammals", "Pangolins"),
        }
        for taxid, expected in expectations.items():
            result = self._classify(taxid)
            self.assertEqual((result.group, result.sub_group), expected)
            self.assertEqual(result.source, "lineage")

    def test_previously_misfiled_clades(self):
        expectations = {
            1030: ("Reptiles", None),
            1031: ("Other Invertebrates", "Crustaceans"),
            1032: ("Other Invertebrates", "Crustaceans"),
            1033: ("Other Invertebrates", "Other"),
            1034: ("Microbes", "Protists"),
            1035: ("Fish", None),
        }
        for taxid, expected in expectations.items():
            result = self._classify(taxid)
            self.assertEqual((result.group, result.sub_group), expected, taxid)

    def test_missing_lineage_uses_legacy_heuristic(self):
        result = self._classify(9999, scientific_name="Missing species", common_name="fruit fly")
        self.assertEqual((result.group, result.sub_group), ("Insects", "Flies"))
        self.assertEqual(result.source, "heuristic")
        self.assertEqual(result.missing_taxids, (9999,))

    def test_unknown_lineage_remains_other(self):
        result = self._classify(1016)
        self.assertEqual((result.group, result.sub_group), ("Other", None))
        self.assertEqual(result.source, "lineage_unclassified")

    def test_domestic_mammals_stay_in_other_mammals(self):
        result = self._classify(1017, scientific_name="Bos taurus")
        self.assertEqual((result.group, result.sub_group), ("Mammals", "Other Mammals"))
        self.assertEqual(result.source, "lineage")

    def test_legacy_misleading_mammal_common_names_stay_other(self):
        self.assertEqual(
            _classify_species("Tupaia chinensis", "Chinese tree shrew", 0, 0),
            ("Mammals", "Other Mammals"),
        )
        self.assertEqual(
            _classify_species("Cynocephalus volans", "Philippine flying lemur", 0, 0),
            ("Mammals", "Other Mammals"),
        )


if __name__ == "__main__":
    unittest.main()

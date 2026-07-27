import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(BACKEND_DIR / "scripts"))

from generate_taxonomy_classification import _audit_catalog, _build_artifact  # noqa: E402


def _add_tar_text(archive, name, text):
    data = text.encode("utf-8")
    info = tarfile.TarInfo(name)
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))


class TaxonomyGeneratorTests(unittest.TestCase):
    def test_builds_compact_artifact_and_audit_report(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            catalog = root / "species.json"
            taxdump = root / "taxdump.tar.gz"
            catalog.write_text(json.dumps({
                "last_updated": "2026-03-25T09:15:00Z",
                "species": {
                    "Ground_beetle": {
                        "taxid": 1001,
                        "species_taxonomy_id": 1001,
                        "scientific_name": "Abax parallelepipedus",
                        "common_name": "",
                        "assemblies": {},
                    },
                    "Mystery_species": {
                        "taxid": 9999,
                        "species_taxonomy_id": 9999,
                        "scientific_name": "Mystery species",
                        "common_name": "",
                        "assemblies": {},
                    },
                },
            }), encoding="utf-8")

            with tarfile.open(taxdump, "w:gz") as archive:
                _add_tar_text(archive, "nodes.dmp", "".join([
                    "1\t|\t1\t|\tno rank\t|\n",
                    "131567\t|\t1\t|\tno rank\t|\n",
                    "2759\t|\t131567\t|\tsuperkingdom\t|\n",
                    "33208\t|\t2759\t|\tkingdom\t|\n",
                    "6656\t|\t33208\t|\tphylum\t|\n",
                    "50557\t|\t6656\t|\tclass\t|\n",
                    "7041\t|\t50557\t|\torder\t|\n",
                    "1001\t|\t7041\t|\tspecies\t|\n",
                ]))
                _add_tar_text(archive, "names.dmp", "".join([
                    "1\t|\troot\t|\t\t|\tscientific name\t|\n",
                    "7041\t|\tColeoptera\t|\t\t|\tscientific name\t|\n",
                    "1001\t|\tAbax parallelepipedus\t|\t\t|\tscientific name\t|\n",
                ]))
                _add_tar_text(archive, "merged.dmp", "")

            artifact = _build_artifact(catalog, taxdump)
            audit = _audit_catalog(catalog, artifact)

        self.assertIn("1001", artifact["taxids"])
        self.assertEqual(artifact["taxids"]["1001"]["lineage"][-2:], [7041, 1001])
        self.assertIn(9999, artifact["coverage"]["missing_taxids"])
        self.assertEqual(audit["species_count"], 2)
        self.assertEqual(audit["legacy_other_count"], 2)
        self.assertEqual(audit["new_other_count"], 1)
        self.assertEqual(audit["new_group_counts"]["Insects"], 1)


if __name__ == "__main__":
    unittest.main()

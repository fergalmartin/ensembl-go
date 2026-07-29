import sys
import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from main import _list_sv_datasets, _select_sv_dataset, _sv_public_dataset, _sv_records_match, _sv_registry_cache  # noqa: E402


class StructuralVariationDatasetSelectionTests(unittest.TestCase):
    """Selection rules for the built-in structural-variation datasets.

    The built-ins are development fixtures gated behind
    ENSEMBL_GO_SV_TEST_DATA_DIR, which is unset in a normal checkout. Without
    enabling them here every lookup returns None, which fails the positive cases
    and lets the negative ones pass for the wrong reason. Selection is pure
    metadata matching, so the fixture files themselves are not needed.
    """

    def setUp(self):
        patcher = patch.object(main, "SV_BUILTIN_DATASETS_ENABLED", True)
        patcher.start()
        self.addCleanup(patcher.stop)
        # The registry cache is module-global; clear it on the way in and out so
        # neither this class nor anything after it sees a stale dataset list.
        _sv_registry_cache["signature"] = None
        self.addCleanup(_sv_registry_cache.__setitem__, "signature", None)

    def test_selects_grch38_dataset_from_accessions(self):
        dataset = _select_sv_dataset("GCA_000001405.29", "GCA_018472595.2")
        self.assertIsNotNone(dataset)
        self.assertEqual(dataset["label"], "GRCh38 vs HG00438")

    def test_selects_grch38_dataset_from_refseq_alias(self):
        dataset = _select_sv_dataset("GCF_000001405.40", "HG00438_pat_hprc_f2")
        self.assertIsNotNone(dataset)
        self.assertEqual(dataset["label"], "GRCh38 vs HG00438")

    def test_selects_grch38_hg00733_dataset_from_uuid_alias(self):
        dataset = _select_sv_dataset("GCA_000001405.29", "0fb76cdf-6c6b-4c20-beef-7f7d4151651b")
        self.assertIsNotNone(dataset)
        self.assertEqual(dataset["label"], "GRCh38 vs HG00733")

    def test_selects_grch38_hg00733_dataset_from_name_alias(self):
        dataset = _select_sv_dataset("GRCh38.p14", "HG00733_mat_hprc_f2")
        self.assertIsNotNone(dataset)
        self.assertEqual(dataset["label"], "GRCh38 vs HG00733")

    def test_selects_grch38_hg00733_dataset_from_hal_name_alias(self):
        dataset = _select_sv_dataset("GRCh38.p14", "HG00733.2")
        self.assertIsNotNone(dataset)
        self.assertEqual(dataset["label"], "GRCh38 vs HG00733")

    def test_does_not_select_grch38_hg00733_dataset_from_bare_sample_alias(self):
        dataset = _select_sv_dataset("GRCh38.p14", "HG00733")
        self.assertIsNone(dataset)

    def test_does_not_select_grch38_hg00733_dataset_from_paternal_alias(self):
        dataset = _select_sv_dataset("GRCh38.p14", "HG00733_pat_hprc_f2")
        self.assertIsNone(dataset)

    def test_does_not_select_grch38_hg00733_dataset_from_paternal_accession(self):
        dataset = _select_sv_dataset("GRCh38.p14", "GCA_018506955.2")
        self.assertIsNone(dataset)

    def test_selects_chm13_dataset_from_refseq_alias(self):
        dataset = _select_sv_dataset("GCF_009914755.1", "GCA_018472595.2")
        self.assertIsNotNone(dataset)
        self.assertEqual(dataset["label"], "T2T-CHM13v2.0 vs HG00438")

    def test_generic_species_aliases_do_not_match_different_human_assemblies(self):
        grch38 = {
            "provider": "ensembl",
            "species_key": "Homo_sapiens",
            "assembly": "GCA_000001405.29",
            "assembly_name": "GRCh38.p14",
            "display_name": "Human",
            "common_name": "Human",
            "scientific_name": "Homo sapiens",
            "aliases": ["GRCh38", "Human", "Homo sapiens"],
        }
        hg00438 = {
            "provider": "ensembl",
            "species_key": "Homo_sapiens",
            "assembly": "GCA_018472595.2",
            "assembly_name": "HG00438_pat_hprc_f2",
            "display_name": "Human",
            "common_name": "Human",
            "scientific_name": "Homo sapiens",
            "aliases": ["HG00438", "Human", "Homo sapiens"],
        }

        self.assertFalse(_sv_records_match(grch38, hg00438))
        self.assertTrue(_sv_records_match(grch38, {**grch38}))

    def test_selects_registered_alignment_by_id_and_aliases(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local_data = root / "local_data"
            local_data.mkdir()
            chain = root / "custom.bigChain.bb"
            ref_map = root / "ref.hal_mapping.tsv"
            tgt_map = root / "target.hal_mapping.tsv"
            chain.write_bytes(b"placeholder")
            ref_map.write_text("hal_genome_name\tassembly_uuid\thal_sequence_name\tassembly_sequence\nref\tref-uuid\tchr1\t1\n", encoding="utf-8")
            tgt_map.write_text("hal_genome_name\tassembly_uuid\thal_sequence_name\tassembly_sequence\ntgt\ttgt-uuid\tchr1\t1\n", encoding="utf-8")
            (local_data / "sv_alignment_registry.json").write_text(json.dumps({
                "alignments": [{
                    "id": "registered_ref_to_target",
                    "label": "Registered Ref To Target",
                    "chain_path": str(chain),
                    "ref_mapping_path": str(ref_map),
                    "tgt_mapping_path": str(tgt_map),
                    "reference_genome": {
                        "assembly": "GCA_111111111.1",
                        "assembly_name": "CustomRef",
                        "aliases": ["CustomRefAlias"],
                    },
                    "target_genome": {
                        "assembly": "GCA_222222222.1",
                        "assembly_name": "CustomTarget",
                        "aliases": ["CustomTargetAlias"],
                    },
                    "indexed_side": "target",
                }]
            }), encoding="utf-8")

            _sv_registry_cache["signature"] = None
            dataset = _select_sv_dataset("CustomRefAlias", "CustomTargetAlias", output_dir=tmp)
            self.assertIsNotNone(dataset)
            self.assertEqual(dataset["id"], "registered_ref_to_target")

            by_id = _select_sv_dataset("anything", "else", alignment_id="registered_ref_to_target", output_dir=tmp)
            self.assertIsNotNone(by_id)
            self.assertEqual(by_id["label"], "Registered Ref To Target")

    def test_registered_alignment_edges_are_directed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local_data = root / "local_data"
            local_data.mkdir()
            chain = root / "custom.bigChain.bb"
            ref_map = root / "ref.hal_mapping.tsv"
            tgt_map = root / "target.hal_mapping.tsv"
            chain.write_bytes(b"placeholder")
            ref_map.write_text("hal_genome_name\tassembly_uuid\thal_sequence_name\tassembly_sequence\nref\tref-uuid\tchr1\t1\n", encoding="utf-8")
            tgt_map.write_text("hal_genome_name\tassembly_uuid\thal_sequence_name\tassembly_sequence\ntgt\ttgt-uuid\tchr1\t1\n", encoding="utf-8")
            (local_data / "sv_alignment_registry.json").write_text(json.dumps({
                "alignments": [{
                    "id": "directed_only",
                    "chain_path": str(chain),
                    "ref_mapping_path": str(ref_map),
                    "tgt_mapping_path": str(tgt_map),
                    "reference_genome": {"assembly_name": "AnchorA", "aliases": ["AnchorA"]},
                    "target_genome": {"assembly_name": "TargetB", "aliases": ["TargetB"]},
                }]
            }), encoding="utf-8")

            _sv_registry_cache["signature"] = None
            self.assertIsNotNone(_select_sv_dataset("AnchorA", "TargetB", output_dir=tmp))
            self.assertIsNone(_select_sv_dataset("TargetB", "AnchorA", output_dir=tmp))

    def test_registered_alignment_preserves_optional_target_tracks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local_data = root / "local_data"
            local_data.mkdir()
            chain = root / "custom.bigChain.bb"
            ref_map = root / "ref.hal_mapping.tsv"
            tgt_map = root / "target.hal_mapping.tsv"
            target_bw = root / "target.bw"
            target_bb = root / "target.bb"
            chain.write_bytes(b"placeholder")
            target_bw.write_bytes(b"placeholder")
            target_bb.write_bytes(b"placeholder")
            ref_map.write_text("hal_genome_name\tassembly_uuid\thal_sequence_name\tassembly_sequence\nref\tref-uuid\tchr1\t1\n", encoding="utf-8")
            tgt_map.write_text("hal_genome_name\tassembly_uuid\thal_sequence_name\tassembly_sequence\ntgt\ttgt-uuid\tchr1\t1\n", encoding="utf-8")
            (local_data / "sv_alignment_registry.json").write_text(json.dumps({
                "alignments": [{
                    "id": "with_tracks",
                    "chain_path": str(chain),
                    "ref_mapping_path": str(ref_map),
                    "tgt_mapping_path": str(tgt_map),
                    "target_bigwig_path": str(target_bw),
                    "target_bigbed_path": str(target_bb),
                    "reference_genome": {"assembly_name": "AnchorA", "aliases": ["AnchorA"]},
                    "target_genome": {"assembly_name": "TargetB", "aliases": ["TargetB"]},
                }]
            }), encoding="utf-8")

            _sv_registry_cache["signature"] = None
            dataset = _select_sv_dataset("AnchorA", "TargetB", output_dir=tmp)
            self.assertIsNotNone(dataset)
            public = _sv_public_dataset(dataset)
            target_tracks = public["tracks"]["target"]
            self.assertEqual([track["type"] for track in target_tracks], ["bigwig", "bigbed"])
            self.assertTrue(all(track["file"]["exists"] for track in target_tracks))

    def test_scanned_bundle_with_unresolved_maps_reports_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            scan_dir = Path(tmp) / "local_data" / "sv_alignments"
            scan_dir.mkdir(parents=True)
            (scan_dir / "unresolved.bigChain.bb").write_bytes(b"placeholder")

            _sv_registry_cache["signature"] = None
            datasets, incomplete = _list_sv_datasets(tmp)
            self.assertTrue(any(item.get("path", "").endswith("unresolved.bigChain.bb") for item in incomplete))
            self.assertTrue(any(dataset.get("source") == "builtin" for dataset in datasets))


if __name__ == "__main__":
    unittest.main()

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sv_config import (  # noqa: E402
    CONFIG_VERSION_KEY,
    config_to_datasets,
    datasets_to_config,
    derive_sequence_map,
    has_errors,
    locate_pointer_lines,
    merge_sv_config,
    migrate_legacy_registry,
    parse_sv_config,
    remove_alignment,
    serialize_sv_config,
)


def minimal_config(**overrides):
    config = {
        CONFIG_VERSION_KEY: 1,
        "genomes": {
            "GRCh38": {"accession": "GCA_000001405.29", "assembly_name": "GRCh38.p14"},
            "HG00438.pat": {"accession": "GCA_018472595.2", "assembly_name": "HG00438_pat_hprc_f2"},
        },
        "pairs": [{
            "genomes": ["GRCh38", "HG00438.pat"],
            "alignments": [{
                "label": "GRCh38 to HG00438.pat",
                "reference": "GRCh38",
                "target": "HG00438.pat",
                "chain": "alt_a_to_ref_b.bigChain.bb",
            }],
        }],
    }
    config.update(overrides)
    return config


def errors(diagnostics):
    return [item for item in diagnostics if item["severity"] == "error"]


def warnings(diagnostics):
    return [item for item in diagnostics if item["severity"] == "warning"]


class ParseTests(unittest.TestCase):
    def test_parses_a_minimal_config(self):
        config, diagnostics = parse_sv_config(json.dumps(minimal_config()))
        self.assertEqual(diagnostics, [])
        self.assertEqual(sorted(config["genomes"]), ["GRCh38", "HG00438.pat"])
        alignment = config["pairs"][0]["alignments"][0]
        self.assertEqual(alignment["reference"], "GRCh38")
        self.assertEqual(alignment["id"], "grch38_to_hg00438_pat")

    def test_invalid_json_reports_the_line(self):
        config, diagnostics = parse_sv_config('{\n  "genomes": {,\n}')
        self.assertTrue(has_errors(diagnostics))
        self.assertEqual(config["pairs"], [])
        self.assertGreater(diagnostics[0]["line"], 0)

    def test_empty_text_is_an_error_not_a_crash(self):
        _config, diagnostics = parse_sv_config("   ")
        self.assertTrue(has_errors(diagnostics))

    def test_root_must_be_an_object(self):
        _config, diagnostics = parse_sv_config("[]")
        self.assertTrue(has_errors(diagnostics))

    def test_duplicate_label_is_an_error_naming_the_second_use(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"].append({
            "label": "grch38 TO hg00438.PAT",
            "reference": "HG00438.pat",
            "target": "GRCh38",
            "chain": "ref_b_to_alt_a.bigChain.bb",
        })
        _config, diagnostics = parse_sv_config(json.dumps(payload))
        found = errors(diagnostics)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["pointer"], "pairs/0/alignments/1/label")
        self.assertIn("must be unique", found[0]["message"])

    def test_unknown_genome_handle_lists_what_is_declared(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0]["target"] = "HG00733"
        _config, diagnostics = parse_sv_config(json.dumps(payload))
        found = errors(diagnostics)
        self.assertEqual(found[0]["pointer"], "pairs/0/alignments/0/target")
        self.assertIn("GRCh38", found[0]["message"])

    def test_reference_and_target_must_differ(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0]["target"] = "GRCh38"
        _config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertTrue(any("must be different" in item["message"] for item in errors(diagnostics)))

    def test_missing_chain_and_label_are_errors(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0].pop("chain")
        payload["pairs"][0]["alignments"][0].pop("label")
        _config, diagnostics = parse_sv_config(json.dumps(payload))
        pointers = {item["pointer"] for item in errors(diagnostics)}
        self.assertIn("pairs/0/alignments/0/chain", pointers)
        self.assertIn("pairs/0/alignments/0/label", pointers)

    def test_genome_without_accession_is_an_error(self):
        payload = minimal_config()
        payload["genomes"]["GRCh38"] = {"assembly_name": "GRCh38.p14"}
        _config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertTrue(any(item["pointer"] == "genomes/GRCh38/accession" for item in errors(diagnostics)))

    def test_relative_paths_resolve_against_the_config_directory(self):
        base = Path("/data/hprc")
        config, diagnostics = parse_sv_config(json.dumps(minimal_config()), base_dir=base)
        self.assertEqual(diagnostics, [])
        chain = config["pairs"][0]["alignments"][0]["chain"]
        self.assertEqual(chain, str(base / "alt_a_to_ref_b.bigChain.bb"))

    def test_absolute_paths_are_left_alone(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0]["chain"] = "/elsewhere/x.bigChain.bb"
        config, _diagnostics = parse_sv_config(json.dumps(payload), base_dir=Path("/data/hprc"))
        self.assertEqual(config["pairs"][0]["alignments"][0]["chain"], "/elsewhere/x.bigChain.bb")

    def test_flat_alignment_list_shorthand_is_accepted(self):
        payload = {
            CONFIG_VERSION_KEY: 1,
            "genomes": minimal_config()["genomes"],
            "alignments": minimal_config()["pairs"][0]["alignments"],
        }
        config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertEqual(diagnostics, [])
        self.assertEqual(len(config["pairs"]), 1)
        self.assertEqual(sorted(config["pairs"][0]["genomes"]), ["GRCh38", "HG00438.pat"])

    def test_pair_genomes_are_derived_when_omitted(self):
        payload = minimal_config()
        payload["pairs"][0].pop("genomes")
        config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertEqual(diagnostics, [])
        self.assertEqual(config["pairs"][0]["genomes"], ["GRCh38", "HG00438.pat"])

    def test_a_newer_version_warns_but_still_loads(self):
        payload = minimal_config()
        payload[CONFIG_VERSION_KEY] = 99
        config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertFalse(has_errors(diagnostics))
        self.assertEqual(len(warnings(diagnostics)), 1)
        self.assertEqual(len(config["pairs"][0]["alignments"]), 1)


class IndexedSideTests(unittest.TestCase):
    def test_inferred_from_the_alt_to_ref_naming_convention(self):
        config, diagnostics = parse_sv_config(json.dumps(minimal_config()))
        self.assertEqual(diagnostics, [])
        alignment = config["pairs"][0]["alignments"][0]
        self.assertEqual(alignment["indexed_side"], "")
        self.assertEqual(alignment["inferred_indexed_side"], "target")
        dataset = config_to_datasets(config)[0]
        self.assertEqual(dataset["indexed_side"], "target")

    def test_inferred_from_the_ref_to_alt_naming_convention(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0]["chain"] = "ref_b_to_alt_a.bigChain.bb"
        config, _diagnostics = parse_sv_config(json.dumps(payload))
        self.assertEqual(config_to_datasets(config)[0]["indexed_side"], "reference")

    def test_defaults_to_target_when_the_name_says_nothing(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0]["chain"] = "chains/whatever.bigChain.bb"
        config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertEqual(diagnostics, [])
        self.assertEqual(config_to_datasets(config)[0]["indexed_side"], "target")

    def test_explicit_value_disagreeing_with_the_filename_warns_but_is_honoured(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0]["indexed_side"] = "reference"
        config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertFalse(has_errors(diagnostics))
        self.assertEqual(len(warnings(diagnostics)), 1)
        self.assertIn("indexed_side", warnings(diagnostics)[0]["pointer"])
        self.assertEqual(config_to_datasets(config)[0]["indexed_side"], "reference")

    def test_nonsense_value_is_an_error(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0]["indexed_side"] = "sideways"
        _config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertTrue(any(item["pointer"].endswith("indexed_side") for item in errors(diagnostics)))


class TrackTests(unittest.TestCase):
    def test_genome_tracks_apply_to_every_alignment_of_that_genome(self):
        payload = minimal_config()
        payload["genomes"]["HG00438.pat"]["tracks"] = [
            {"label": "Read depth", "path": "tracks/hg00438.bw"},
            "tracks/hg00438.bb",
        ]
        payload["pairs"][0]["alignments"].append({
            "label": "HG00438.pat to GRCh38",
            "reference": "HG00438.pat",
            "target": "GRCh38",
            "chain": "ref_b_to_alt_a.bigChain.bb",
        })
        config, diagnostics = parse_sv_config(json.dumps(payload), base_dir=Path("/data"))
        self.assertEqual(diagnostics, [])
        forward, reverse = config_to_datasets(config)

        self.assertEqual([t["type"] for t in forward["tracks"]["target"]], ["bigwig", "bigbed"])
        self.assertEqual(forward["tracks"]["reference"], [])
        # The same genome is the reference in the reverse alignment, so its tracks
        # move to that side rather than being declared twice.
        self.assertEqual([t["type"] for t in reverse["tracks"]["reference"]], ["bigwig", "bigbed"])
        self.assertEqual(reverse["tracks"]["target"], [])
        self.assertEqual(forward["tracks"]["target"][0]["label"], "Read depth")
        self.assertEqual(forward["tracks"]["target"][1]["label"], "SV intervals")

    def test_alignment_tracks_are_added_on_top_of_genome_tracks(self):
        payload = minimal_config()
        payload["genomes"]["HG00438.pat"]["tracks"] = ["tracks/shared.bw"]
        payload["pairs"][0]["alignments"][0]["tracks"] = {"HG00438.pat": ["tracks/extra.bb"]}
        config, diagnostics = parse_sv_config(json.dumps(payload), base_dir=Path("/data"))
        self.assertEqual(diagnostics, [])
        dataset = config_to_datasets(config)[0]
        self.assertEqual(
            [Path(t["path"]).name for t in dataset["tracks"]["target"]],
            ["shared.bw", "extra.bb"],
        )

    def test_a_track_repeated_at_both_levels_appears_once(self):
        payload = minimal_config()
        payload["genomes"]["HG00438.pat"]["tracks"] = ["tracks/same.bw"]
        payload["pairs"][0]["alignments"][0]["tracks"] = {"HG00438.pat": ["tracks/same.bw"]}
        config, _diagnostics = parse_sv_config(json.dumps(payload), base_dir=Path("/data"))
        dataset = config_to_datasets(config)[0]
        self.assertEqual(len(dataset["tracks"]["target"]), 1)

    def test_unsupported_track_extension_is_an_error(self):
        payload = minimal_config()
        payload["genomes"]["HG00438.pat"]["tracks"] = ["tracks/notes.txt"]
        _config, diagnostics = parse_sv_config(json.dumps(payload))
        found = errors(diagnostics)
        self.assertEqual(found[0]["pointer"], "genomes/HG00438.pat/tracks/0/path")
        self.assertIn("notes.txt", found[0]["message"])

    def test_tracks_for_an_undeclared_genome_are_an_error(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0]["tracks"] = {"Nobody": ["x.bw"]}
        _config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertTrue(any("not a declared genome" in item["message"] for item in errors(diagnostics)))


class SequenceMapTests(unittest.TestCase):
    """The mapping TSVs used to supply these names; now they are derived."""

    def test_chain_chroms_resolve_against_assembly_names(self):
        mapping = derive_sequence_map(["1", "2", "X"], ["1", "2", "3", "X", "MT"])
        self.assertEqual(sorted(mapping["assembly_to_hal"]), ["1", "2", "X"])

    def test_chr_prefix_differences_resolve_both_ways(self):
        mapping = derive_sequence_map(["chr1", "chr2"], ["1", "2"])
        self.assertEqual(sorted(mapping["assembly_to_hal"]), ["1", "2"])
        self.assertEqual(mapping["alias_to_assembly"]["chr1"], "1")

        reverse = derive_sequence_map(["1"], ["chr1"])
        self.assertEqual(list(reverse["assembly_to_hal"]), ["chr1"])

    def test_a_chain_sequence_absent_from_the_assembly_is_dropped(self):
        mapping = derive_sequence_map(["1", "scaffold_99"], ["1", "2"])
        self.assertEqual(list(mapping["assembly_to_hal"]), ["1"])

    def test_explicit_aliases_rescue_names_the_chr_rule_cannot(self):
        mapping = derive_sequence_map(
            ["CM089167.1"],
            ["1", "2"],
            explicit_aliases={"CM089167.1": "1"},
        )
        self.assertEqual(list(mapping["assembly_to_hal"]), ["1"])
        self.assertEqual(mapping["alias_to_assembly"]["cm089167.1"], "1")

    def test_derivation_is_bounded_by_the_chain_not_the_assembly(self):
        # A fragmented assembly must not blow the map up to its contig count.
        contigs = [f"contig_{i}" for i in range(50_000)] + ["1"]
        mapping = derive_sequence_map(["1"], contigs)
        self.assertEqual(list(mapping["assembly_to_hal"]), ["1"])
        self.assertLess(len(mapping["alias_to_assembly"]), 10)


class RoundTripTests(unittest.TestCase):
    def test_config_survives_a_full_round_trip(self):
        original, diagnostics = parse_sv_config(json.dumps(minimal_config()), base_dir=Path("/data"))
        self.assertEqual(diagnostics, [])
        datasets = config_to_datasets(original)
        rendered = datasets_to_config(datasets, base_dir=Path("/data"))
        reparsed, reparse_diagnostics = parse_sv_config(serialize_sv_config(rendered), base_dir=Path("/data"))
        self.assertEqual(reparse_diagnostics, [])
        self.assertEqual(config_to_datasets(reparsed), datasets)

    def test_serialising_twice_is_stable(self):
        config, _diagnostics = parse_sv_config(json.dumps(minimal_config()), base_dir=Path("/data"))
        once = serialize_sv_config(datasets_to_config(config_to_datasets(config), base_dir=Path("/data")))
        twice_config, _ = parse_sv_config(once, base_dir=Path("/data"))
        twice = serialize_sv_config(datasets_to_config(config_to_datasets(twice_config), base_dir=Path("/data")))
        self.assertEqual(once, twice)

    def test_paths_under_the_config_directory_are_written_relative(self):
        config, _diagnostics = parse_sv_config(json.dumps(minimal_config()), base_dir=Path("/data"))
        rendered = datasets_to_config(config_to_datasets(config), base_dir=Path("/data"))
        self.assertEqual(
            rendered["pairs"][0]["alignments"][0]["chain"],
            "alt_a_to_ref_b.bigChain.bb",
        )

    def test_one_genome_shared_by_many_pairs_is_declared_once(self):
        payload = minimal_config()
        payload["genomes"]["HG00733.mat"] = {"accession": "GCA_018466835.1", "assembly_name": "HG00733_mat"}
        payload["pairs"].append({
            "genomes": ["GRCh38", "HG00733.mat"],
            "alignments": [{
                "label": "GRCh38 to HG00733.mat",
                "reference": "GRCh38",
                "target": "HG00733.mat",
                "chain": "alt_c_to_ref_b.bigChain.bb",
            }],
        })
        config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertEqual(diagnostics, [])
        rendered = datasets_to_config(config_to_datasets(config))
        self.assertEqual(len(rendered["genomes"]), 3)
        self.assertEqual(len(rendered["pairs"]), 2)

    def test_a_track_on_every_alignment_is_hoisted_onto_the_genome(self):
        payload = minimal_config()
        payload["genomes"]["HG00438.pat"]["tracks"] = ["tracks/hg00438.bw"]
        payload["pairs"][0]["alignments"].append({
            "label": "HG00438.pat to GRCh38",
            "reference": "HG00438.pat",
            "target": "GRCh38",
            "chain": "ref_b_to_alt_a.bigChain.bb",
        })
        config, _diagnostics = parse_sv_config(json.dumps(payload), base_dir=Path("/data"))
        rendered = datasets_to_config(config_to_datasets(config), base_dir=Path("/data"))
        # The default label is left out: it is regenerated from the file type, and
        # writing it back would be noise in a file meant to be read.
        self.assertEqual(
            rendered["genomes"]["HG00438.pat"]["tracks"],
            [{"path": "tracks/hg00438.bw"}],
        )
        for alignment in rendered["pairs"][0]["alignments"]:
            self.assertNotIn("tracks", alignment)


class LegacyMigrationTests(unittest.TestCase):
    LEGACY = {
        "alignments": [{
            "id": "sv_3cf227af32a17ab8",
            "label": "GRCh38 vs HG00438 paternal",
            "chain_path": "/data/alt_179f190d_to_ref_fd7fea38.bigChain.bb",
            "ref_mapping_path": "/data/GRCh38.hal_mapping.tsv",
            "tgt_mapping_path": "/data/HG00438.1.hal_mapping.tsv",
            "indexed_side": "target",
            "reference_genome": {
                "accession": "GCA_000001405.29",
                "assembly": "GCA_000001405.29",
                "assembly_name": "GRCh38.p14",
                "common_name": "Human",
                "scientific_name": "Homo sapiens",
                "genome_key": "ensembl:Homo_sapiens:GCA_000001405.29",
                "aliases": ["ensembl:Homo_sapiens:GCA_000001405.29", "GCA_000001405.29", "GRCh38.p14", "Human"],
            },
            "target_genome": {
                "accession": "GCA_018472595.2",
                "assembly": "GCA_018472595.2",
                "assembly_name": "HG00438_pat_hprc_f2",
                "common_name": "Human",
                "scientific_name": "Homo sapiens",
                "aliases": ["GCA_018472595.2", "HG00438_pat_hprc_f2", "Human"],
            },
            "tracks": {"reference": [], "target": []},
        }]
    }

    def test_legacy_registry_is_detected_and_migrated_by_parse(self):
        config, diagnostics = parse_sv_config(json.dumps(self.LEGACY))
        self.assertEqual(diagnostics, [])
        self.assertEqual(list(config["genomes"]), ["GRCh38.p14", "HG00438_pat_hprc_f2"])
        alignment = config["pairs"][0]["alignments"][0]
        self.assertEqual(alignment["label"], "GRCh38 vs HG00438 paternal")
        self.assertEqual(alignment["reference"], "GRCh38.p14")

    def test_existing_ids_are_preserved_so_nothing_renumbers(self):
        config, _diagnostics = parse_sv_config(json.dumps(self.LEGACY))
        self.assertEqual(config["pairs"][0]["alignments"][0]["id"], "sv_3cf227af32a17ab8")
        self.assertEqual(config_to_datasets(config)[0]["id"], "sv_3cf227af32a17ab8")

    def test_mapping_tsvs_are_retained_so_a_working_setup_keeps_working(self):
        migrated = migrate_legacy_registry(self.LEGACY)
        alignment = migrated["pairs"][0]["alignments"][0]
        self.assertEqual(
            alignment["legacy_mappings"],
            {
                "reference_mapping": "/data/GRCh38.hal_mapping.tsv",
                "target_mapping": "/data/HG00438.1.hal_mapping.tsv",
            },
        )

    def test_migration_drops_the_duplicated_alias_blobs(self):
        migrated = migrate_legacy_registry(self.LEGACY)
        rendered = serialize_sv_config(migrated)
        self.assertNotIn("ref_aliases", rendered)
        self.assertNotIn("ensembl:Homo_sapiens:GCA_000001405.29", rendered)
        self.assertIn("GCA_000001405.29", rendered)
        # The point of the format: a record a person can take in at a glance.
        self.assertLess(len(rendered.splitlines()), 40)

    def test_a_bare_list_registry_also_migrates(self):
        migrated = migrate_legacy_registry(self.LEGACY["alignments"])
        self.assertEqual(len(migrated["pairs"][0]["alignments"]), 1)

    def test_legacy_flat_track_paths_stay_on_the_alignment(self):
        legacy = json.loads(json.dumps(self.LEGACY))
        legacy["alignments"][0]["target_bigwig_path"] = "/data/hg00438.bw"
        legacy["alignments"][0]["target_bigbed_path"] = "/data/hg00438.bb"
        migrated = migrate_legacy_registry(legacy)
        # The old format attached tracks to one alignment. Migration keeps them
        # there rather than promoting them to the genome, where they would silently
        # start applying to other alignments of the same genome.
        self.assertNotIn("tracks", migrated["genomes"]["HG00438_pat_hprc_f2"])
        alignment = migrated["pairs"][0]["alignments"][0]
        self.assertEqual(
            [t["path"] for t in alignment["tracks"]["HG00438_pat_hprc_f2"]],
            ["/data/hg00438.bw", "/data/hg00438.bb"],
        )

    def test_a_current_config_is_not_mistaken_for_a_legacy_registry(self):
        config, diagnostics = parse_sv_config(json.dumps(minimal_config()))
        self.assertEqual(diagnostics, [])
        self.assertEqual(list(config["genomes"]), ["GRCh38", "HG00438.pat"])


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.existing, _ = parse_sv_config(json.dumps(minimal_config()))

    def _incoming(self, label, target_handle="HG00733.mat", accession="GCA_018466835.1"):
        payload = {
            CONFIG_VERSION_KEY: 1,
            "genomes": {
                "GRCh38": {"accession": "GCA_000001405.29", "assembly_name": "GRCh38.p14"},
                target_handle: {"accession": accession},
            },
            "pairs": [{
                "genomes": ["GRCh38", target_handle],
                "alignments": [{
                    "label": label,
                    "reference": "GRCh38",
                    "target": target_handle,
                    "chain": "alt_new_to_ref_b.bigChain.bb",
                }],
            }],
        }
        config, diagnostics = parse_sv_config(json.dumps(payload))
        self.assertEqual(diagnostics, [])
        return config

    def test_merge_appends_a_new_alignment_and_leaves_the_others_alone(self):
        merged = merge_sv_config(self.existing, self._incoming("GRCh38 to HG00733.mat"))
        labels = [a["label"] for pair in merged["pairs"] for a in pair["alignments"]]
        self.assertEqual(sorted(labels), ["GRCh38 to HG00438.pat", "GRCh38 to HG00733.mat"])
        self.assertEqual(len(merged["pairs"]), 2)

    def test_merge_replaces_by_label_rather_than_duplicating(self):
        incoming = self._incoming("GRCh38 to HG00438.pat", "HG00438.pat", "GCA_018472595.2")
        merged = merge_sv_config(self.existing, incoming)
        alignments = [a for pair in merged["pairs"] for a in pair["alignments"]]
        self.assertEqual(len(alignments), 1)
        self.assertEqual(alignments[0]["chain"], "alt_new_to_ref_b.bigChain.bb")

    def test_replace_mode_discards_what_was_there(self):
        incoming = self._incoming("GRCh38 to HG00733.mat")
        merged = merge_sv_config(self.existing, incoming, mode="replace")
        labels = [a["label"] for pair in merged["pairs"] for a in pair["alignments"]]
        self.assertEqual(labels, ["GRCh38 to HG00733.mat"])

    def test_the_same_assembly_under_a_new_handle_reuses_the_established_one(self):
        payload = {
            CONFIG_VERSION_KEY: 1,
            "genomes": {
                "human": {"accession": "GCA_000001405.29"},
                "HG00733.mat": {"accession": "GCA_018466835.1"},
            },
            "pairs": [{
                "genomes": ["human", "HG00733.mat"],
                "alignments": [{
                    "label": "human to HG00733.mat",
                    "reference": "human",
                    "target": "HG00733.mat",
                    "chain": "alt_c_to_ref_b.bigChain.bb",
                }],
            }],
        }
        incoming, _ = parse_sv_config(json.dumps(payload))
        merged = merge_sv_config(self.existing, incoming)
        self.assertNotIn("human", merged["genomes"])
        added = [a for pair in merged["pairs"] for a in pair["alignments"] if a["label"] == "human to HG00733.mat"]
        self.assertEqual(added[0]["reference"], "GRCh38")

    def test_merged_output_reparses_without_errors(self):
        merged = merge_sv_config(self.existing, self._incoming("GRCh38 to HG00733.mat"))
        _config, diagnostics = parse_sv_config(serialize_sv_config(merged))
        self.assertEqual(diagnostics, [])


class RemoveTests(unittest.TestCase):
    def test_removing_by_id_drops_the_alignment_and_the_empty_pair(self):
        config, _ = parse_sv_config(json.dumps(minimal_config()))
        updated, removed = remove_alignment(config, "grch38_to_hg00438_pat")
        self.assertTrue(removed)
        self.assertEqual(updated["pairs"], [])
        self.assertEqual(updated["genomes"], {})

    def test_removing_by_label_works_too(self):
        config, _ = parse_sv_config(json.dumps(minimal_config()))
        _updated, removed = remove_alignment(config, "GRCh38 to HG00438.pat")
        self.assertTrue(removed)

    def test_removing_something_absent_is_a_no_op(self):
        config, _ = parse_sv_config(json.dumps(minimal_config()))
        updated, removed = remove_alignment(config, "not_here")
        self.assertFalse(removed)
        self.assertEqual(updated, config)

    def test_a_genome_still_used_elsewhere_survives_removal(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"].append({
            "label": "HG00438.pat to GRCh38",
            "reference": "HG00438.pat",
            "target": "GRCh38",
            "chain": "ref_b_to_alt_a.bigChain.bb",
        })
        config, _ = parse_sv_config(json.dumps(payload))
        updated, removed = remove_alignment(config, "grch38_to_hg00438_pat")
        self.assertTrue(removed)
        self.assertEqual(sorted(updated["genomes"]), ["GRCh38", "HG00438.pat"])


class DiagnosticLineTests(unittest.TestCase):
    def test_pointer_lines_land_on_the_offending_field(self):
        text = serialize_sv_config(minimal_config())
        located = locate_pointer_lines(text, [
            {"severity": "error", "pointer": "pairs/0/alignments/0/chain", "message": "x", "line": 0},
        ])
        line = located[0]["line"]
        self.assertGreater(line, 0)
        self.assertIn('"chain"', text.splitlines()[line - 1])

    def test_a_repeated_key_resolves_to_the_right_array_element(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"].append({
            "label": "HG00438.pat to GRCh38",
            "reference": "HG00438.pat",
            "target": "GRCh38",
            "chain": "ref_b_to_alt_a.bigChain.bb",
        })
        text = serialize_sv_config(payload)
        located = locate_pointer_lines(text, [
            {"severity": "error", "pointer": "pairs/0/alignments/1/chain", "message": "x", "line": 0},
            {"severity": "error", "pointer": "pairs/0/alignments/0/chain", "message": "y", "line": 0},
        ])
        lines = text.splitlines()
        self.assertIn("ref_b_to_alt_a", lines[located[0]["line"] - 1])
        self.assertIn("alt_a_to_ref_b", lines[located[1]["line"] - 1])

    def test_a_missing_field_falls_back_to_the_record_it_belongs_to(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"][0].pop("chain")
        text = serialize_sv_config(payload)
        located = locate_pointer_lines(text, [
            {"severity": "error", "pointer": "pairs/0/alignments/0/chain", "message": "x", "line": 0},
        ])
        # No "chain" line exists, so the error points at the alignment instead.
        self.assertGreater(located[0]["line"], 0)
        self.assertIn("{", text.splitlines()[located[0]["line"] - 1])

    def test_an_existing_line_from_the_json_parser_is_kept(self):
        located = locate_pointer_lines('{\n"a": 1\n}', [
            {"severity": "error", "pointer": "", "message": "x", "line": 2},
        ])
        self.assertEqual(located[0]["line"], 2)

    def test_an_unlocatable_pointer_keeps_line_zero(self):
        located = locate_pointer_lines("{}", [
            {"severity": "error", "pointer": "pairs/0/alignments/0/chain", "message": "x", "line": 0},
        ])
        self.assertEqual(located[0]["line"], 0)


class FileTests(unittest.TestCase):
    def test_a_written_config_reads_back_with_paths_resolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "chains").mkdir()
            chain = root / "chains" / "alt_a_to_ref_b.bigChain.bb"
            chain.write_bytes(b"placeholder")

            payload = minimal_config()
            payload["pairs"][0]["alignments"][0]["chain"] = "chains/alt_a_to_ref_b.bigChain.bb"
            config_path = root / "hprc.sv.json"
            config_path.write_text(serialize_sv_config(payload), encoding="utf-8")

            config, diagnostics = parse_sv_config(
                config_path.read_text(encoding="utf-8"),
                base_dir=config_path.parent,
            )
            self.assertEqual(diagnostics, [])
            dataset = config_to_datasets(config, config_path=str(config_path))[0]
            self.assertEqual(dataset["chain_path"], str(chain))
            self.assertTrue(Path(dataset["chain_path"]).exists())
            self.assertEqual(dataset["config_path"], str(config_path))

    def test_pair_id_is_stable_regardless_of_direction(self):
        payload = minimal_config()
        payload["pairs"][0]["alignments"].append({
            "label": "HG00438.pat to GRCh38",
            "reference": "HG00438.pat",
            "target": "GRCh38",
            "chain": "ref_b_to_alt_a.bigChain.bb",
        })
        config, _ = parse_sv_config(json.dumps(payload))
        forward, reverse = config_to_datasets(config)
        self.assertEqual(forward["pair_id"], reverse["pair_id"])
        self.assertTrue(forward["pair_id"])


if __name__ == "__main__":
    unittest.main()

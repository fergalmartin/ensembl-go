"""Endpoint-level tests for the SV configuration routes.

The SV routes had no coverage of their own before this; existing tests reached
past them into the selection helpers. Registration now writes a file a person is
expected to read and edit by hand, so what lands on disk is part of the contract
and is asserted here rather than inferred.

Handlers are awaited directly rather than driven over HTTP, matching
``test_bigbed_tile_endpoints.py`` and keeping the test dependencies unchanged.
"""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

import main  # noqa: E402
from main import (  # noqa: E402
    SvAlignmentDeleteRequest,
    SvAlignmentRegisterRequest,
    SvConfigAttachRequest,
    SvConfigSaveRequest,
    SvConfigValidateRequest,
    _sv_registry_cache,
    attach_sv_config,
    delete_sv_alignment,
    detach_sv_config,
    read_sv_config,
    register_sv_alignment,
    save_sv_config,
    sv_catalog,
    validate_sv_config,
)


class SvConfigEndpointTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        (self.root / "local_data").mkdir()

        self.chain = self.root / "alt_a_to_ref_b.bigChain.bb"
        self.chain.write_bytes(b"placeholder")

        # The registry path and the attached-config list both come from the app
        # config, so each test needs its own rather than the developer's real one.
        self.app_config = {"output_dir": str(self.root), "sv_config_paths": []}

        patch.object(main, "load_config", lambda: dict(self.app_config)).start()
        patch.object(main, "save_config", self._save_config).start()
        self.addCleanup(patch.stopall)

        _sv_registry_cache["signature"] = None
        self.addCleanup(_sv_registry_cache.__setitem__, "signature", None)

    def _save_config(self, config, path=None):
        self.app_config = dict(config)

    @property
    def registry_path(self):
        return self.root / "local_data" / "sv_alignment_registry.json"

    def register(self, **overrides):
        payload = {
            "output_dir": str(self.root),
            "label": "GRCh38 to HG00438.pat",
            "chain_path": str(self.chain),
            "reference_genome": {
                "accession": "GCA_000001405.29",
                "assembly_name": "GRCh38.p14",
                "scientific_name": "Homo sapiens",
            },
            "target_genome": {
                "accession": "GCA_018472595.2",
                "assembly_name": "HG00438_pat_hprc_f2",
                "scientific_name": "Homo sapiens",
            },
        }
        payload.update(overrides)
        return asyncio.run(register_sv_alignment(SvAlignmentRegisterRequest(**payload)))

    def catalog(self):
        return asyncio.run(sv_catalog(output_dir=str(self.root)))

    def registry_payload(self):
        return json.loads(self.registry_path.read_text(encoding="utf-8"))

    def assertRefused(self, callable_, *fragments):
        with self.assertRaises(HTTPException) as caught:
            callable_()
        self.assertEqual(caught.exception.status_code, 400)
        for fragment in fragments:
            self.assertIn(fragment, str(caught.exception.detail))
        return caught.exception


class RegistrationTests(SvConfigEndpointTestCase):
    def test_registering_without_mapping_tsvs_succeeds(self):
        result = self.register()
        self.assertTrue(result["ok"])
        self.assertTrue(self.registry_path.exists())

    def test_the_registry_is_written_in_the_readable_format(self):
        self.register()
        payload = self.registry_payload()
        self.assertEqual(payload["ensembl_go_sv_config"], 1)
        self.assertEqual(sorted(payload["genomes"]), ["GRCh38.p14", "HG00438_pat_hprc_f2"])
        alignment = payload["pairs"][0]["alignments"][0]
        self.assertEqual(alignment["label"], "GRCh38 to HG00438.pat")
        self.assertEqual(alignment["reference"], "GRCh38.p14")
        self.assertNotIn("ref_mapping_path", alignment)
        self.assertNotIn("ref_aliases", alignment)

    def test_the_written_record_is_short_enough_to_read(self):
        self.register()
        # The old registry spent ~60 lines on one alignment. The whole point of the
        # format is that this is no longer true.
        self.assertLess(len(self.registry_path.read_text(encoding="utf-8").splitlines()), 32)

    def test_indexed_side_is_inferred_from_the_file_name(self):
        self.register()
        alignment = self.registry_payload()["pairs"][0]["alignments"][0]
        # Inferred correctly, so it is not restated in the file.
        self.assertNotIn("indexed_side", alignment)
        self.assertEqual(self.catalog()["alignments"][0]["indexed_side"], "target")

    def test_an_explicit_indexed_side_is_recorded_when_it_differs(self):
        self.register(indexed_side="reference")
        alignment = self.registry_payload()["pairs"][0]["alignments"][0]
        self.assertEqual(alignment["indexed_side"], "reference")
        self.assertEqual(self.catalog()["alignments"][0]["indexed_side"], "reference")

    def test_registering_the_same_label_updates_rather_than_duplicating(self):
        self.register()
        moved = self.root / "alt_c_to_ref_d.bigChain.bb"
        moved.write_bytes(b"placeholder")
        self.register(chain_path=str(moved))

        alignments = [a for pair in self.registry_payload()["pairs"] for a in pair["alignments"]]
        self.assertEqual(len(alignments), 1)
        self.assertTrue(alignments[0]["chain"].endswith("alt_c_to_ref_d.bigChain.bb"))

    def register_reverse(self):
        reverse = self.root / "ref_b_to_alt_a.bigChain.bb"
        reverse.write_bytes(b"placeholder")
        return self.register(
            label="HG00438.pat to GRCh38",
            chain_path=str(reverse),
            reference_genome={"accession": "GCA_018472595.2", "assembly_name": "HG00438_pat_hprc_f2"},
            target_genome={"accession": "GCA_000001405.29", "assembly_name": "GRCh38.p14"},
        )

    def test_a_second_alignment_for_the_same_pair_joins_that_pair(self):
        self.register()
        self.register_reverse()
        payload = self.registry_payload()
        self.assertEqual(len(payload["pairs"]), 1)
        self.assertEqual(len(payload["pairs"][0]["alignments"]), 2)
        # The reverse direction reuses the handles already established.
        self.assertEqual(len(payload["genomes"]), 2)

    def test_both_directions_share_a_pair_id(self):
        self.register()
        self.register_reverse()
        pair_ids = {alignment["pair_id"] for alignment in self.catalog()["alignments"]}
        self.assertEqual(len(pair_ids), 1)
        self.assertTrue(next(iter(pair_ids)))

    def test_the_two_directions_stay_distinct_alignments(self):
        self.register()
        self.register_reverse()
        catalog = self.catalog()
        self.assertEqual(len(catalog["alignments"]), 2)
        self.assertEqual(len({a["id"] for a in catalog["alignments"]}), 2)
        sides = {a["label"]: a["indexed_side"] for a in catalog["alignments"]}
        self.assertEqual(sides["GRCh38 to HG00438.pat"], "target")
        self.assertEqual(sides["HG00438.pat to GRCh38"], "reference")

    def test_a_missing_label_is_refused_with_a_reason(self):
        self.assertRefused(lambda: self.register(label=""), "label")

    def test_registering_a_genome_against_itself_is_refused(self):
        self.assertRefused(
            lambda: self.register(
                target_genome={"accession": "GCA_000001405.29", "assembly_name": "GRCh38.p14"},
            ),
            "different",
        )

    def test_a_missing_chain_file_is_refused(self):
        self.assertRefused(
            lambda: self.register(chain_path=str(self.root / "nope.bigChain.bb")),
            "not found",
        )

    def test_a_missing_optional_track_is_refused(self):
        self.assertRefused(
            lambda: self.register(target_bigwig_path=str(self.root / "nope.bw")),
            "Target BigWig",
        )

    def test_optional_tracks_are_stored_against_the_genome(self):
        bigwig = self.root / "hg00438.bw"
        bigwig.write_bytes(b"placeholder")
        self.register(target_bigwig_path=str(bigwig))
        alignment = self.registry_payload()["pairs"][0]["alignments"][0]
        self.assertEqual(list(alignment["tracks"]), ["HG00438_pat_hprc_f2"])

    def test_reference_side_tracks_are_reachable(self):
        bigbed = self.root / "grch38.bb"
        bigbed.write_bytes(b"placeholder")
        self.register(reference_bigbed_path=str(bigbed))
        alignment = self.registry_payload()["pairs"][0]["alignments"][0]
        self.assertEqual(list(alignment["tracks"]), ["GRCh38.p14"])
        tracks = self.catalog()["alignments"][0]["tracks"]
        self.assertEqual([t["type"] for t in tracks["reference"]], ["bigbed"])

    def test_saving_to_a_named_config_leaves_the_registry_alone(self):
        destination = self.root / "hprc.json"
        result = self.register(target={"kind": "config", "path": str(destination)})
        self.assertTrue(result["ok"])
        self.assertTrue(destination.exists())
        self.assertFalse(self.registry_path.exists())

    def test_amending_a_config_keeps_the_records_already_in_it(self):
        destination = self.root / "hprc.json"
        self.register(target={"kind": "config", "path": str(destination)})
        other = self.root / "alt_c_to_ref_b.bigChain.bb"
        other.write_bytes(b"placeholder")
        self.register(
            label="GRCh38 to HG00733.mat",
            chain_path=str(other),
            target_genome={"accession": "GCA_018466835.1", "assembly_name": "HG00733_mat"},
            target={"kind": "config", "path": str(destination), "mode": "merge"},
        )
        payload = json.loads(destination.read_text(encoding="utf-8"))
        labels = sorted(a["label"] for pair in payload["pairs"] for a in pair["alignments"])
        self.assertEqual(labels, ["GRCh38 to HG00438.pat", "GRCh38 to HG00733.mat"])
        self.assertEqual(len(payload["genomes"]), 3)

    def test_a_config_that_does_not_parse_is_not_overwritten(self):
        destination = self.root / "broken.json"
        destination.write_text('{"pairs": [', encoding="utf-8")
        self.assertRefused(
            lambda: self.register(target={"kind": "config", "path": str(destination)}),
            "left untouched",
        )
        self.assertEqual(destination.read_text(encoding="utf-8"), '{"pairs": [')

    def test_a_config_path_with_the_wrong_extension_is_refused(self):
        self.assertRefused(
            lambda: self.register(target={"kind": "config", "path": str(self.root / "x.yaml")}),
            ".json",
        )


class GenomeIdentityTests(SvConfigEndpointTestCase):
    """One assembly is one genome, however the config that names it spells it."""

    def attached_config_using_other_handles(self):
        destination = self.root / "shared.json"
        destination.write_text(json.dumps({
            "ensembl_go_sv_config": 1,
            "genomes": {
                # Same two assemblies as self.register(), under different handles
                # and with less metadata.
                "GRCh38": {"accession": "GCA_000001405.29"},
                "HG00438.pat": {"accession": "GCA_018472595.2"},
            },
            "pairs": [{
                "genomes": ["GRCh38", "HG00438.pat"],
                "alignments": [{
                    "label": "GRCh38 to HG00438.pat (shared file)",
                    "reference": "GRCh38",
                    "target": "HG00438.pat",
                    "chain": str(self.chain),
                }],
            }],
        }), encoding="utf-8")
        asyncio.run(attach_sv_config(SvConfigAttachRequest(path=str(destination))))

    def test_the_same_assembly_from_two_sources_is_one_catalog_genome(self):
        self.register()
        self.attached_config_using_other_handles()
        catalog = self.catalog()
        self.assertEqual(len(catalog["alignments"]), 2)
        self.assertEqual(len(catalog["genomes"]), 2)

    def test_alignments_from_two_sources_share_a_pair_id(self):
        self.register()
        self.attached_config_using_other_handles()
        pair_ids = {alignment["pair_id"] for alignment in self.catalog()["alignments"]}
        self.assertEqual(len(pair_ids), 1)

    def test_different_assemblies_stay_distinct(self):
        self.register()
        other = self.root / "alt_c_to_ref_b.bigChain.bb"
        other.write_bytes(b"placeholder")
        self.register(
            label="GRCh38 to HG00733.mat",
            chain_path=str(other),
            target_genome={"accession": "GCA_018466835.1", "assembly_name": "HG00733_mat"},
        )
        catalog = self.catalog()
        self.assertEqual(len(catalog["genomes"]), 3)
        self.assertEqual(len({a["pair_id"] for a in catalog["alignments"]}), 2)


class LegacyRegistryTests(SvConfigEndpointTestCase):
    def write_legacy(self):
        ref_map = self.root / "ref.hal_mapping.tsv"
        tgt_map = self.root / "tgt.hal_mapping.tsv"
        header = "hal_genome_name\tassembly_uuid\thal_sequence_name\tassembly_sequence\n"
        ref_map.write_text(header + "ref\tref-uuid\tchr1\t1\n", encoding="utf-8")
        tgt_map.write_text(header + "tgt\ttgt-uuid\tCM089167.1\t1\n", encoding="utf-8")
        self.registry_path.write_text(json.dumps({
            "alignments": [{
                "id": "sv_3cf227af32a17ab8",
                "label": "GRCh38 vs HG00438 paternal",
                "chain_path": str(self.chain),
                "ref_mapping_path": str(ref_map),
                "tgt_mapping_path": str(tgt_map),
                "indexed_side": "target",
                "reference_genome": {"assembly": "GCA_000001405.29", "assembly_name": "GRCh38.p14"},
                "target_genome": {"assembly": "GCA_018472595.2", "assembly_name": "HG00438_pat_hprc_f2"},
            }]
        }), encoding="utf-8")
        return ref_map, tgt_map

    def test_a_legacy_registry_still_loads(self):
        self.write_legacy()
        alignments = self.catalog()["alignments"]
        self.assertEqual(len(alignments), 1)
        self.assertEqual(alignments[0]["id"], "sv_3cf227af32a17ab8")
        self.assertEqual(alignments[0]["label"], "GRCh38 vs HG00438 paternal")
        self.assertTrue(alignments[0]["supported"])

    def test_reading_a_legacy_registry_shows_the_migrated_form(self):
        self.write_legacy()
        result = asyncio.run(read_sv_config(output_dir=str(self.root)))
        self.assertIn('"ensembl_go_sv_config"', result["text"])
        self.assertIn("legacy_mappings", result["text"])

    def test_the_editor_is_not_shown_the_parser_internals(self):
        self.write_legacy()
        text = asyncio.run(read_sv_config(output_dir=str(self.root)))["text"]
        # Parsing fills in derived fields the user never wrote and should never have
        # to read. What the editor shows has to be the document, not the parse tree.
        for internal in ("inferred_indexed_side", '"handle"', '"gca"', '"equivalent_accessions"'):
            self.assertNotIn(internal, text)
        # Nor the empty defaults parsing supplies for absent optional fields.
        self.assertNotIn('"description": ""', text)
        self.assertNotIn('"tracks": {}', text)
        self.assertNotIn('"sequence_aliases": {}', text)

    def test_a_file_already_in_the_current_format_is_returned_verbatim(self):
        destination = self.root / "hprc.json"
        self.register(target={"kind": "config", "path": str(destination)})
        original = destination.read_text(encoding="utf-8")
        result = asyncio.run(read_sv_config(path=str(destination)))
        # Reformatting what the user wrote would be its own kind of damage.
        self.assertEqual(result["text"], original)

    def test_the_legacy_file_is_not_rewritten_until_something_is_saved(self):
        self.write_legacy()
        before = self.registry_path.read_text(encoding="utf-8")
        self.catalog()
        asyncio.run(read_sv_config(output_dir=str(self.root)))
        self.assertEqual(self.registry_path.read_text(encoding="utf-8"), before)

    def test_registering_alongside_a_legacy_entry_preserves_it(self):
        self.write_legacy()
        other = self.root / "alt_c_to_ref_b.bigChain.bb"
        other.write_bytes(b"placeholder")
        self.register(label="GRCh38 to HG00733.mat", chain_path=str(other))

        payload = self.registry_payload()
        alignments = [a for pair in payload["pairs"] for a in pair["alignments"]]
        self.assertEqual(sorted(a["label"] for a in alignments),
                         ["GRCh38 to HG00733.mat", "GRCh38 vs HG00438 paternal"])
        legacy = [a for a in alignments if a["label"].startswith("GRCh38 vs")][0]
        self.assertEqual(legacy["id"], "sv_3cf227af32a17ab8")
        self.assertIn("legacy_mappings", legacy)

    def test_a_migrated_entry_keeps_using_its_mapping_tsvs(self):
        ref_map, _tgt_map = self.write_legacy()
        self.register(label="GRCh38 to HG00733.mat")
        _sv_registry_cache["signature"] = None
        datasets, _incomplete = main._list_sv_datasets(str(self.root))
        legacy = [d for d in datasets if d["id"] == "sv_3cf227af32a17ab8"][0]
        self.assertEqual(str(legacy["ref_mapping_path"]), str(ref_map))
        mapping = main._sv_side_mapping(legacy, "target")
        self.assertEqual(mapping["hal_to_assembly"]["CM089167.1"], "1")

    def test_a_legacy_entry_whose_tsv_vanished_reports_it_missing(self):
        ref_map, _tgt_map = self.write_legacy()
        ref_map.unlink()
        _sv_registry_cache["signature"] = None
        alignment = self.catalog()["alignments"][0]
        self.assertFalse(alignment["supported"])
        self.assertTrue(any("ref.hal_mapping.tsv" in item for item in alignment["missing_files"]))


class DerivedSequenceNameTests(SvConfigEndpointTestCase):
    """An alignment with no TSV is only unsupported if the chain itself is absent."""

    def test_an_alignment_without_tsvs_is_supported(self):
        self.register()
        alignment = self.catalog()["alignments"][0]
        self.assertTrue(alignment["supported"])
        self.assertEqual(alignment["missing_files"], [])

    def test_a_missing_chain_makes_it_unsupported(self):
        self.register()
        self.chain.unlink()
        _sv_registry_cache["signature"] = None
        alignment = self.catalog()["alignments"][0]
        self.assertFalse(alignment["supported"])
        self.assertEqual(alignment["missing_files"], [str(self.chain)])

    def test_no_regions_are_offered_when_the_assembly_is_not_local(self):
        # Nothing is downloaded in this tmpdir, so there are no sequence names to
        # derive from and the region list is empty rather than wrong.
        self.register()
        self.assertEqual(self.catalog()["alignments"][0]["reference_regions"], [])


class ValidateTests(SvConfigEndpointTestCase):
    def config_payload(self, **alignment_overrides):
        alignment = {
            "label": "A to B",
            "reference": "A",
            "target": "B",
            "chain": str(self.chain),
        }
        alignment.update(alignment_overrides)
        return {
            "ensembl_go_sv_config": 1,
            "genomes": {"A": {"accession": "GCA_1"}, "B": {"accession": "GCA_2"}},
            "pairs": [{"genomes": ["A", "B"], "alignments": [alignment]}],
        }

    def validate(self, text):
        return asyncio.run(validate_sv_config(SvConfigValidateRequest(text=text)))

    def test_a_good_config_validates(self):
        body = self.validate(json.dumps(self.config_payload()))
        self.assertTrue(body["ok"])
        self.assertEqual(body["alignment_count"], 1)
        self.assertEqual(body["missing_files"], [])

    def test_broken_json_returns_diagnostics_not_an_exception(self):
        body = self.validate("{oops")
        self.assertFalse(body["ok"])
        self.assertTrue(body["diagnostics"])

    def test_a_missing_chain_is_reported_without_failing_validation(self):
        body = self.validate(json.dumps(self.config_payload(chain=str(self.root / "absent.bigChain.bb"))))
        # The config itself is well formed; the file just is not there yet.
        self.assertTrue(body["ok"])
        self.assertEqual(len(body["missing_files"]), 1)

    def test_diagnostics_carry_the_line_of_the_offending_field(self):
        text = json.dumps(self.config_payload(target="Nope"), indent=2)
        body = self.validate(text)
        self.assertFalse(body["ok"])
        error = [item for item in body["diagnostics"] if item["severity"] == "error"][0]
        self.assertGreater(error["line"], 0)
        self.assertIn('"target"', text.splitlines()[error["line"] - 1])

    def test_a_duplicate_label_is_reported(self):
        payload = self.config_payload()
        payload["pairs"][0]["alignments"].append({
            "label": "A to B", "reference": "B", "target": "A", "chain": str(self.chain),
        })
        body = self.validate(json.dumps(payload))
        self.assertFalse(body["ok"])
        self.assertTrue(any("unique" in item["message"] for item in body["diagnostics"]))

    def test_nothing_is_written_by_validating(self):
        self.validate(json.dumps(self.config_payload()))
        self.assertFalse(self.registry_path.exists())


class SaveAndAttachTests(SvConfigEndpointTestCase):
    def config_text(self, label="A to B"):
        return json.dumps({
            "ensembl_go_sv_config": 1,
            "genomes": {"A": {"accession": "GCA_1"}, "B": {"accession": "GCA_2"}},
            "pairs": [{
                "genomes": ["A", "B"],
                "alignments": [{
                    "label": label, "reference": "A", "target": "B",
                    "chain": str(self.chain),
                }],
            }],
        })

    def save(self, path, text, **kwargs):
        return asyncio.run(save_sv_config(SvConfigSaveRequest(path=str(path), text=text, **kwargs)))

    def attach(self, path):
        return asyncio.run(attach_sv_config(SvConfigAttachRequest(path=str(path))))

    def test_saving_writes_the_file(self):
        destination = self.root / "saved.json"
        result = self.save(destination, self.config_text())
        self.assertTrue(result["ok"])
        self.assertIn("A to B", destination.read_text(encoding="utf-8"))

    def test_a_broken_config_is_refused_and_nothing_is_written(self):
        destination = self.root / "saved.json"
        result = self.save(destination, "{oops")
        self.assertFalse(result["ok"])
        self.assertTrue(result["diagnostics"])
        self.assertFalse(destination.exists())

    def test_a_path_with_the_wrong_extension_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.save(self.root / "saved.yaml", self.config_text())
        self.assertEqual(caught.exception.status_code, 400)

    def test_saving_in_merge_mode_keeps_what_was_there(self):
        destination = self.root / "saved.json"
        self.save(destination, self.config_text("A to B"))
        self.save(destination, self.config_text("A to B again"), mode="merge")
        payload = json.loads(destination.read_text(encoding="utf-8"))
        labels = sorted(a["label"] for pair in payload["pairs"] for a in pair["alignments"])
        self.assertEqual(labels, ["A to B", "A to B again"])

    def test_saving_in_replace_mode_discards_what_was_there(self):
        destination = self.root / "saved.json"
        self.save(destination, self.config_text("A to B"))
        self.save(destination, self.config_text("A to B again"), mode="replace")
        payload = json.loads(destination.read_text(encoding="utf-8"))
        labels = [a["label"] for pair in payload["pairs"] for a in pair["alignments"]]
        self.assertEqual(labels, ["A to B again"])

    def test_saving_with_attach_makes_it_visible_immediately(self):
        destination = self.root / "saved.json"
        self.save(destination, self.config_text(), attach=True)
        self.assertEqual([a["label"] for a in self.catalog()["alignments"]], ["A to B"])

    def test_attaching_a_config_adds_its_alignments_to_the_catalog(self):
        destination = self.root / "shared.json"
        destination.write_text(self.config_text(), encoding="utf-8")
        self.assertTrue(self.attach(destination)["ok"])

        catalog = self.catalog()
        self.assertEqual([a["label"] for a in catalog["alignments"]], ["A to B"])
        self.assertEqual(catalog["configs"][0]["alignment_count"], 1)
        self.assertEqual(catalog["alignments"][0]["config_path"], str(destination))

    def test_attaching_a_broken_config_is_refused(self):
        destination = self.root / "broken.json"
        destination.write_text("{oops", encoding="utf-8")
        self.assertFalse(self.attach(destination)["ok"])
        self.assertEqual(self.app_config["sv_config_paths"], [])

    def test_attaching_a_file_that_is_not_there_is_a_404(self):
        with self.assertRaises(HTTPException) as caught:
            self.attach(self.root / "absent.json")
        self.assertEqual(caught.exception.status_code, 404)

    def test_detaching_removes_it_from_the_catalog_but_leaves_the_file(self):
        destination = self.root / "shared.json"
        destination.write_text(self.config_text(), encoding="utf-8")
        self.attach(destination)
        detach_sv_config(SvConfigAttachRequest(path=str(destination)))

        self.assertEqual(self.catalog()["alignments"], [])
        self.assertTrue(destination.exists())

    def test_attaching_the_same_path_twice_does_not_duplicate_it(self):
        destination = self.root / "shared.json"
        destination.write_text(self.config_text(), encoding="utf-8")
        self.attach(destination)
        self.attach(destination)
        self.assertEqual(self.app_config["sv_config_paths"], [str(destination)])

    def test_a_registered_alignment_wins_over_an_attached_one_with_the_same_id(self):
        destination = self.root / "shared.json"
        destination.write_text(json.dumps({
            "ensembl_go_sv_config": 1,
            "genomes": {
                "GRCh38.p14": {"accession": "GCA_000001405.29"},
                "HG00438_pat_hprc_f2": {"accession": "GCA_018472595.2"},
            },
            "pairs": [{
                "genomes": ["GRCh38.p14", "HG00438_pat_hprc_f2"],
                "alignments": [{
                    "label": "GRCh38 to HG00438.pat",
                    "reference": "GRCh38.p14",
                    "target": "HG00438_pat_hprc_f2",
                    "chain": str(self.chain),
                    "description": "from the shared file",
                }],
            }],
        }), encoding="utf-8")
        self.attach(destination)
        self.register(description="registered locally")

        alignments = self.catalog()["alignments"]
        self.assertEqual(len(alignments), 1)
        self.assertEqual(alignments[0]["description"], "registered locally")
        self.assertEqual(alignments[0]["source"], "registered")


class DeleteTests(SvConfigEndpointTestCase):
    def delete(self, alignment_id, **kwargs):
        payload = {"output_dir": str(self.root)}
        payload.update(kwargs)
        return asyncio.run(delete_sv_alignment(alignment_id, SvAlignmentDeleteRequest(**payload)))

    def test_deleting_removes_the_alignment_from_the_registry(self):
        self.register()
        alignment_id = self.catalog()["alignments"][0]["id"]
        self.assertTrue(self.delete(alignment_id)["ok"])
        self.assertEqual(self.catalog()["alignments"], [])

    def test_deleting_something_absent_is_a_404(self):
        self.register()
        with self.assertRaises(HTTPException) as caught:
            self.delete("not_a_real_id")
        self.assertEqual(caught.exception.status_code, 404)

    def test_deleting_one_direction_leaves_the_other(self):
        self.register()
        reverse = self.root / "ref_b_to_alt_a.bigChain.bb"
        reverse.write_bytes(b"placeholder")
        self.register(
            label="HG00438.pat to GRCh38",
            chain_path=str(reverse),
            reference_genome={"accession": "GCA_018472595.2", "assembly_name": "HG00438_pat_hprc_f2"},
            target_genome={"accession": "GCA_000001405.29", "assembly_name": "GRCh38.p14"},
        )
        self.delete("grch38_to_hg00438_pat")
        self.assertEqual([a["label"] for a in self.catalog()["alignments"]], ["HG00438.pat to GRCh38"])

    def test_deleting_from_a_named_config_leaves_the_others(self):
        destination = self.root / "hprc.json"
        self.register(target={"kind": "config", "path": str(destination)})
        other = self.root / "alt_c_to_ref_b.bigChain.bb"
        other.write_bytes(b"placeholder")
        self.register(
            label="GRCh38 to HG00733.mat",
            chain_path=str(other),
            target_genome={"accession": "GCA_018466835.1", "assembly_name": "HG00733_mat"},
            target={"kind": "config", "path": str(destination), "mode": "merge"},
        )

        self.delete("grch38_to_hg00733_mat", config_path=str(destination))
        payload = json.loads(destination.read_text(encoding="utf-8"))
        labels = [a["label"] for pair in payload["pairs"] for a in pair["alignments"]]
        self.assertEqual(labels, ["GRCh38 to HG00438.pat"])


if __name__ == "__main__":
    unittest.main()

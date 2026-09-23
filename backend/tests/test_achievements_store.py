"""The achievements store: merging, upgrades, damaged files, and the backend's own events.

The store is a game's save file, but it is still the user's data, so the tests that
matter most are the ones about never losing it: a merge that can only grow, a file
from a newer version that an older one will not overwrite, a corrupt file moved aside
rather than replaced, and a reset that cannot be undone by a second copy of the store.
"""

import asyncio
import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import achievements_store as store  # noqa: E402
import main  # noqa: E402


class StoreModelTests(unittest.TestCase):
    def test_merge_keeps_the_furthest_along_value_of_everything(self):
        a = store.empty_store()
        a["unlocked"] = {"scribe": {"at": "2026-01-02T00:00:00Z"}, "flip_it": {"at": "2026-03-01T00:00:00Z"}}
        a["counters"] = {"notes.created": 7}
        a["distinct"] = {"view.visit": ["home", "notes"]}
        a["durations_ms"] = {"app.active": 5000}
        b = store.empty_store()
        b["unlocked"] = {"scribe": {"at": "2026-01-01T00:00:00Z"}}
        b["counters"] = {"notes.created": 3, "other": 2}
        b["distinct"] = {"view.visit": ["stats"]}
        b["durations_ms"] = {"app.active": 9000}

        merged = store.merge_stores(a, b)

        self.assertEqual(merged["unlocked"]["scribe"]["at"], "2026-01-01T00:00:00Z")
        self.assertIn("flip_it", merged["unlocked"])
        self.assertEqual(merged["counters"], {"notes.created": 7, "other": 2})
        self.assertEqual(merged["distinct"]["view.visit"], ["home", "notes", "stats"])
        self.assertEqual(merged["durations_ms"]["app.active"], 9000)

    def test_merging_a_store_with_itself_changes_nothing(self):
        doc = store.empty_store()
        doc["counters"] = {"notes.created": 4}
        doc["distinct"] = {"view.visit": ["home"]}
        self.assertEqual(store.merge_stores(doc, doc)["counters"], {"notes.created": 4})

    def test_unknown_ids_and_fields_survive_a_round_trip(self):
        doc = store.normalize_store({
            "schema": 1,
            "unlocked": {"from_a_future_version": {"at": "2027-01-01T00:00:00Z", "extra": 1}},
            "something_new": {"kept": True},
        })
        self.assertIn("from_a_future_version", doc["unlocked"])
        self.assertEqual(doc["unlocked"]["from_a_future_version"]["extra"], 1)
        self.assertEqual(doc["something_new"], {"kept": True})

    def test_delta_adds_and_never_takes_away(self):
        doc = store.empty_store()
        doc["unlocked"] = {"scribe": {"at": "2026-01-01T00:00:00Z"}}
        changed = store.apply_delta(doc, {
            "unlocked": {"scribe": "2026-05-05T00:00:00Z", "flip_it": "2026-05-05T00:00:00Z"},
            "counters": {"notes.created": 2, "bad id!": 5, "negative": -4},
            "distinct": {"view.visit": ["home", "", "home"]},
            "durations_ms": {"app.active": 60_000},
            "settings": {"notifications": False, "unknown_setting": "x"},
        })
        self.assertTrue(changed)
        self.assertEqual(doc["unlocked"]["scribe"]["at"], "2026-01-01T00:00:00Z")
        self.assertIn("flip_it", doc["unlocked"])
        self.assertEqual(doc["counters"], {"notes.created": 2})
        self.assertEqual(doc["distinct"]["view.visit"], ["home"])
        self.assertEqual(doc["settings"], {"notifications": False})

    def test_a_single_delta_cannot_claim_more_than_a_day_of_use(self):
        doc = store.empty_store()
        store.apply_delta(doc, {"durations_ms": {"app.active": 10 ** 12}})
        self.assertEqual(doc["durations_ms"]["app.active"], store.MAX_DURATION_STEP_MS)

    def test_grch37_is_recognised_by_name_and_by_accession(self):
        self.assertTrue(store.is_grch37("GCF_000001405.25"))
        self.assertTrue(store.is_grch37("GCA_000001405.14"))
        self.assertTrue(store.is_grch37("anything", "GRCh37.p13"))
        self.assertFalse(store.is_grch37("GCF_000001405.40"))
        self.assertFalse(store.is_grch37("GCA_000001405.29", "GRCh38"))
        self.assertFalse(store.is_grch37("GCA_009914755.4", "T2T-CHM13v2.0"))

    def test_recording_a_download_twice_counts_once(self):
        doc = store.empty_store()
        self.assertTrue(store.record_download(doc, "ncbi::Homo_sapiens::GCF_000001405.25", 9606, "GCF_000001405.25"))
        self.assertFalse(store.record_download(doc, "ncbi::Homo_sapiens::GCF_000001405.25", 9606, "GCF_000001405.25"))
        self.assertEqual(doc["distinct"]["genome.downloaded"], ["ncbi::Homo_sapiens::GCF_000001405.25"])
        self.assertEqual(doc["distinct"]["genome.grch37"], ["ncbi::Homo_sapiens::GCF_000001405.25"])
        self.assertEqual(doc["taxa"], {"ncbi::Homo_sapiens::GCF_000001405.25": 9606})

    def test_reset_keeps_settings_only(self):
        doc = store.empty_store()
        doc["unlocked"] = {"scribe": {"at": "2026-01-01T00:00:00Z"}}
        doc["settings"] = {"notifications": False}
        fresh = store.reset_store(doc)
        self.assertEqual(fresh["unlocked"], {})
        self.assertEqual(fresh["settings"], {"notifications": False})


class StoreDiskTests(unittest.TestCase):
    def test_a_newer_file_is_read_but_never_written(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "achievements.json"
            original = {"schema": store.STORE_SCHEMA + 1, "unlocked": {"scribe": {"at": "2026-01-01T00:00:00Z"}}}
            path.write_text(json.dumps(original), encoding="utf-8")

            result = store.read_store(path)
            self.assertEqual(result.status, "newer")
            self.assertIn("scribe", result.doc["unlocked"])
            with self.assertRaises(PermissionError):
                store.write_store(path, store.empty_store())
            self.assertEqual(json.loads(path.read_text()), original)

    def test_a_corrupt_file_is_moved_aside_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "achievements.json"
            path.write_text("{not json", encoding="utf-8")

            result = store.read_store(path)

            self.assertEqual(result.status, "corrupt")
            self.assertFalse(path.exists())
            moved = list(Path(tmpdir).glob("achievements.json.corrupt-*"))
            self.assertEqual(len(moved), 1)
            self.assertEqual(moved[0].read_text(), "{not json")

    def test_writes_keep_the_previous_copy(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "achievements.json"
            first = store.empty_store()
            first["counters"] = {"a": 1}
            store.write_store(path, first)
            second = store.empty_store()
            second["counters"] = {"a": 2}
            store.write_store(path, second)
            self.assertEqual(json.loads(path.with_name("achievements.json.bak").read_text())["counters"], {"a": 1})
            self.assertEqual(json.loads(path.read_text())["counters"], {"a": 2})


@contextmanager
def _app(output_dir="out"):
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        cache_file = root / "cache_achievements.json"
        with patch.object(main, "CONFIG_FILE", root / "config.json"), \
                patch.object(main, "ACHIEVEMENTS_FILE", cache_file):
            config = {**main.DEFAULT_CONFIG}
            if output_dir is not None:
                config["output_dir"] = str(root / output_dir)
                (root / output_dir).mkdir(parents=True, exist_ok=True)
            main.save_config(config)
            yield root, cache_file


def _get():
    return asyncio.run(main.get_achievements())


def _sync(delta):
    return asyncio.run(main.sync_achievements(main.AchievementsSyncRequest(delta=delta)))


def _reset():
    return asyncio.run(main.reset_achievements())


def _legacy_genome(root: Path, species="Felis_catus", assembly="GCA_000181335.5", taxid=9685):
    asm_dir = root / "out" / "local_data" / species / assembly
    asm_dir.mkdir(parents=True, exist_ok=True)
    (asm_dir / f"{assembly}.softmasked.fa.gz").write_bytes(b"\x1f\x8bFAKE")
    (asm_dir / f"{assembly}.assembly_report.txt").write_text(f"# Taxid: {taxid}\n", encoding="utf-8")
    (asm_dir / f"{assembly}.genome_manifest.json").write_text(json.dumps({
        "assembly": assembly,
        "assembly_name": "Felis_catus_9.0",
        "species_key": species,
        "scientific_name": species.replace("_", " "),
        "provider": "ensembl",
    }), encoding="utf-8")
    return asm_dir


class AchievementEndpointTests(unittest.TestCase):
    def test_progress_is_written_beside_the_notes_in_the_output_directory(self):
        with _app() as (root, _cache):
            _sync({"unlocked": {"scribe": "2026-01-01T00:00:00Z"}})
            sidecar = root / "out" / "local_data" / "achievements.json"
            self.assertTrue(sidecar.exists())
            self.assertIn("scribe", json.loads(sidecar.read_text())["unlocked"])

    def test_progress_from_before_an_output_directory_follows_the_user_into_it(self):
        with _app(output_dir=None) as (root, cache_file):
            _sync({"unlocked": {"scribe": "2026-01-01T00:00:00Z"}})
            self.assertTrue(cache_file.exists())

            config = main.load_config()
            config["output_dir"] = str(root / "later")
            (root / "later").mkdir()
            main.save_config(config)

            response = _get()
            self.assertIn("scribe", response["store"]["unlocked"])
            sidecar = root / "later" / "local_data" / "achievements.json"
            self.assertIn("scribe", json.loads(sidecar.read_text())["unlocked"])

    def test_genomes_already_on_disk_are_credited_with_their_clade(self):
        with _app() as (root, _cache):
            _legacy_genome(root)
            response = _get()
            key = "ensembl::Felis_catus::GCA_000181335.5"
            self.assertEqual(response["store"]["distinct"]["genome.downloaded"], [key])
            self.assertEqual(response["store"]["taxa"][key], 9685)
            # Felis, Carnivora and Mammalia are what the Catty achievement and its
            # neighbours are tested against.
            for clade in (9681, 33554, 40674):
                self.assertIn(clade, response["lineage_taxa"])

    def test_a_newer_store_blocks_writes_and_says_so(self):
        with _app() as (root, _cache):
            sidecar = root / "out" / "local_data" / "achievements.json"
            sidecar.parent.mkdir(parents=True, exist_ok=True)
            original = {"schema": store.STORE_SCHEMA + 1, "unlocked": {"scribe": {"at": "2026-01-01T00:00:00Z"}}}
            sidecar.write_text(json.dumps(original), encoding="utf-8")

            response = _sync({"unlocked": {"flip_it": "2026-02-01T00:00:00Z"}})

            self.assertTrue(response["readonly"])
            self.assertEqual(json.loads(sidecar.read_text()), original)
            messages = [w["message"] for w in main.get_config_warnings()]
            self.assertTrue(any("newer version" in m for m in messages))

    def test_reset_clears_every_copy_so_nothing_comes_back(self):
        with _app() as (root, cache_file):
            stale = store.empty_store()
            stale["unlocked"] = {"old": {"at": "2025-01-01T00:00:00Z"}}
            store.write_store(cache_file, stale)
            _sync({"unlocked": {"scribe": "2026-01-01T00:00:00Z"}, "settings": {"notifications": False}})

            response = _reset()

            self.assertEqual(response["store"]["unlocked"], {})
            self.assertEqual(response["store"]["settings"], {"notifications": False})
            self.assertTrue(response["backup_paths"])
            self.assertEqual(_get()["store"]["unlocked"], {})

    def test_downloads_are_not_recorded_during_a_tutorial(self):
        with _app() as (root, _cache):
            request = main.DownloadRequest(
                url="https://example.org/x.fa.gz", filename="x.fa.gz", species_key="Felis_catus",
                assembly="GCA_000181335.5", file_type="fasta", output_dir=str(root / "out"), taxid=9685,
            )
            with patch.object(main, "tutorial_session_workspace", return_value=str(root / "tut")):
                main._record_download_achievement(request)
            self.assertNotIn("genome.downloaded", _get()["store"]["distinct"])

            main._record_download_achievement(request)
            self.assertEqual(
                _get()["store"]["distinct"]["genome.downloaded"],
                ["ensembl::Felis_catus::GCA_000181335.5"],
            )

    def test_events_outside_the_configured_directory_do_not_count(self):
        # Another tool, or a test, deleting a genome in a directory of its own must not
        # write into the user's achievements.
        with _app() as (root, _cache):
            elsewhere = root / "elsewhere"
            asm_dir = elsewhere / "local_data" / "Felis_catus" / "GCA_000181335.5"
            asm_dir.mkdir(parents=True)
            (asm_dir / "GCA_000181335.5.softmasked.fa.gz").write_bytes(b"x")
            main.delete_local_files(main.DeleteLocalFilesRequest(
                output_dir=str(elsewhere), species_key="Felis_catus", assembly="GCA_000181335.5",
            ))
            self.assertNotIn("genome.deleted", _get()["store"]["distinct"])

    def test_only_sequence_and_annotation_count_as_a_download(self):
        with _app() as (root, _cache):
            request = main.DownloadRequest(
                url="https://example.org/x.tsv.gz", filename="x.tsv.gz", species_key="Felis_catus",
                assembly="GCA_000181335.5", file_type="homology", output_dir=str(root / "out"),
            )
            main._record_download_achievement(request)
            self.assertNotIn("genome.downloaded", _get()["store"]["distinct"])

    def test_deleting_a_genome_is_counted(self):
        with _app() as (root, _cache):
            _legacy_genome(root)
            main.delete_local_files(main.DeleteLocalFilesRequest(
                output_dir=str(root / "out"), species_key="Felis_catus", assembly="GCA_000181335.5",
            ))
            self.assertEqual(
                _get()["store"]["distinct"]["genome.deleted"],
                ["ensembl::Felis_catus::GCA_000181335.5"],
            )


if __name__ == "__main__":
    unittest.main()

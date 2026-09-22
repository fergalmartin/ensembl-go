import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


def _playlist():
    return {
        "id": "playlist_test",
        "name": "Test playlist",
        "description": "",
        "genomes": [
            {
                "key": "ensembl:Bos_taurus:ARS-UCD2.0",
                "species_key": "Bos_taurus",
                "assembly": "ARS-UCD2.0",
                "scientific_name": "Bos taurus",
                "provider": "ensembl",
            }
        ],
    }


class ConfigPlaylistPersistenceTests(unittest.TestCase):
    def test_cache_dir_can_use_electron_user_data_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with patch.dict(main.os.environ, {"ENSEMBL_GO_USER_DATA_DIR": str(root)}):
                self.assertEqual(main.get_cache_dir(), (root / "cache").resolve())

    def test_track_registry_is_persisted_with_output_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            cache_registry = root / "track_registry.json"
            output_dir = root / "output"
            track_file = root / "signal.bw"
            track_file.write_bytes(b"bw")

            with patch.object(main, "CONFIG_FILE", cache_file), \
                    patch.object(main, "DEFAULT_TRACK_REGISTRY_FILE", cache_registry), \
                    patch.object(main, "TRACK_REGISTRY_FILE", cache_registry):
                main.save_config({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                })

                created = asyncio.run(main.register_track(main.TrackRegistryEntry(
                    path=str(track_file),
                    label="Signal",
                    type="bigwig",
                )))

                sidecar = output_dir / "local_data" / main.OUTPUT_DIR_TRACK_REGISTRY_FILENAME
                self.assertTrue(sidecar.exists())
                saved_sidecar = json.loads(sidecar.read_text(encoding="utf-8"))
                self.assertEqual(saved_sidecar["tracks"][0]["id"], created["id"])
                self.assertFalse(cache_registry.exists())

    def test_legacy_track_registry_migrates_to_output_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            cache_registry = root / "track_registry.json"
            output_dir = root / "output"
            legacy = {
                "id": "trk_legacy",
                "path": str(root / "legacy.bw"),
                "label": "Legacy",
                "type": "bigwig",
                "display_mode": "signal_plot",
                "genome_key": "",
            }
            cache_registry.write_text(json.dumps({"tracks": [legacy]}), encoding="utf-8")

            with patch.object(main, "CONFIG_FILE", cache_file), \
                    patch.object(main, "DEFAULT_TRACK_REGISTRY_FILE", cache_registry), \
                    patch.object(main, "TRACK_REGISTRY_FILE", cache_registry):
                main.save_config({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                })

                payload = main.list_tracks()

                sidecar = output_dir / "local_data" / main.OUTPUT_DIR_TRACK_REGISTRY_FILENAME
                self.assertTrue(sidecar.exists())
                saved_sidecar = json.loads(sidecar.read_text(encoding="utf-8"))
                self.assertEqual(saved_sidecar["tracks"][0]["id"], legacy["id"])
                self.assertEqual(payload["tracks"][0]["id"], legacy["id"])

    def test_file_browser_defaults_to_local_data(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            output_dir = root / "output"

            with patch.object(main, "CONFIG_FILE", cache_file):
                main.save_config({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                })

                payload = asyncio.run(main.list_files("."))

            self.assertEqual(Path(payload["current_path"]).resolve(), (output_dir / "local_data").resolve())
            self.assertTrue((output_dir / "local_data").exists())
            self.assertTrue(payload["requested_path_valid"])

    def test_file_browser_reports_when_it_recovered_from_a_missing_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            payload = asyncio.run(main.list_files(str(root / "misspelled-directory")))

            self.assertEqual(Path(payload["current_path"]).resolve(), root.resolve())
            self.assertFalse(payload["requested_path_valid"])

    def test_playlists_are_persisted_with_output_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            output_dir = root / "output"
            playlist = _playlist()

            with patch.object(main, "CONFIG_FILE", cache_file):
                main.save_config({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                    "genome_playlists": [playlist],
                    "selected_genome_playlist_id": playlist["id"],
                })

                sidecar = output_dir / "local_data" / main.OUTPUT_DIR_PLAYLISTS_FILENAME
                self.assertTrue(sidecar.exists())
                saved_sidecar = json.loads(sidecar.read_text(encoding="utf-8"))
                self.assertEqual(saved_sidecar["genome_playlists"][0]["id"], playlist["id"])

                cache_file.write_text(json.dumps({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                    "genome_playlists": [],
                    "selected_genome_playlist_id": "__all__",
                }), encoding="utf-8")

                loaded = main.load_config()
            self.assertEqual(loaded["genome_playlists"][0]["id"], playlist["id"])
            self.assertEqual(loaded["selected_genome_playlist_id"], playlist["id"])

    def test_configuration_is_persisted_with_output_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            output_dir = root / "output"
            colors = ["#111111", "#222222", "#333333", "#444444", "#555555"]

            with patch.object(main, "CONFIG_FILE", cache_file):
                main.save_config({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                    "genome_browser_colors": colors,
                    "show_fps_counter": True,
                    "sv_hide_inactive_tracks": True,
                    "enable_sv_rust_render_bar": True,
                })

                sidecar = output_dir / "local_data" / main.OUTPUT_DIR_CONFIG_FILENAME
                self.assertTrue(sidecar.exists())
                saved_sidecar = json.loads(sidecar.read_text(encoding="utf-8"))
                self.assertEqual(saved_sidecar["config"]["genome_browser_colors"], colors)
                self.assertTrue(saved_sidecar["config"]["show_fps_counter"])
                self.assertTrue(saved_sidecar["config"]["sv_hide_inactive_tracks"])
                self.assertTrue(saved_sidecar["config"]["enable_sv_rust_render_bar"])

                cache_file.write_text(json.dumps({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                    "genome_browser_colors": main.DEFAULT_CONFIG["genome_browser_colors"],
                    "show_fps_counter": False,
                    "sv_hide_inactive_tracks": False,
                    "enable_sv_rust_render_bar": False,
                }), encoding="utf-8")

                loaded = main.load_config()
                self.assertEqual(loaded["genome_browser_colors"], colors)
                self.assertTrue(loaded["show_fps_counter"])
                self.assertTrue(loaded["sv_hide_inactive_tracks"])
                self.assertTrue(loaded["enable_sv_rust_render_bar"])

    def test_output_dir_config_endpoint_reads_sidecar(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "output"
            colors = ["#aa0000", "#00aa00", "#0000aa", "#aaaa00", "#00aaaa"]

            sidecar_dir = output_dir / "local_data"
            sidecar_dir.mkdir(parents=True)
            (sidecar_dir / main.OUTPUT_DIR_CONFIG_FILENAME).write_text(json.dumps({
                "version": 1,
                "config": {
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                    "genome_browser_colors": colors,
                    "default_light_mode": True,
                },
            }), encoding="utf-8")

            payload = asyncio.run(main.get_output_dir_config(output_dir=str(output_dir)))

            self.assertTrue(payload["found"])
            self.assertEqual(payload["config"]["genome_browser_colors"], colors)
            self.assertTrue(payload["config"]["default_light_mode"])

    def test_manual_config_load_accepts_wrapped_sidecar_format(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            config_path = root / "configuration.json"
            colors = ["#101010", "#202020", "#303030", "#404040", "#505050"]
            config_path.write_text(json.dumps({
                "version": 1,
                "config": {
                    **main.DEFAULT_CONFIG,
                    "genome_browser_colors": colors,
                    "sv_hide_inactive_tracks": True,
                },
            }), encoding="utf-8")

            with patch.object(main, "CONFIG_FILE", cache_file):
                loaded = asyncio.run(main.load_custom_config(main.LoadConfigRequest(path=str(config_path))))

            self.assertEqual(loaded["genome_browser_colors"], colors)
            self.assertTrue(loaded["sv_hide_inactive_tracks"])

    def test_output_dir_switch_imports_existing_configuration(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            old_output = root / "old_output"
            new_output = root / "new_output"
            colors = ["#123456", "#234567", "#345678", "#456789", "#56789a"]

            sidecar_dir = new_output / "local_data"
            sidecar_dir.mkdir(parents=True)
            (sidecar_dir / main.OUTPUT_DIR_CONFIG_FILENAME).write_text(json.dumps({
                "version": 1,
                "config": {
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(new_output),
                    "genome_browser_colors": colors,
                    "show_fps_counter": True,
                },
            }), encoding="utf-8")
            cache_file.write_text(json.dumps({
                **main.DEFAULT_CONFIG,
                "output_dir": str(old_output),
            }), encoding="utf-8")

            with patch.object(main, "CONFIG_FILE", cache_file):
                response = asyncio.run(main.update_config(main.ConfigUpdate(
                    output_dir=str(new_output),
                    genome_browser_colors=main.DEFAULT_CONFIG["genome_browser_colors"],
                    show_fps_counter=False,
                )))

            self.assertEqual(response["config"]["output_dir"], str(new_output))
            self.assertEqual(response["config"]["genome_browser_colors"], colors)
            self.assertTrue(response["config"]["show_fps_counter"])

    def test_output_dir_switch_imports_existing_playlists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            old_output = root / "old_output"
            new_output = root / "new_output"
            playlist = _playlist()

            sidecar_dir = new_output / "local_data"
            sidecar_dir.mkdir(parents=True)
            (sidecar_dir / main.OUTPUT_DIR_PLAYLISTS_FILENAME).write_text(json.dumps({
                "version": 1,
                "genome_playlists": [playlist],
                "selected_genome_playlist_id": playlist["id"],
            }), encoding="utf-8")
            cache_file.write_text(json.dumps({
                **main.DEFAULT_CONFIG,
                "output_dir": str(old_output),
                "genome_playlists": [],
                "selected_genome_playlist_id": "__all__",
            }), encoding="utf-8")

            with patch.object(main, "CONFIG_FILE", cache_file):
                response = asyncio.run(main.update_config(main.ConfigUpdate(
                    output_dir=str(new_output),
                    genome_playlists=[],
                    selected_genome_playlist_id="__all__",
                )))

            self.assertEqual(response["config"]["genome_playlists"][0]["id"], playlist["id"])
            self.assertEqual(response["config"]["selected_genome_playlist_id"], playlist["id"])

    def test_stale_empty_playlist_save_does_not_wipe_existing_playlists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            output_dir = root / "output"
            playlist = _playlist()

            with patch.object(main, "CONFIG_FILE", cache_file):
                main.save_config({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                    "genome_playlists": [playlist],
                    "selected_genome_playlist_id": playlist["id"],
                })
                response = asyncio.run(main.update_config(main.ConfigUpdate(
                    output_dir=str(output_dir),
                    genome_playlists=[],
                    selected_genome_playlist_id="__all__",
                )))

            self.assertEqual(response["config"]["genome_playlists"][0]["id"], playlist["id"])
            sidecar = output_dir / "local_data" / main.OUTPUT_DIR_PLAYLISTS_FILENAME
            saved_sidecar = json.loads(sidecar.read_text(encoding="utf-8"))
            self.assertEqual(saved_sidecar["genome_playlists"][0]["id"], playlist["id"])

    def test_explicit_playlist_clear_can_remove_all_playlists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            output_dir = root / "output"
            playlist = _playlist()

            with patch.object(main, "CONFIG_FILE", cache_file):
                main.save_config({
                    **main.DEFAULT_CONFIG,
                    "output_dir": str(output_dir),
                    "genome_playlists": [playlist],
                    "selected_genome_playlist_id": playlist["id"],
                })
                response = asyncio.run(main.update_config(main.ConfigUpdate(
                    output_dir=str(output_dir),
                    genome_playlists=[],
                    selected_genome_playlist_id="__all__",
                    clear_genome_playlists=True,
                )))

            self.assertEqual(response["config"]["genome_playlists"], [])
            sidecar = output_dir / "local_data" / main.OUTPUT_DIR_PLAYLISTS_FILENAME
            saved_sidecar = json.loads(sidecar.read_text(encoding="utf-8"))
            self.assertEqual(saved_sidecar["genome_playlists"], [])

    def test_cached_playlists_are_mirrored_to_output_dir_on_load(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            output_dir = root / "output"
            playlist = _playlist()
            cache_file.write_text(json.dumps({
                **main.DEFAULT_CONFIG,
                "output_dir": str(output_dir),
                "genome_playlists": [playlist],
                "selected_genome_playlist_id": playlist["id"],
            }), encoding="utf-8")

            with patch.object(main, "CONFIG_FILE", cache_file):
                loaded = main.load_config()

            sidecar = output_dir / "local_data" / main.OUTPUT_DIR_PLAYLISTS_FILENAME
            self.assertTrue(sidecar.exists())
            self.assertEqual(loaded["genome_playlists"][0]["id"], playlist["id"])

    def test_playlists_are_persisted_with_working_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            working_dir = root / "working"
            playlist = _playlist()

            with patch.object(main, "CONFIG_FILE", cache_file):
                main.save_config({
                    **main.DEFAULT_CONFIG,
                    "working_dir": str(working_dir),
                    "genome_playlists": [playlist],
                    "selected_genome_playlist_id": playlist["id"],
                })

                sidecar = working_dir / "local_data" / main.OUTPUT_DIR_PLAYLISTS_FILENAME
                self.assertTrue(sidecar.exists())

                cache_file.write_text(json.dumps({
                    **main.DEFAULT_CONFIG,
                    "working_dir": str(working_dir),
                    "genome_playlists": [],
                    "selected_genome_playlist_id": "__all__",
                }), encoding="utf-8")

                loaded = main.load_config()
                self.assertEqual(loaded["genome_playlists"][0]["id"], playlist["id"])
                self.assertEqual(loaded["selected_genome_playlist_id"], playlist["id"])

    def test_working_dir_switch_imports_existing_playlists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            old_working = root / "old_working"
            new_working = root / "new_working"
            playlist = _playlist()

            sidecar_dir = new_working / "local_data"
            sidecar_dir.mkdir(parents=True)
            (sidecar_dir / main.OUTPUT_DIR_PLAYLISTS_FILENAME).write_text(json.dumps({
                "version": 1,
                "genome_playlists": [playlist],
                "selected_genome_playlist_id": playlist["id"],
            }), encoding="utf-8")
            cache_file.write_text(json.dumps({
                **main.DEFAULT_CONFIG,
                "working_dir": str(old_working),
                "genome_playlists": [],
                "selected_genome_playlist_id": "__all__",
            }), encoding="utf-8")

            with patch.object(main, "CONFIG_FILE", cache_file):
                response = asyncio.run(main.update_config(main.ConfigUpdate(
                    working_dir=str(new_working),
                    genome_playlists=[],
                    selected_genome_playlist_id="__all__",
                )))

            self.assertEqual(response["config"]["genome_playlists"][0]["id"], playlist["id"])
            self.assertEqual(response["config"]["selected_genome_playlist_id"], playlist["id"])

    def test_loader_prefers_non_empty_playlist_sidecar(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "output"
            working_dir = root / "working"
            playlist = _playlist()

            output_sidecar_dir = output_dir / "local_data"
            output_sidecar_dir.mkdir(parents=True)
            (output_sidecar_dir / main.OUTPUT_DIR_PLAYLISTS_FILENAME).write_text(json.dumps({
                "version": 1,
                "genome_playlists": [],
                "selected_genome_playlist_id": "__all__",
            }), encoding="utf-8")
            working_sidecar_dir = working_dir / "local_data"
            working_sidecar_dir.mkdir(parents=True)
            (working_sidecar_dir / main.OUTPUT_DIR_PLAYLISTS_FILENAME).write_text(json.dumps({
                "version": 1,
                "genome_playlists": [playlist],
                "selected_genome_playlist_id": playlist["id"],
            }), encoding="utf-8")

            state = main._load_playlist_state_for_config({
                "output_dir": str(output_dir),
                "working_dir": str(working_dir),
            })

            self.assertEqual(state["genome_playlists"][0]["id"], playlist["id"])

    def test_playlist_endpoint_reads_sidecar_for_output_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "output"
            playlist = _playlist()

            sidecar_dir = output_dir / "local_data"
            sidecar_dir.mkdir(parents=True)
            (sidecar_dir / main.OUTPUT_DIR_PLAYLISTS_FILENAME).write_text(json.dumps({
                "version": 1,
                "genome_playlists": [playlist],
                "selected_genome_playlist_id": playlist["id"],
            }), encoding="utf-8")

            state = asyncio.run(main.get_config_playlists(output_dir=str(output_dir)))

            self.assertEqual(state["genome_playlists"][0]["id"], playlist["id"])

    def test_per_genome_colours_round_trip_through_the_config_endpoint(self):
        """A genome's colour is part of the saved configuration, not a view's state.

        The frontend keys these on the assembly, so they are opaque strings here;
        what matters is that a map survives the save/load round trip intact
        rather than being flattened or dropped as an unrecognised key.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_file = root / "cache.json"
            assignments = {
                "ensembl::homo_sapiens::GCA_000001405.29": "#f59e0b",
                "ensembl::mus_musculus::GCA_000001635.9": "#8b5cf6",
            }
            palette = ["#123456", "#abcdef"]

            with patch.object(main, "CONFIG_FILE", cache_file):
                asyncio.run(main.update_config(main.ConfigUpdate(
                    genome_default_color="#00b692",
                    genome_colors=assignments,
                    genome_color_palette=palette,
                )))

                loaded = main.load_config()
                self.assertEqual(loaded["genome_default_color"], "#00b692")
                self.assertEqual(loaded["genome_colors"], assignments)
                self.assertEqual(loaded["genome_color_palette"], palette)

    def test_colour_keys_are_recognised_configuration(self):
        for key in ("genome_default_color", "genome_colors", "genome_color_palette"):
            self.assertIn(key, main.RECOGNIZED_CONFIG_KEYS)
        # The positional list it replaced is kept only so a configuration written
        # before the change can still be read and migrated.
        self.assertEqual(main.DEFAULT_CONFIG["genome_browser_colors"], [])
        self.assertEqual(main.DEFAULT_CONFIG["genome_default_color"], "#3366cc")


if __name__ == "__main__":
    unittest.main()

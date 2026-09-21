"""Settings must survive a version change, and an unreadable one must not break the app.

Two promises are tested here. A working directory written by another version either
loads, converts, or is declined with an explanation — never parsed on a guess and never
overwritten. And a configuration that cannot be read costs the user their preferences,
not their access to a directory holding genomes, indices and notes.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


COLOURS = {"ensembl:Bos_taurus:ARS-UCD2.0": "#ff0000"}


class CompatBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.output_dir = root / "output"
        self.config_file = root / "cache.json"
        self.local_data = self.output_dir / "local_data"
        self.local_data.mkdir(parents=True)
        self.sidecar = self.local_data / main.OUTPUT_DIR_CONFIG_FILENAME
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(lambda: [main.clear_config_warning(w["key"]) for w in main.get_config_warnings()])

    def write_sidecar(self, version, config=None, revision=1):
        self.sidecar.write_text(json.dumps({
            "version": version,
            "revision": revision,
            "config": {**main.DEFAULT_CONFIG, **(config or {})},
        }), encoding="utf-8")

    def config(self, **overrides):
        return {**main.DEFAULT_CONFIG, "output_dir": str(self.output_dir), **overrides}

    def save(self, config, **kwargs):
        with patch.object(main, "CONFIG_FILE", self.config_file):
            main.save_config(config, **kwargs)

    def warning_keys(self):
        return {w["key"] for w in main.get_config_warnings()}


class SchemaVersioning(CompatBase):
    def test_current_version_loads(self):
        self.write_sidecar(main.SIDECAR_SCHEMA_VERSION, {"genome_colors": COLOURS})
        state = main._load_config_state_from_path(self.sidecar)
        self.assertEqual(state["genome_colors"], COLOURS)

    def test_file_without_a_version_is_treated_as_current(self):
        """Everything written before this existed. It must keep loading."""
        self.sidecar.write_text(json.dumps({"config": {"genome_colors": COLOURS}}), encoding="utf-8")
        state = main._load_config_state_from_path(self.sidecar)
        self.assertEqual(state["genome_colors"], COLOURS)

    def test_newer_version_is_declined_and_reported(self):
        self.write_sidecar(main.SIDECAR_SCHEMA_VERSION + 1, {"genome_colors": COLOURS})
        self.assertIsNone(main._load_config_state_from_path(self.sidecar))
        self.assertIn(f"sidecar:{self.sidecar}", self.warning_keys())

    def test_newer_version_is_never_overwritten(self):
        """Declining to read it is worthless if the next save downgrades it."""
        self.write_sidecar(main.SIDECAR_SCHEMA_VERSION + 1, {"genome_colors": COLOURS})
        before = self.sidecar.read_text(encoding="utf-8")
        self.save(self.config())
        self.assertEqual(self.sidecar.read_text(encoding="utf-8"), before)

    def test_an_older_version_is_converted_on_read(self):
        """Registering a migration is all a future format change should need."""
        with patch.dict(main._SIDECAR_MIGRATIONS, {}, clear=True), \
                patch.object(main, "SIDECAR_SCHEMA_VERSION", 2):
            @main.sidecar_migration(1)
            def _v1_to_v2(doc):
                doc["config"]["genome_default_color"] = doc["config"].pop("legacy_colour")
                return doc

            self.sidecar.write_text(json.dumps({
                "version": 1, "revision": 1,
                "config": {**main.DEFAULT_CONFIG, "legacy_colour": "#abcdef"},
            }), encoding="utf-8")
            state = main._load_config_state_from_path(self.sidecar)
            self.assertEqual(state["genome_default_color"], "#abcdef")

    def test_an_unconvertible_old_version_is_declined(self):
        with patch.dict(main._SIDECAR_MIGRATIONS, {}, clear=True), \
                patch.object(main, "SIDECAR_SCHEMA_VERSION", 3):
            self.write_sidecar(1, {"genome_colors": COLOURS})
            self.assertIsNone(main._load_config_state_from_path(self.sidecar))
            self.assertIn(f"sidecar:{self.sidecar}", self.warning_keys())


class UnreadableFilesDoNotBreakTheApp(CompatBase):
    def test_corrupt_sidecar_is_reported_and_kept(self):
        self.sidecar.write_text("{ not json", encoding="utf-8")
        self.assertIsNone(main._load_config_state_from_path(self.sidecar))
        self.assertIn(f"sidecar:{self.sidecar}", self.warning_keys())
        self.save(self.config())
        self.assertEqual(self.sidecar.read_text(encoding="utf-8"), "{ not json")

    def test_corrupt_sidecar_still_allows_the_directory_to_be_used(self):
        """The point of the exercise: the genomes are still reachable."""
        self.sidecar.write_text("{ not json", encoding="utf-8")
        with patch.object(main, "CONFIG_FILE", self.config_file):
            main.save_config(self.config())
            loaded = main.load_config()
        self.assertEqual(loaded["output_dir"], str(self.output_dir))

    def test_corrupt_config_file_falls_back_and_is_preserved(self):
        self.config_file.write_text("{ not json", encoding="utf-8")
        with patch.object(main, "CONFIG_FILE", self.config_file):
            main.invalidate_config_cache()
            loaded = main.load_config()
        self.assertEqual(loaded["genome_colors"], {})       # defaults, not a crash
        self.assertIn("config-file", self.warning_keys())
        self.assertTrue((self.config_file.parent / f"{self.config_file.name}.corrupt").exists())

    def test_a_readable_config_clears_the_warning(self):
        main.record_config_warning("config-file", "stale", self.config_file)
        self.config_file.write_text(json.dumps({"output_dir": str(self.output_dir)}), encoding="utf-8")
        with patch.object(main, "CONFIG_FILE", self.config_file):
            main.invalidate_config_cache()
            main.load_config()
        self.assertNotIn("config-file", self.warning_keys())

    def test_warnings_are_deduplicated_per_file(self):
        self.sidecar.write_text("{ not json", encoding="utf-8")
        for _ in range(3):
            main._load_config_state_from_path(self.sidecar)
        self.assertEqual(len(main.get_config_warnings()), 1)


if __name__ == "__main__":
    unittest.main()

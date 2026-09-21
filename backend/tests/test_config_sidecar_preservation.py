"""The output-directory sidecar must not lose settings to a configuration that has not read it.

A fresh install pointed at an existing data directory used to flatten the colours the user
had assigned their genomes: every save rewrites every key of the sidecar from memory, and
a configuration that has not yet adopted the directory has `{}` for all of them. The
genomes, notes and indices survived because they live in their own files. These did not.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


COLOURS = {"ensembl:Bos_taurus:ARS-UCD2.0": "#ff0000", "ensembl:Mus_musculus:GRCm39": "#00ff00"}


def _sidecar(output_dir: Path) -> Path:
    return output_dir / "local_data" / main.OUTPUT_DIR_CONFIG_FILENAME


def _read(output_dir: Path) -> dict:
    return json.loads(_sidecar(output_dir).read_text(encoding="utf-8"))["config"]


class ConfigSidecarPreservationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.output_dir = root / "output"
        self.config_file = root / "cache.json"
        self.addCleanup(self._tmp.cleanup)

    def _save(self, **overrides):
        with patch.object(main, "CONFIG_FILE", self.config_file):
            main.save_config({
                **main.DEFAULT_CONFIG,
                "output_dir": str(self.output_dir),
                **overrides,
            })

    def test_settled_config_writes_colours_to_the_sidecar(self):
        self._save(genome_colors=COLOURS, genome_browser_colors=["#111111"])
        stored = _read(self.output_dir)
        self.assertEqual(stored["genome_colors"], COLOURS)
        self.assertEqual(stored["genome_browser_colors"], ["#111111"])

    def test_unadopted_config_does_not_blank_stored_colours(self):
        """The regression: a fresh configuration saving over an existing directory."""
        self._save(genome_colors=COLOURS, genome_browser_colors=["#111111"])
        self._save()  # defaults throughout — genome_colors={}, as a fresh install has
        stored = _read(self.output_dir)
        self.assertEqual(stored["genome_colors"], COLOURS)
        self.assertEqual(stored["genome_browser_colors"], ["#111111"])

    def test_changed_colours_still_propagate(self):
        """The guard must not freeze the sidecar: a real edit has to reach it."""
        self._save(genome_colors=COLOURS)
        changed = {"ensembl:Bos_taurus:ARS-UCD2.0": "#0000ff"}
        self._save(genome_colors=changed)
        self.assertEqual(_read(self.output_dir)["genome_colors"], changed)

    def test_cascade_cleared_paths_are_not_preserved(self):
        """Emptying an index path is deliberate and must still propagate."""
        self._save(ref_index="/tmp/stale.index")
        self._save(ref_index="")
        self.assertEqual(_read(self.output_dir)["ref_index"], "")

    def test_previous_sidecar_is_backed_up(self):
        self._save(genome_colors=COLOURS)
        self._save(genome_colors={"ensembl:Bos_taurus:ARS-UCD2.0": "#0000ff"})
        backup = _sidecar(self.output_dir).parent / f"{main.OUTPUT_DIR_CONFIG_FILENAME}.bak"
        self.assertTrue(backup.exists())
        self.assertEqual(
            json.loads(backup.read_text(encoding="utf-8"))["config"]["genome_colors"],
            COLOURS,
        )

    def test_fresh_config_adopts_the_directory_colours(self):
        """Pointing a fresh config at the directory recovers what is stored there."""
        self._save(genome_colors=COLOURS)
        fresh = {**main.DEFAULT_CONFIG, "output_dir": str(self.output_dir)}
        merged = main._merge_output_dir_config_state(fresh)
        self.assertEqual(merged["genome_colors"], COLOURS)
        self.assertEqual(merged["output_dir"], str(self.output_dir))


if __name__ == "__main__":
    unittest.main()

"""The output-directory sidecar must replicate the user's state, including emptiness.

Pointing an installation at a working directory should reproduce what the user left
there. Two failures are possible and this covers both: a configuration that has not read
the directory overwriting it with defaults (which lost a user their genome colours,
playlists and selections), and a configuration that has read it being unable to record a
deliberate change — deselecting every genome, clearing a playlist, putting the colours
back to the default are all states the user chose and must find again.

The discriminator is whether the configuration adopted the sidecar, not what its values
look like: a fresh configuration's `dim_non_selected_genes=True` is indistinguishable
from a chosen one.
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
PLAYLIST = {"id": "pl_1", "name": "Models", "description": "", "genomes": []}
SPECIES = [{"key": "ensembl:Bos_taurus:ARS-UCD2.0", "species_key": "Bos_taurus"}]


class SidecarBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.output_dir = root / "output"
        self.config_file = root / "cache.json"
        self.addCleanup(self._tmp.cleanup)

    @property
    def sidecar(self):
        return self.output_dir / "local_data" / main.OUTPUT_DIR_CONFIG_FILENAME

    @property
    def playlist_file(self):
        return self.output_dir / "local_data" / main.OUTPUT_DIR_PLAYLISTS_FILENAME

    def stored(self):
        return json.loads(self.sidecar.read_text(encoding="utf-8"))["config"]

    def stored_playlists(self):
        return json.loads(self.playlist_file.read_text(encoding="utf-8"))["genome_playlists"]

    def unadopted(self, **overrides):
        """What a fresh installation holds: defaults, having read nothing."""
        return {**main.DEFAULT_CONFIG, "output_dir": str(self.output_dir), **overrides}

    def adopted(self, **overrides):
        """A configuration that has read the directory, as the running app has."""
        config = self.unadopted()
        config = main._merge_output_dir_config_state(config)
        config = main._merge_output_dir_playlist_state(config)
        config = main._record_sidecar_revisions(config)
        return {**config, **overrides}

    def save(self, config, **kwargs):
        with patch.object(main, "CONFIG_FILE", self.config_file):
            main.save_config(config, **kwargs)


class UnadoptedWritesAreRefused(SidecarBase):
    def test_first_write_creates_the_sidecar(self):
        self.save(self.unadopted(genome_colors=COLOURS))
        self.assertEqual(self.stored()["genome_colors"], COLOURS)

    def test_fresh_install_does_not_flatten_containers(self):
        self.save(self.unadopted(genome_colors=COLOURS, genome_playlists=[PLAYLIST], active_species=SPECIES))
        self.save(self.unadopted())  # a fresh install pointed at the same directory
        stored = self.stored()
        self.assertEqual(stored["genome_colors"], COLOURS)
        self.assertEqual(stored["active_species"], SPECIES)
        self.assertEqual(len(self.stored_playlists()), 1)

    def test_fresh_install_does_not_reset_scalar_preferences(self):
        """The emptiness heuristic could not see these: they are never empty."""
        self.save(self.unadopted(
            dim_non_selected_genes=False,
            browsing_control_scheme="trackpad",
            genome_default_color="#ff00ff",
            active_app_buttons=["home"],
            default_light_mode=True,
        ))
        self.save(self.unadopted())
        stored = self.stored()
        self.assertFalse(stored["dim_non_selected_genes"])
        self.assertEqual(stored["browsing_control_scheme"], "trackpad")
        self.assertEqual(stored["genome_default_color"], "#ff00ff")
        self.assertEqual(stored["active_app_buttons"], ["home"])
        self.assertTrue(stored["default_light_mode"])


class AdoptedWritesReplicateState(SidecarBase):
    def test_deselecting_every_genome_propagates(self):
        self.save(self.unadopted(active_species=SPECIES))
        self.save(self.adopted(active_species=[]))
        self.assertEqual(self.stored()["active_species"], [])

    def test_clearing_every_playlist_propagates(self):
        self.save(self.unadopted(genome_playlists=[PLAYLIST]))
        self.save(self.adopted(genome_playlists=[]))
        self.assertEqual(self.stored_playlists(), [])
        self.assertEqual(self.stored()["genome_playlists"], [])

    def test_resetting_colours_to_default_propagates(self):
        self.save(self.unadopted(genome_colors=COLOURS, genome_default_color="#ff00ff"))
        self.save(self.adopted(genome_colors={}, genome_default_color="#3366cc"))
        stored = self.stored()
        self.assertEqual(stored["genome_colors"], {})
        self.assertEqual(stored["genome_default_color"], "#3366cc")

    def test_ordinary_edits_propagate(self):
        self.save(self.unadopted(genome_colors=COLOURS))
        changed = {"ensembl:Bos_taurus:ARS-UCD2.0": "#0000ff"}
        self.save(self.adopted(genome_colors=changed))
        self.assertEqual(self.stored()["genome_colors"], changed)

    def test_consecutive_saves_are_allowed(self):
        """Writing bumps the revision; the in-memory config must keep up."""
        self.save(self.unadopted(genome_colors=COLOURS))
        config = self.adopted()
        for colour in ("#111111", "#222222", "#333333"):
            config["genome_default_color"] = colour
            self.save(config)
        self.assertEqual(self.stored()["genome_default_color"], "#333333")

    def test_cascade_cleared_paths_still_clear(self):
        self.save(self.unadopted(ref_index="/tmp/stale.index"))
        self.save(self.adopted(ref_index=""))
        self.assertEqual(self.stored()["ref_index"], "")


class DamagedAndForcedWrites(SidecarBase):
    def test_unreadable_sidecar_is_left_alone(self):
        """A file we cannot parse is a file we must not replace."""
        self.save(self.unadopted(genome_colors=COLOURS))
        self.sidecar.write_text("{ this is not json", encoding="utf-8")
        self.save(self.unadopted())
        self.assertEqual(self.sidecar.read_text(encoding="utf-8"), "{ this is not json")

    def test_importing_a_configuration_overrides(self):
        """force_sidecar is how an explicit import replaces what the directory holds."""
        self.save(self.unadopted(genome_colors=COLOURS))
        self.save(self.unadopted(genome_colors={}), force_sidecar=True)
        self.assertEqual(self.stored()["genome_colors"], {})

    def test_previous_sidecar_is_backed_up(self):
        self.save(self.unadopted(genome_colors=COLOURS))
        self.save(self.adopted(genome_colors={"x": "#0000ff"}))
        backup = self.sidecar.parent / f"{main.OUTPUT_DIR_CONFIG_FILENAME}.bak"
        self.assertTrue(backup.exists())
        self.assertEqual(json.loads(backup.read_text(encoding="utf-8"))["config"]["genome_colors"], COLOURS)

    def test_revision_advances_on_each_write(self):
        self.save(self.unadopted(genome_colors=COLOURS))
        first = json.loads(self.sidecar.read_text(encoding="utf-8"))["revision"]
        self.save(self.adopted(genome_default_color="#abcdef"))
        second = json.loads(self.sidecar.read_text(encoding="utf-8"))["revision"]
        self.assertGreater(second, first)


class AdoptionRecoversState(SidecarBase):
    def test_fresh_config_adopts_everything_the_directory_holds(self):
        self.save(self.unadopted(
            genome_colors=COLOURS,
            genome_playlists=[PLAYLIST],
            active_species=SPECIES,
            dim_non_selected_genes=False,
        ))
        recovered = main._merge_output_dir_playlist_state(
            main._merge_output_dir_config_state(self.unadopted())
        )
        self.assertEqual(recovered["genome_colors"], COLOURS)
        self.assertEqual(recovered["active_species"], SPECIES)
        self.assertEqual(len(recovered["genome_playlists"]), 1)
        self.assertFalse(recovered["dim_non_selected_genes"])
        self.assertEqual(recovered["output_dir"], str(self.output_dir))


if __name__ == "__main__":
    unittest.main()

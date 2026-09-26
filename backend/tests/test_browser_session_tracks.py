import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    BrowserSessionTracksEntry,
    clear_browser_session_tracks,
    get_browser_session_tracks,
    put_browser_session_tracks,
)

HUMAN = "ensembl::Homo_sapiens::GCA_000001405.29"
PIG = "ensembl::Sus_scrofa::GCA_000003025.6"


class BrowserSessionTrackTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        # Beside a scratch registry, never the user's.
        self._patch = patch("main.TRACK_REGISTRY_FILE", self.tmp / "track_registry.json")
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def test_saved_per_assembly_beside_the_registry(self):
        put_browser_session_tracks(BrowserSessionTracksEntry(
            genome_key=HUMAN + "::dataset::ensembl/2025_12",
            entries=[
                {"type": "track", "track_id": "trk_a", "visible": False},
                {"type": "group", "group_id": "grp_j"},
                {"type": "group_track", "group_id": "grp_s", "track_id": "trk_b", "visible": True},
                {"type": "track"},  # no id
                {"type": "nonsense", "track_id": "x"},
                "junk",
            ],
        ))
        put_browser_session_tracks(BrowserSessionTracksEntry(genome_key=PIG, entries=[{"type": "track", "track_id": "trk_p"}]))
        self.assertTrue((self.tmp / "browser_session_tracks.json").exists())
        genomes = get_browser_session_tracks()["genomes"]
        self.assertEqual(sorted(genomes), [HUMAN, PIG])
        self.assertEqual(genomes[HUMAN]["entries"], [
            {"type": "track", "visible": False, "track_id": "trk_a"},
            {"type": "group", "visible": True, "group_id": "grp_j"},
            {"type": "group_track", "visible": True, "track_id": "trk_b", "group_id": "grp_s"},
        ])

    def test_no_entries_forgets_a_genome_and_clear_forgets_all(self):
        put_browser_session_tracks(BrowserSessionTracksEntry(genome_key=HUMAN, entries=[{"type": "track", "track_id": "trk_a"}]))
        put_browser_session_tracks(BrowserSessionTracksEntry(genome_key=PIG, entries=[{"type": "track", "track_id": "trk_p"}]))
        put_browser_session_tracks(BrowserSessionTracksEntry(genome_key=HUMAN, entries=[]))
        self.assertEqual(list(get_browser_session_tracks()["genomes"]), [PIG])
        clear_browser_session_tracks()
        self.assertEqual(get_browser_session_tracks(), {"genomes": {}})
        clear_browser_session_tracks()  # nothing there: still fine

    def test_needs_a_genome(self):
        with self.assertRaises(HTTPException):
            put_browser_session_tracks(BrowserSessionTracksEntry(genome_key="  ", entries=[]))


if __name__ == "__main__":
    unittest.main()

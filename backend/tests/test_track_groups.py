import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    TrackGroupEntry,
    TrackGroupMember,
    TrackGroupUpdateEntry,
    TrackRegistryEntry,
    TrackRegistryUpdateEntry,
    _track_assembly_key,
    create_track_group,
    delete_track,
    delete_track_group,
    list_tracks,
    register_track,
    update_track,
    update_track_group,
)

HUMAN = "ensembl::Homo_sapiens::GCA_000001405.29"
PIG = "ensembl::Sus_scrofa::GCA_000003025.6"


class TrackGroupTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        # Tracks and groups go to a scratch registry, never the user's.
        self._patch = patch("main.TRACK_REGISTRY_FILE", self.tmp / "track_registry.json")
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def _track(self, name, genome_key, **extra):
        path = self.tmp / name
        path.write_bytes(b"x")
        entry = TrackRegistryEntry(path=str(path), label=name, genome_key=genome_key, **extra)
        return asyncio.run(register_track(entry))

    def test_assembly_key_ignores_dataset_suffix(self):
        self.assertEqual(_track_assembly_key(HUMAN + "::dataset::ensembl/2025_12"), HUMAN)
        self.assertEqual(_track_assembly_key(f"  {HUMAN} "), HUMAN)

    def test_create_keeps_order_and_takes_the_genome_of_the_tracks(self):
        a = self._track("a.bw", HUMAN, type="bigwig")
        b = self._track("b.bw", HUMAN + "::dataset::ensembl/2025_12", type="bigwig")
        group = create_track_group(TrackGroupEntry(
            label="  Lung   ATAC ",
            members=[TrackGroupMember(track_id=b["id"]), TrackGroupMember(track_id=a["id"]), TrackGroupMember(track_id=b["id"])],
        ))
        self.assertEqual(group["label"], "Lung ATAC")
        self.assertEqual(group["layout"], "separate")
        self.assertEqual(_track_assembly_key(group["genome_key"]), HUMAN)
        self.assertEqual([m["track_id"] for m in group["members"]], [b["id"], a["id"]])
        self.assertIsNone(group["members"][0]["settings"])

        listed = list_tracks()
        self.assertEqual([g["id"] for g in listed["groups"]], [group["id"]])

    def test_a_group_holds_one_genome_and_needs_a_name(self):
        a = self._track("a.bw", HUMAN, type="bigwig")
        p = self._track("p.bw", PIG, type="bigwig")
        with self.assertRaises(HTTPException) as mixed:
            create_track_group(TrackGroupEntry(label="Mixed", members=[TrackGroupMember(track_id=a["id"]), TrackGroupMember(track_id=p["id"])]))
        self.assertEqual(mixed.exception.status_code, 400)
        with self.assertRaises(HTTPException) as unnamed:
            create_track_group(TrackGroupEntry(label="   ", members=[TrackGroupMember(track_id=a["id"])]))
        self.assertEqual(unnamed.exception.status_code, 400)
        self.assertEqual(list_tracks()["groups"], [])

    def test_member_settings_are_the_groups_own_and_normalised(self):
        a = self._track("a.bw", HUMAN, type="bigwig", display_mode="signal_plot", bigwig_settings={"data_type": "atac_seq"})
        group = create_track_group(TrackGroupEntry(label="G", members=[
            TrackGroupMember(track_id=a["id"], settings={"display_mode": "zoned_heatmap", "bigwig_settings": {"data_type": "atac_seq", "zone_scale": "fixed"}, "label": "ignored"}),
        ]))
        own = group["members"][0]["settings"]
        self.assertEqual(own["display_mode"], "zoned_heatmap")
        self.assertEqual(own["bigwig_settings"]["zone_scale"], "fixed")
        self.assertNotIn("label", own)
        # The track itself is untouched.
        track = next(t for t in list_tracks()["tracks"] if t["id"] == a["id"])
        self.assertEqual(track["display_mode"], "signal_plot")

    def test_update_renames_reorders_and_changes_layout(self):
        a = self._track("a.bed", HUMAN, type="bed")
        b = self._track("b.bed", HUMAN, type="bed")
        group = create_track_group(TrackGroupEntry(label="G", members=[TrackGroupMember(track_id=a["id"]), TrackGroupMember(track_id=b["id"])]))
        updated = update_track_group(group["id"], TrackGroupUpdateEntry(
            label="Renamed", layout="joined", members=[TrackGroupMember(track_id=b["id"]), TrackGroupMember(track_id=a["id"])],
        ))
        self.assertEqual(updated["label"], "Renamed")
        self.assertEqual(updated["layout"], "joined")
        self.assertEqual([m["track_id"] for m in updated["members"]], [b["id"], a["id"]])
        self.assertEqual(update_track_group(group["id"], TrackGroupUpdateEntry(layout="sideways"))["layout"], "separate")

    def test_deleting_or_moving_a_track_takes_it_out_of_groups(self):
        a = self._track("a.bw", HUMAN, type="bigwig")
        b = self._track("b.bw", HUMAN, type="bigwig")
        c = self._track("c.bw", HUMAN, type="bigwig")
        group = create_track_group(TrackGroupEntry(label="G", members=[TrackGroupMember(track_id=x["id"]) for x in (a, b, c)]))
        delete_track(a["id"])
        # Re-pointing at the same assembly (a dataset suffix) keeps it; another genome does not.
        update_track(b["id"], TrackRegistryUpdateEntry(genome_key=HUMAN + "::dataset::ensembl/2025_12"))
        update_track(c["id"], TrackRegistryUpdateEntry(genome_key=PIG))
        listed = next(g for g in list_tracks()["groups"] if g["id"] == group["id"])
        self.assertEqual([m["track_id"] for m in listed["members"]], [b["id"]])

    def test_deleting_a_group_keeps_its_tracks(self):
        a = self._track("a.bw", HUMAN, type="bigwig")
        group = create_track_group(TrackGroupEntry(label="G", members=[TrackGroupMember(track_id=a["id"])]))
        delete_track_group(group["id"])
        listed = list_tracks()
        self.assertEqual(listed["groups"], [])
        self.assertEqual([t["id"] for t in listed["tracks"]], [a["id"]])
        with self.assertRaises(HTTPException):
            delete_track_group(group["id"])


if __name__ == "__main__":
    unittest.main()

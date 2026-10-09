"""A genome's stats cache must keep every section, whoever writes to it.

The genome browser, the analysis overview and the Stats view all ask for stats
summaries, often at the same moment, and a structural run saves as it goes. Saves
used to truncate the file and write it in place, and each caller saved the copy it
had loaded at the start: a reader arriving mid-write saw no cache at all, and a
stale copy saved last threw away what others had added. Structural stats that had
been generated disappeared both ways.
"""

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stats_utils import load_stats_cache, save_stats_cache, update_stats_cache  # noqa: E402

SPECIES = {"species_key": "Test_species", "assembly": "GCA_1", "assembly_name": "Test1"}
FINGERPRINTS = {"index": {"path": "/x/index.db", "exists": True, "size": 1, "mtime_ns": 1}}


class StatsCacheWritesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "GCA_1.stats.v1.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_save_leaves_no_temporary_file_behind(self):
        save_stats_cache(self.path, {"sections": {"annotation": {"n": 1}}})
        self.assertEqual([p.name for p in self.path.parent.iterdir()], [self.path.name])

    def test_readers_never_see_a_partly_written_file(self):
        big = {"sections": {"structural": {"values": list(range(20000))}}}
        save_stats_cache(self.path, big)
        stop = threading.Event()
        empty_reads = []

        def read():
            while not stop.is_set():
                if load_stats_cache(self.path) == {}:
                    empty_reads.append(1)

        reader = threading.Thread(target=read)
        reader.start()
        for _ in range(60):
            save_stats_cache(self.path, big)
        stop.set()
        reader.join()
        self.assertEqual(empty_reads, [])

    def test_a_stale_writer_keeps_a_section_added_since_it_loaded(self):
        update_stats_cache(self.path, SPECIES, FINGERPRINTS, {"annotation": {"n": 1}}, {"annotation": "t1"})
        # A structural run saves after a summary request has already loaded the cache.
        update_stats_cache(self.path, SPECIES, FINGERPRINTS, {"structural": {"ok": True}}, {"structural": "t2"})
        # The summary request then saves only what it computed.
        update_stats_cache(self.path, SPECIES, FINGERPRINTS, {"assembly": {"fasta": {}}}, {"assembly": "t3"})
        cache = json.loads(self.path.read_text())
        self.assertEqual(set(cache["sections"]), {"annotation", "structural", "assembly"})
        self.assertEqual(cache["computed_at"], {"annotation": "t1", "structural": "t2", "assembly": "t3"})
        self.assertEqual(cache["source_fingerprints"], FINGERPRINTS)

    def test_dropping_a_section_keeps_the_rest_and_the_fingerprints(self):
        update_stats_cache(
            self.path, SPECIES, FINGERPRINTS,
            {"annotation": {"n": 1}, "structural": {"ok": True}}, {"annotation": "t1", "structural": "t2"},
        )
        update_stats_cache(self.path, None, None, drop=("structural",))
        cache = json.loads(self.path.read_text())
        self.assertEqual(list(cache["sections"]), ["annotation"])
        self.assertEqual(cache["computed_at"], {"annotation": "t1"})
        self.assertEqual(cache["source_fingerprints"], FINGERPRINTS)
        self.assertEqual(cache["genome"]["species_key"], "Test_species")

    def test_concurrent_writers_each_keep_their_own_section(self):
        names = [f"section_{i}" for i in range(12)]
        threads = [
            threading.Thread(target=update_stats_cache, args=(self.path, SPECIES, FINGERPRINTS, {name: {"v": name}}, {name: "t"}))
            for name in names
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(set(json.loads(self.path.read_text())["sections"]), set(names))


if __name__ == "__main__":
    unittest.main()

"""Stats must find the annotation index on disk, not only in the saved record.

The stats endpoints read ``files.index`` from the genome record the client
sends, and that record is the snapshot taken when the genome was registered. A
RefSeq download registers before its index exists, so the snapshot's ``index``
stays empty for ever: annotation stats reported "missing" for a genome whose
index was sitting beside its GFF3, and a structural run gave up the moment it
started and dropped the button straight back to "generate".
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from stats_utils import choose_stats_cache_path  # noqa: E402


TOY_GFF = (
    "##gff-version 3\n"
    "chr1\ttest\tgene\t1\t100\t.\t+\t.\tID=g1;Name=G1;biotype=protein_coding\n"
    "chr1\ttest\tmRNA\t1\t100\t.\t+\t.\tID=t1;Parent=g1;biotype=protein_coding\n"
    "chr1\ttest\texon\t1\t100\t.\t+\t.\tID=e1;Parent=t1\n"
)


class StatsIndexRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.release_dir = (
            self.root / "local_data" / "ncbi" / "Homo_sapiens" / "GCF_000001405.40"
            / "datasets" / "ncbi" / "current"
        )
        self.release_dir.mkdir(parents=True)
        self.gff = self.release_dir / "GCF_000001405.40.genomic.gff"
        self.gff.write_text(TOY_GFF)
        self.cfg = {"output_dir": str(self.root)}
        with main._RECOVERED_INDEX_GUARD:
            main._RECOVERED_INDEX_PATHS.clear()

    def tearDown(self):
        with main._RECOVERED_INDEX_GUARD:
            main._RECOVERED_INDEX_PATHS.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def _species(self, **files):
        return {
            "species_key": "Homo_sapiens",
            "assembly": "GCF_000001405.40",
            "provider": "ncbi",
            "dataset_release_key": "ncbi/current",
            "files": {"gff3": str(self.gff), "index": "", "fasta": "", **files},
        }

    def test_an_index_built_after_registration_is_picked_up(self):
        db = self.release_dir / "GCF_000001405.40.genomic.gff3.index.db"
        main.ensure_gff_index(str(self.gff), str(db))

        resolved = main._stats_species_with_index(self._species(), self.cfg)
        self.assertEqual(
            main._normalize_fs_path(resolved["files"]["index"]),
            main._normalize_fs_path(str(db)),
        )

    def test_an_index_that_does_not_exist_yet_is_not_claimed(self):
        # Browsing may name a build target because the browser polls until it
        # lands. Stats have nothing to poll on, so an unbuilt index has to stay
        # reported as missing rather than as a genome that is ready to read.
        resolved = main._stats_species_with_index(self._species(), self.cfg)
        self.assertEqual(resolved["files"]["index"], "")

    def test_a_record_that_already_names_a_real_index_is_left_alone(self):
        db = self.release_dir / "explicit.index.db"
        main.ensure_gff_index(str(self.gff), str(db))
        species = self._species(index=str(db))
        self.assertIs(main._stats_species_with_index(species, self.cfg), species)

    def test_a_genome_without_an_annotation_is_left_alone(self):
        species = self._species()
        species["files"]["gff3"] = ""
        self.assertIs(main._stats_species_with_index(species, self.cfg), species)


class StatsCacheNamingTests(unittest.TestCase):
    """The cache lives beside the data, so its name has to survive an upgrade."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.release_dir = (
            self.root / "local_data" / "ncbi" / "Homo_sapiens" / "GCF_000001405.40"
            / "datasets" / "ncbi" / "current"
        )
        self.release_dir.mkdir(parents=True)
        self.gff = self.release_dir / "GCF_000001405.40.genomic.gff"
        self.gff.write_text(TOY_GFF)
        self.species = {
            "species_key": "Homo_sapiens",
            "assembly": "GCF_000001405.40",
            "provider": "ncbi",
            "dataset_release_key": "ncbi/current",
            "files": {"gff3": str(self.gff)},
        }

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _cache_path(self):
        return choose_stats_cache_path(self.species, str(self.root), main.CACHE_DIR)

    def test_the_annotation_extension_is_stripped_from_the_cache_name(self):
        self.assertEqual(
            self._cache_path().name,
            "GCF_000001405.40.genomic.stats.v1.json",
        )

    def test_a_cache_written_under_the_old_name_is_still_used(self):
        # Structural stats take minutes to compute. Renaming the file they live
        # in must not quietly throw them away.
        legacy = self.release_dir / "GCF_000001405.40.genomic.gff.stats.v1.json"
        legacy.write_text("{}")
        self.assertEqual(self._cache_path(), legacy.resolve())

    def test_the_current_name_wins_when_both_are_present(self):
        legacy = self.release_dir / "GCF_000001405.40.genomic.gff.stats.v1.json"
        legacy.write_text("{}")
        current = self.release_dir / "GCF_000001405.40.genomic.stats.v1.json"
        current.write_text("{}")
        self.assertEqual(self._cache_path(), current.resolve())

    def test_a_gff3_annotation_keeps_the_name_it_always_had(self):
        gff3 = self.release_dir / "GCA_000001405.29.gff3.gz"
        gff3.write_bytes(b"")
        self.species["files"]["gff3"] = str(gff3)
        self.assertEqual(self._cache_path().name, "GCA_000001405.29.stats.v1.json")


if __name__ == "__main__":
    unittest.main()

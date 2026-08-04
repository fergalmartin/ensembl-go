"""Removing a genome's data — what may be deleted and what must never be.

The rules live in backend/removal_rules.py. The case that matters most is a
manually added genome: the app writes an index, sidecars and sometimes a
converted annotation beside files the user supplied, and those files are the ones
it must not touch. Every "protected" assertion here is a file a user would be
right to be upset about losing.
"""

import asyncio
import gzip
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
import removal_rules  # noqa: E402

CONVERTED_HEADER = (
    "##gff-version 3\n"
    "##sequence-region 1 1 1000\n"
    "#!ensembl-go-converted 2026-07-30T00:00:00Z from genes.gtf.gz (gtf)\n"
)


def _write(path: Path, text: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _write_gzip(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write(text)
    return path


def _write_index(path: Path, source_gff: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO metadata VALUES ('source_gff', ?)", (str(source_gff.resolve()),))
        conn.commit()
    finally:
        conn.close()
    return path


def _entry(root: Path, **overrides):
    entry = {
        "species_key": "My_species",
        "assembly": "asm1",
        "provider": "manual",
        "is_manual": True,
        "selection_key": "manual::My_species::asm1",
        "files": {
            "fasta": str(root / "genome.fa"),
            "gff3": str(root / "genes.gff3"),
        },
    }
    entry.update(overrides)
    return entry


def _plan(entry, **kwargs):
    return removal_rules.plan_manual_genome_removal(entry, **kwargs)


def _paths(plan):
    return {item.path for item in plan.deletable}


def _protected(plan):
    return {item["path"] for item in plan.protected}


class ManualGenomeRuleTests(unittest.TestCase):
    def test_user_files_are_protected_while_our_sidecars_go(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            fasta = _write(root / "genome.fa", ">1\nACGT\n")
            gff = _write(root / "genes.gff3", "##gff-version 3\n")
            fai = _write(root / "genome.fa.fai")
            tbi = _write(root / "genes.gff3.tbi")
            index = _write_index(root / "genes.gff3.index.db", gff)
            lock = _write(root / "genes.gff3.index.db.build.lock", "")

            plan = _plan(_entry(root), index_basename="genes.gff3.index.db")

            self.assertEqual(
                _paths(plan),
                {str(fai), str(tbi), str(index), str(lock)},
            )
            self.assertIn(str(fasta), _protected(plan))
            self.assertIn(str(gff), _protected(plan))

    def test_converted_annotation_is_deletable_only_with_its_pragma(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            converted = _write(root / "genes.ensembl.gff3", CONVERTED_HEADER)

            plan = _plan(_entry(root, files={"fasta": str(root / "genome.fa"), "gff3": str(converted)}))

            self.assertIn(str(converted), _paths(plan))

    def test_a_file_named_like_a_conversion_but_written_by_the_user_is_protected(self):
        # The whole reason the pragma is checked rather than the filename.
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            lookalike = _write(root / "genes.ensembl.gff3", "##gff-version 3\n1\t.\tgene\t1\t9\t.\t+\t.\tID=g1\n")

            plan = _plan(_entry(root, files={"fasta": str(root / "genome.fa"), "gff3": str(lookalike)}))

            self.assertNotIn(str(lookalike), _paths(plan))
            self.assertIn(str(lookalike), _protected(plan))

    def test_gzipped_conversion_is_detected_through_the_compression(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            converted = _write_gzip(root / "genes.ensembl.gff3.gz", CONVERTED_HEADER)

            plan = _plan(_entry(root, files={"fasta": str(root / "genome.fa"), "gff3": str(converted)}))

            self.assertIn(str(converted), _paths(plan))

    def test_recorded_provenance_is_enough_without_reading_the_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            converted = _write(root / "genes.ensembl.gff3.gz", "not even gzip")
            source = _write(root / "genes.gtf.gz", "user file")

            entry = _entry(
                root,
                files={"fasta": str(root / "genome.fa"), "gff3": str(converted)},
                artifacts={"converted_annotation": str(converted), "source_annotation": str(source)},
            )
            plan = _plan(entry)

            self.assertIn(str(converted), _paths(plan))
            self.assertIn(str(source), _protected(plan))
            self.assertNotIn(str(source), _paths(plan))

    def test_id_map_is_deleted_only_when_the_import_recorded_it(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            _write(root / "genes.gff3", "##gff-version 3\n")
            id_map = _write(root / "id_map.tsv", "old\tnew\n")

            self.assertNotIn(str(id_map), _paths(_plan(_entry(root))))

            entry = _entry(root, artifacts={"id_map": str(id_map)})
            self.assertIn(str(id_map), _paths(_plan(entry)))

    def test_index_belonging_to_another_annotation_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            gff = _write(root / "genes.gff3", "##gff-version 3\n")
            other_gff = _write(root / "other.gff3", "##gff-version 3\n")
            ours = _write_index(root / "genes.gff3.index.db", gff)
            theirs = _write_index(root / "other.gff3.index.db", other_gff)

            plan = _plan(_entry(root), index_basename="genes.gff3.index.db")

            self.assertIn(str(ours), _paths(plan))
            self.assertNotIn(str(theirs), _paths(plan))

    def test_a_file_that_is_not_an_index_is_never_deleted_as_one(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            _write(root / "genes.gff3", "##gff-version 3\n")
            impostor = _write(root / "genes.gff3.index.db", "definitely not sqlite")

            plan = _plan(_entry(root), index_basename="genes.gff3.index.db")

            self.assertNotIn(str(impostor), _paths(plan))


class DecompressedFastaTests(unittest.TestCase):
    """The GB-scale copy the app makes of a plain-gzip FASTA."""

    def _setup(self, root: Path, bgzip: bool):
        magic = b"\x1f\x8b\x08\x04" if bgzip else b"\x1f\x8b\x08\x00"
        (root / "genome.fa.gz").write_bytes(magic + b"payload")
        plain = _write(root / "genome.fa", ">1\nACGT\n")
        _write(root / "genes.gff3", "##gff-version 3\n")
        entry = _entry(root, files={"fasta": str(root / "genome.fa.gz"), "gff3": str(root / "genes.gff3")})
        return entry, plain

    def test_plain_gzip_copy_is_ours_to_delete(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            entry, plain = self._setup(root, bgzip=False)
            self.assertIn(str(plain), _paths(_plan(entry)))

    def test_a_bgzipped_fasta_is_never_decompressed_so_the_sibling_is_the_users(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            entry, plain = self._setup(root, bgzip=True)
            plan = _plan(entry)
            self.assertNotIn(str(plain), _paths(plan))

    def test_another_genomes_fasta_is_never_taken(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            entry, plain = self._setup(root, bgzip=False)
            foreign = removal_rules.collect_seed_paths([
                {"files": {"fasta": str(plain)}},
            ])
            plan = _plan(entry, foreign_seeds=foreign)
            self.assertNotIn(str(plain), _paths(plan))
            self.assertIn(str(plain), _protected(plan))


class SharedDirectoryTests(unittest.TestCase):
    def test_two_manual_genomes_in_one_directory_do_not_delete_each_other(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "a.fa")
            gff_a = _write(root / "a.gff3", "##gff-version 3\n")
            index_a = _write_index(root / "a.gff3.index.db", gff_a)
            _write(root / "b.fa")
            gff_b = _write(root / "b.gff3", "##gff-version 3\n")
            index_b = _write_index(root / "b.gff3.index.db", gff_b)

            entry_a = _entry(root, files={"fasta": str(root / "a.fa"), "gff3": str(gff_a)})
            entry_b = _entry(root, files={"fasta": str(root / "b.fa"), "gff3": str(gff_b)})
            foreign = removal_rules.collect_seed_paths([entry_b])

            plan = _plan(entry_a, foreign_seeds=foreign, index_basename="a.gff3.index.db")

            self.assertIn(str(index_a), _paths(plan))
            self.assertNotIn(str(index_b), _paths(plan))
            self.assertNotIn(str(gff_b), _paths(plan))
            self.assertNotIn(str(root / "b.fa"), _paths(plan))

    def test_a_shared_fasta_keeps_its_sidecars(self):
        # Two manual genomes registered against one FASTA: removing the first
        # must not delete the index the second still needs.
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            fasta = _write(root / "shared.fa", ">1\nACGT\n")
            fai = _write(root / "shared.fa.fai", "index")
            gff_a = _write(root / "a.gff3", "##gff-version 3\n")
            _write(root / "b.gff3", "##gff-version 3\n")

            entry_a = _entry(root, files={"fasta": str(fasta), "gff3": str(gff_a)})
            entry_b = _entry(root, files={"fasta": str(fasta), "gff3": str(root / "b.gff3")})

            plan = _plan(entry_a, foreign_seeds=removal_rules.collect_seed_paths([entry_b]))

            self.assertNotIn(str(fai), _paths(plan))
            self.assertIn(str(fasta), _protected(plan))

    def test_a_conversion_with_thousands_of_sequence_regions_is_still_recognised(self):
        # The provenance pragma is written after one ##sequence-region per
        # sequence, so a fragmented assembly buries it a long way into the file.
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            header = ["##gff-version 3"]
            header += [f"##sequence-region contig_{index} 1 500000" for index in range(4000)]
            header.append("#!ensembl-go-converted 2026-07-30T00:00:00Z from genes.gtf.gz (gtf)")
            converted = _write_gzip(root / "genes.ensembl.gff3.gz", "\n".join(header) + "\n1\t.\tgene\t1\t9\t.\t+\t.\tID=g1\n")

            plan = _plan(_entry(root, files={"fasta": str(root / "genome.fa"), "gff3": str(converted)}))

            self.assertIn(str(converted), _paths(plan))

    def test_symlinks_are_reported_not_followed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            _write(root / "genes.gff3", "##gff-version 3\n")
            real = _write(root / "real.fai", "content")
            link = root / "genome.fa.fai"
            link.symlink_to(real)

            plan = _plan(_entry(root))

            self.assertNotIn(str(link), _paths(plan))
            self.assertTrue(real.exists())


class PlanTokenTests(unittest.TestCase):
    def test_token_changes_when_the_files_change(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _write(root / "genome.fa")
            _write(root / "genes.gff3", "##gff-version 3\n")
            _write(root / "genome.fa.fai", "one")

            first = removal_rules.plan_token([_plan(_entry(root))])
            _write(root / "genome.fa.fai", "one and a bit more")
            second = removal_rules.plan_token([_plan(_entry(root))])

            self.assertNotEqual(first, second)


class EndpointTests(unittest.TestCase):
    """The API layer: preview writes nothing, delete reports per genome."""

    def _config(self, root: Path, entries):
        return {
            "output_dir": str(root),
            "manual_species": entries,
            "active_species": [],
        }

    def _preview(self, root: Path, descriptors, entries):
        request = main.GenomeRemovalRequest(output_dir=str(root), genomes=descriptors)
        with patch.object(main, "load_config", return_value=self._config(root, entries)):
            return asyncio.run(main.preview_genome_removal(request))

    def _remove(self, root: Path, descriptors, entries, plan_token=""):
        request = main.GenomeRemovalRequest(
            output_dir=str(root), genomes=descriptors, plan_token=plan_token
        )
        with patch.object(main, "load_config", return_value=self._config(root, entries)):
            return asyncio.run(main.remove_genome_data(request))

    def _manual_fixture(self, root: Path):
        home = root / "my-genomes"
        _write(home / "genome.fa", ">1\nACGT\n")
        gff = _write(home / "genes.gff3", "##gff-version 3\n")
        _write(home / "genome.fa.fai", "index")
        _write_index(home / "genes.gff3.index.db", gff)
        entry = _entry(home)
        descriptor = main.GenomeRemovalDescriptor(
            genome_key="manual::My_species::asm1",
            species_key="My_species",
            assembly="asm1",
            provider="manual",
            is_manual=True,
        )
        return home, entry, descriptor

    def test_preview_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            home, entry, descriptor = self._manual_fixture(root)

            def _snapshot():
                return {
                    str(path.relative_to(home)): path.read_bytes()
                    for path in sorted(home.rglob("*")) if path.is_file()
                }

            before = _snapshot()
            payload = self._preview(root, [descriptor], [entry])
            after = _snapshot()

            self.assertEqual(before, after)
            self.assertGreater(payload["totals"]["files"], 0)
            self.assertTrue(payload["plan_token"])

    def test_remove_deletes_our_files_and_keeps_the_users(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            home, entry, descriptor = self._manual_fixture(root)

            result = self._remove(root, [descriptor], [entry])

            self.assertEqual(result["results"][0]["status"], "deleted")
            self.assertFalse((home / "genome.fa.fai").exists())
            self.assertFalse((home / "genes.gff3.index.db").exists())
            self.assertTrue((home / "genome.fa").exists(), "the user's FASTA must survive")
            self.assertTrue((home / "genes.gff3").exists(), "the user's annotation must survive")

    def test_a_genome_that_is_currently_selected_still_has_its_artifacts_removed(self):
        # The genome being removed is normally also the one in use; its own files
        # must not be mistaken for another genome's.
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            home, entry, descriptor = self._manual_fixture(root)
            config = self._config(root, [entry])
            config["active_species"] = [entry]

            request = main.GenomeRemovalRequest(output_dir=str(root), genomes=[descriptor])
            with patch.object(main, "load_config", return_value=config):
                result = asyncio.run(main.remove_genome_data(request))

            self.assertEqual(result["results"][0]["status"], "deleted")
            self.assertFalse((home / "genome.fa.fai").exists())
            self.assertTrue((home / "genome.fa").exists())

    def test_a_stale_plan_token_is_rejected_before_anything_is_deleted(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            home, entry, descriptor = self._manual_fixture(root)

            with self.assertRaises(main.HTTPException) as ctx:
                self._remove(root, [descriptor], [entry], plan_token="not-the-current-plan")

            self.assertEqual(ctx.exception.status_code, 409)
            self.assertTrue((home / "genome.fa.fai").exists())

    def test_a_matching_plan_token_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            home, entry, descriptor = self._manual_fixture(root)

            token = self._preview(root, [descriptor], [entry])["plan_token"]
            result = self._remove(root, [descriptor], [entry], plan_token=token)

            self.assertEqual(result["results"][0]["status"], "deleted")

    def test_one_failure_does_not_stop_the_batch(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            home, entry, descriptor = self._manual_fixture(root)
            doomed = str(home / "genome.fa.fai")
            real_unlink = Path.unlink

            def _explode(self, *args, **kwargs):
                if str(self) == doomed:
                    raise PermissionError("locked by another process")
                return real_unlink(self, *args, **kwargs)

            with patch.object(Path, "unlink", _explode):
                result = self._remove(root, [descriptor], [entry])

            row = result["results"][0]
            self.assertEqual(row["status"], "partial")
            self.assertEqual([item["path"] for item in row["failed"]], [doomed])
            self.assertFalse((home / "genes.gff3.index.db").exists(), "the rest still went")

    def test_removing_twice_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            _home, entry, descriptor = self._manual_fixture(root)

            self._remove(root, [descriptor], [entry])
            again = self._remove(root, [descriptor], [entry])

            self.assertEqual(again["results"][0]["status"], "nothing_to_delete")

    def test_downloaded_genome_plan_matches_the_delete_endpoint_rules(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
            _write(asm_dir / "assembly" / "GCA_000005845.2.softmasked.fa.bgz")
            _write(asm_dir / "assembly" / "GCA_000005845.2.softmasked.fa.bgz.fai")
            _write(asm_dir / "datasets" / "ensembl" / "2025_12" / "GCA_000005845.2.gff3.gz")
            _write(asm_dir / "trackhub" / "RegBuild.bb", "hub data")
            (asm_dir / "GCA_000005845.2.genome_manifest.json").write_text(
                json.dumps({"manifest_version": 2, "assembly": "GCA_000005845.2"}), encoding="utf-8"
            )
            descriptor = main.GenomeRemovalDescriptor(
                genome_key="ensembl::Test_species::GCA_000005845.2",
                species_key="Test_species",
                assembly="GCA_000005845.2",
                provider="ensembl",
            )

            # Attached hubs may contain millions of files. A removal preview
            # only reports that the directory stays and must never walk it to
            # calculate a size.
            with patch.object(
                removal_rules,
                "directory_size",
                side_effect=AssertionError("track hubs must not be recursively sized"),
            ):
                payload = self._preview(root, [descriptor], [])
            plan = payload["plans"][0]
            deletable = {item["path"] for item in plan["deletable"]}

            expected, _kept = main._downloaded_assembly_files(
                asm_dir, "GCA_000005845.2", main._load_genome_manifest(asm_dir, "GCA_000005845.2")
            )
            self.assertTrue(deletable.issuperset({str(path) for path in expected}))
            self.assertIn(
                str(asm_dir / "GCA_000005845.2.genome_manifest.json"), deletable
            )
            self.assertEqual(
                [item["path"] for item in plan["left_in_place"]], [str(asm_dir / "trackhub")]
            )

            self._remove(root, [descriptor], [])
            self.assertTrue((asm_dir / "trackhub" / "RegBuild.bb").exists())
            self.assertFalse((asm_dir / "assembly").exists())

    def test_custom_imported_annotation_copy_is_deletable_but_its_source_is_named(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            asm_dir = root / "local_data" / "Test_species" / "GCA_000005845.2"
            source = _write(root / "mine" / "my_genes.gff3", "##gff-version 3\n")
            copy = _write(
                asm_dir / "datasets" / "custom" / "mine" / "GCA_000005845.2.my_genes.gff3", "##gff-version 3\n"
            )
            (asm_dir / "GCA_000005845.2.genome_manifest.json").write_text(
                json.dumps({
                    "manifest_version": 2,
                    "assembly": "GCA_000005845.2",
                    "dataset_releases": {
                        "custom/mine": {
                            "key": "custom/mine",
                            "files": {"gff3": {"path": str(copy), "url": "", "source_path": str(source)}},
                        }
                    },
                }),
                encoding="utf-8",
            )
            descriptor = main.GenomeRemovalDescriptor(
                species_key="Test_species", assembly="GCA_000005845.2", provider="ensembl"
            )

            plan = self._preview(root, [descriptor], [])["plans"][0]

            self.assertIn(str(copy), {item["path"] for item in plan["deletable"]})
            self.assertIn(str(source), {item["path"] for item in plan["protected"]})

            self._remove(root, [descriptor], [])
            self.assertFalse(copy.exists())
            self.assertTrue(source.exists(), "the annotation the user imported must survive")

    def test_path_traversal_in_the_descriptor_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            descriptor = main.GenomeRemovalDescriptor(
                species_key="../../etc", assembly="passwd", provider="ensembl"
            )
            with self.assertRaises(main.HTTPException) as ctx:
                self._preview(root, [descriptor], [])
            self.assertEqual(ctx.exception.status_code, 400)

    def test_empty_request_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            request = main.GenomeRemovalRequest(output_dir=str(Path(tmpdir).resolve()), genomes=[])
            with self.assertRaises(main.HTTPException) as ctx:
                asyncio.run(main.preview_genome_removal(request))
            self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()

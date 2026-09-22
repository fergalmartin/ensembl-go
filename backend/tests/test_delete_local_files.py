"""Deleting downloaded genomes from local_data.

The delete used to act only on files the manifest listed with a download URL.
Genomes fetched before manifests recorded individual files list nothing, so their
delete was rejected with "Custom genomes must be deleted manually" — a 400 on a
perfectly ordinary downloaded genome — and even for a current manifest the
sidecars we generate afterwards (.fai, .gzi, .index.db) were left behind.

Deletion now works from what is on disk in the managed assembly directory, while
still refusing to remove files the user supplied.
"""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402

ASSEMBLY = "GCA_000005845.2"
SPECIES = "Test_species"


def _write(path: Path, payload: bytes = b"\x1f\x8bFAKE") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def _delete(root: Path, **kwargs):
    request = main.DeleteLocalFilesRequest(
        output_dir=str(root),
        species_key=SPECIES,
        assembly=ASSEMBLY,
        **kwargs,
    )
    return asyncio.run(main.delete_local_files(request))


class LegacyLayoutDeleteTests(unittest.TestCase):
    """Genomes downloaded before the manifest recorded individual files."""

    def _legacy_genome(self, root: Path) -> Path:
        asm_dir = root / "local_data" / SPECIES / ASSEMBLY
        for name in (
            f"{ASSEMBLY}.softmasked.fa",
            f"{ASSEMBLY}.softmasked.fa.gz",
            f"{ASSEMBLY}.softmasked.fa.fai",
            f"{ASSEMBLY}.gff3.gz",
            f"{ASSEMBLY}.gff3.index.db",
            f"{ASSEMBLY}.assembly_report.txt",
            f"{ASSEMBLY}.{SPECIES}-{ASSEMBLY}-2024_11-homology.tsv.gz",
        ):
            _write(asm_dir / name)
        # Identity-only manifest, as written before manifest_version existed.
        (asm_dir / f"{ASSEMBLY}.genome_manifest.json").write_text(
            json.dumps({
                "assembly": ASSEMBLY,
                "assembly_name": "ASM584v2",
                "species_key": SPECIES,
                "scientific_name": "Test species",
                "provider": "ensembl",
            }),
            encoding="utf-8",
        )
        return asm_dir

    def test_delete_removes_every_downloaded_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = self._legacy_genome(root)

            result = _delete(root)

            self.assertEqual(result["status"], "deleted")
            self.assertEqual(result["deleted_files"], 7)
            self.assertFalse(asm_dir.exists(), "empty directories should be pruned")

    def test_listing_reports_the_genome_as_deletable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self._legacy_genome(root)

            items = main.list_local_assemblies(str(root))
            item = next(entry for entry in items if entry["assembly"] == ASSEMBLY)

            self.assertTrue(item["download_managed"])
            self.assertEqual(item["delete_blocked_reason"], "")

    def test_deleting_the_legacy_release_keeps_the_assembly_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = self._legacy_genome(root)

            result = _delete(root, dataset_release_key=main.LEGACY_DATASET_RELEASE_KEY)

            self.assertEqual(result["deleted_files"], 3)  # gff3, index, homology
            self.assertTrue((asm_dir / f"{ASSEMBLY}.softmasked.fa").exists())
            self.assertTrue((asm_dir / f"{ASSEMBLY}.assembly_report.txt").exists())
            self.assertFalse((asm_dir / f"{ASSEMBLY}.gff3.gz").exists())
            self.assertFalse((asm_dir / f"{ASSEMBLY}.gff3.index.db").exists())


class ManagedLayoutDeleteTests(unittest.TestCase):
    def _managed_genome(self, root: Path) -> Path:
        asm_dir = root / "local_data" / SPECIES / ASSEMBLY
        fasta = _write(asm_dir / "assembly" / f"{ASSEMBLY}.softmasked.fa.bgz")
        _write(asm_dir / "assembly" / f"{ASSEMBLY}.softmasked.fa.bgz.fai")
        gff = _write(asm_dir / "datasets" / "ensembl" / "2025_12" / f"{ASSEMBLY}.gff3.gz")
        _write(asm_dir / "datasets" / "ensembl" / "2025_12" / f"{ASSEMBLY}.gff3.index.db")
        _write(asm_dir / "datasets" / "ensembl" / "2024_01" / f"{ASSEMBLY}.gff3.gz")
        # A leftover from before this genome's directory was reorganised.
        _write(asm_dir / f"{ASSEMBLY}.softmasked.fa")
        (asm_dir / f"{ASSEMBLY}.genome_manifest.json").write_text(
            json.dumps({
                "manifest_version": 2,
                "assembly": ASSEMBLY,
                "species_key": SPECIES,
                "active_dataset_release_key": "ensembl/2025_12",
                "assembly_files": {
                    "fasta": {"type": "fasta", "path": str(fasta), "url": "https://example.org/f.fa.bgz"},
                },
                "dataset_releases": {
                    "ensembl/2025_12": {
                        "key": "ensembl/2025_12", "source": "ensembl", "date": "2025_12",
                        "files": {"gff3": {"type": "gff3", "path": str(gff), "url": "https://example.org/g.gff3.gz"}},
                    },
                },
            }),
            encoding="utf-8",
        )
        return asm_dir

    def test_delete_also_removes_generated_sidecars_and_older_releases(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = self._managed_genome(root)

            result = _delete(root)

            self.assertEqual(result["deleted_files"], 6)
            self.assertFalse(asm_dir.exists())

    def test_release_scoped_delete_touches_only_that_release(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = self._managed_genome(root)

            result = _delete(root, dataset_release_key="ensembl/2025_12")

            self.assertEqual(result["deleted_files"], 2)
            self.assertFalse((asm_dir / "datasets" / "ensembl" / "2025_12").exists())
            self.assertTrue((asm_dir / "datasets" / "ensembl" / "2024_01" / f"{ASSEMBLY}.gff3.gz").exists())
            self.assertTrue((asm_dir / "assembly" / f"{ASSEMBLY}.softmasked.fa.bgz").exists())
            manifest = json.loads((asm_dir / f"{ASSEMBLY}.genome_manifest.json").read_text())
            self.assertNotIn("ensembl/2025_12", manifest.get("dataset_releases") or {})

    def test_unknown_release_is_a_404(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self._managed_genome(root)

            with self.assertRaises(main.HTTPException) as ctx:
                _delete(root, dataset_release_key="ensembl/1999_01")
            self.assertEqual(ctx.exception.status_code, 404)


class UserSuppliedFileTests(unittest.TestCase):
    """Files the user brought in are never deleted for them."""

    def _custom_release(self, asm_dir: Path) -> Path:
        custom = _write(asm_dir / "datasets" / "custom" / "mine" / f"{ASSEMBLY}.mine.gff3.gz")
        _write(asm_dir / "datasets" / "custom" / "mine" / "source_mine.gff3")
        return custom

    def test_custom_only_genome_is_refused(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / SPECIES / ASSEMBLY
            custom = self._custom_release(asm_dir)
            (asm_dir / f"{ASSEMBLY}.genome_manifest.json").write_text(
                json.dumps({
                    "manifest_version": 2,
                    "assembly": ASSEMBLY,
                    "species_key": SPECIES,
                    "dataset_releases": {
                        "custom/mine": {
                            "key": "custom/mine", "source": "custom", "date": "mine",
                            "files": {"gff3": {"type": "gff3", "path": str(custom), "url": ""}},
                        },
                    },
                }),
                encoding="utf-8",
            )

            with self.assertRaises(main.HTTPException) as ctx:
                _delete(root)

            self.assertEqual(ctx.exception.status_code, 400)
            self.assertTrue(custom.exists())

    def test_downloaded_files_go_and_custom_annotation_stays(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / SPECIES / ASSEMBLY
            fasta = _write(asm_dir / "assembly" / f"{ASSEMBLY}.softmasked.fa.bgz")
            custom = self._custom_release(asm_dir)
            manifest_path = asm_dir / f"{ASSEMBLY}.genome_manifest.json"
            manifest_path.write_text(
                json.dumps({
                    "manifest_version": 2,
                    "assembly": ASSEMBLY,
                    "species_key": SPECIES,
                    "assembly_files": {
                        "fasta": {"type": "fasta", "path": str(fasta), "url": "https://example.org/f.fa.bgz"},
                    },
                    "dataset_releases": {
                        "custom/mine": {
                            "key": "custom/mine", "source": "custom", "date": "mine",
                            "files": {"gff3": {"type": "gff3", "path": str(custom), "url": ""}},
                        },
                    },
                }),
                encoding="utf-8",
            )

            result = _delete(root)

            self.assertEqual(result["deleted_files"], 1)
            self.assertFalse(fasta.exists())
            self.assertTrue(custom.exists())
            self.assertTrue(manifest_path.exists(), "the custom release is still described by the manifest")


class EmptyAssemblyTests(unittest.TestCase):
    def test_missing_directory_is_a_404(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises(main.HTTPException) as ctx:
                _delete(Path(tmpdir))
            self.assertEqual(ctx.exception.status_code, 404)

    def test_directory_without_downloads_is_a_404(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / SPECIES / ASSEMBLY
            _write(asm_dir / "notes.txt", b"hello")

            with self.assertRaises(main.HTTPException) as ctx:
                _delete(root)
            self.assertEqual(ctx.exception.status_code, 404)
            self.assertTrue((asm_dir / "notes.txt").exists())


if __name__ == "__main__":
    unittest.main()

"""The demo genome the Getting Started tutorial installs.

The point of these is that the demo genome must be indistinguishable from a downloaded
one everywhere it matters: it lists, it indexes, and — the easy thing to get wrong — it
can be deleted again through the ordinary genome-removal UI rather than being stranded
in the user's data directory forever.
"""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import demo_genome  # noqa: E402
import main  # noqa: E402
from genome_identity import iter_local_assembly_dirs  # noqa: E402


class DemoGenomeFixtureTests(unittest.TestCase):
    def test_the_bundled_fixture_is_present_and_named_as_the_installer_expects(self):
        source = demo_genome.demo_source_dir()
        self.assertTrue(source.is_dir(), f"missing bundled demo genome at {source}")
        for name in demo_genome.DEMO_FILES:
            self.assertTrue((source / name).is_file(), f"missing {name}")

    def test_the_joke_genes_are_actually_in_the_annotation(self):
        gff = (demo_genome.demo_source_dir() / "demo.gff3").read_text(encoding="utf-8")
        names = [
            line.split("\t")[8].split("Name=")[1].split(";")[0]
            for line in gff.splitlines()
            if not line.startswith("#") and line.split("\t")[2] == "gene"
        ]
        self.assertEqual(names, ["Welcome", "To", "Ensembl", "Go", "Have", "Fun"])

    def test_the_fixture_stays_small_enough_to_ship(self):
        total = sum(p.stat().st_size for p in demo_genome.demo_source_dir().iterdir() if p.is_file())
        self.assertLess(total, 512 * 1024, "the demo genome has grown past a comfortable bundle size")


class DemoGenomeInstallTests(unittest.TestCase):
    def test_install_lands_where_the_local_data_scanner_looks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            demo_genome.install_demo_genome(tmpdir)

            found = list(iter_local_assembly_dirs(Path(tmpdir) / "local_data"))
            self.assertEqual(len(found), 1)
            provider, species_key, assembly, asm_dir = found[0]
            self.assertEqual(provider, demo_genome.DEMO_PROVIDER)
            self.assertEqual(species_key, demo_genome.DEMO_SPECIES_KEY)
            self.assertEqual(assembly, demo_genome.DEMO_ASSEMBLY)
            self.assertTrue(asm_dir.is_dir())

    def test_installed_files_carry_the_accession_prefix(self):
        # Not cosmetic: main._downloaded_assembly_files uses this prefix to decide what
        # belongs to the assembly and may be deleted.
        with tempfile.TemporaryDirectory() as tmpdir:
            demo_genome.install_demo_genome(tmpdir)
            asm_dir = demo_genome.demo_assembly_dir(tmpdir)
            for path in asm_dir.rglob("*"):
                if not path.is_file() or path.name.endswith(".genome_manifest.json"):
                    continue
                self.assertTrue(
                    path.name.startswith(demo_genome.DEMO_ASSEMBLY),
                    f"{path.name} would not be recognised as part of this assembly",
                )

    def test_the_annotation_is_a_dataset_release_not_a_loose_legacy_file(self):
        # A loose annotation is swept into the "legacy/unknown" bucket and shown as
        # "Legacy local files", which is the wrong thing to tell someone about a genome
        # the tutorial just fetched for them.
        with tempfile.TemporaryDirectory() as tmpdir:
            demo_genome.install_demo_genome(tmpdir)
            asm_dir = demo_genome.demo_assembly_dir(tmpdir)
            self.assertFalse(
                list(asm_dir.glob("*.gff3")),
                "the annotation should live in a release directory, not the assembly root",
            )
            scanned = main._scan_local_assembly(asm_dir, demo_genome.DEMO_ASSEMBLY)
            releases = {r["key"]: r for r in scanned.get("dataset_releases") or []}
            self.assertIn(demo_genome.DEMO_RELEASE_KEY, releases)
            self.assertEqual(releases[demo_genome.DEMO_RELEASE_KEY]["label"], demo_genome.DEMO_RELEASE_LABEL)
            self.assertNotIn(main.LEGACY_DATASET_RELEASE_KEY, releases)

    def test_the_listing_does_not_call_the_demo_genome_retired(self):
        # It is not in any remote catalogue and never will be, so the usual
        # "we could not find this upstream" warning is just noise.
        with tempfile.TemporaryDirectory() as tmpdir:
            asyncio.run(main.post_demo_genome_install(
                main.DemoGenomeInstallRequest(output_dir=tmpdir)
            ))
            listed = main.list_local_assemblies(output_dir=tmpdir)
            demo = next(x for x in listed if x["species_key"] == demo_genome.DEMO_SPECIES_KEY)
            self.assertTrue(demo["is_demo"])
            self.assertFalse(demo["retired_remote"])
            self.assertEqual(demo["dataset_release_label"], demo_genome.DEMO_RELEASE_LABEL)
            # The badge on the genome pill: "Demo", not the release date.
            self.assertEqual(demo["dataset_release_short_label"], demo_genome.DEMO_RELEASE_LABEL)

    def test_status_reports_uninstalled_then_installed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertFalse(demo_genome.demo_install_status(tmpdir)["installed"])
            demo_genome.install_demo_genome(tmpdir)
            status = demo_genome.demo_install_status(tmpdir)
            self.assertTrue(status["installed"])
            self.assertIn("fasta", status["files"])
            self.assertIn("gff3", status["files"])

    def test_installing_twice_is_harmless(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            demo_genome.install_demo_genome(tmpdir)
            demo_genome.install_demo_genome(tmpdir)
            self.assertTrue(demo_genome.demo_install_status(tmpdir)["installed"])

    def test_an_empty_output_dir_is_refused_rather_than_writing_to_the_root(self):
        with self.assertRaises(ValueError):
            demo_genome.install_demo_genome("")

    def test_the_manifest_marks_it_as_ours_to_delete(self):
        # The claim being checked: a synthetic demo:// URL is enough for the deletion
        # path to treat these files as managed, so the genome can be removed through the
        # normal UI instead of being stranded.
        with tempfile.TemporaryDirectory() as tmpdir:
            demo_genome.install_demo_genome(tmpdir)
            asm_dir = demo_genome.demo_assembly_dir(tmpdir)
            manifest = main._load_genome_manifest(asm_dir, demo_genome.DEMO_ASSEMBLY)

            self.assertTrue(manifest, "the manifest should be readable by main's loader")
            self.assertTrue(
                main._is_download_managed_assembly(manifest, asm_dir, demo_genome.DEMO_ASSEMBLY),
                "the demo genome would not be deletable through the genome-removal UI",
            )

            deletable, user_supplied = main._downloaded_assembly_files(
                asm_dir, demo_genome.DEMO_ASSEMBLY, manifest
            )
            self.assertEqual(user_supplied, [], "nothing here was supplied by the user")
            deletable_names = {p.name for p in deletable}
            for _source, (installed_path, _type) in demo_genome.DEMO_FILES.items():
                self.assertIn(Path(installed_path).name, deletable_names,
                              "every installed file must be deletable, including nested ones")


class DemoGenomeEndpointTests(unittest.TestCase):
    def test_listing_shows_the_demo_genome_once_installed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            asyncio.run(main.post_demo_genome_install(
                main.DemoGenomeInstallRequest(output_dir=tmpdir)
            ))
            listed = main.list_local_assemblies(output_dir=tmpdir)
            keys = [(item.get("species_key"), item.get("assembly")) for item in listed]
            self.assertIn((demo_genome.DEMO_SPECIES_KEY, demo_genome.DEMO_ASSEMBLY), keys)

    def test_install_builds_a_usable_annotation_index(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            status = asyncio.run(main.post_demo_genome_install(
                main.DemoGenomeInstallRequest(output_dir=tmpdir)
            ))
            self.assertNotIn("index_error", status, status.get("index_error", ""))
            index_path = Path(status["index"])
            self.assertTrue(index_path.is_file())
            self.assertGreater(index_path.stat().st_size, 0)

    def test_the_indexed_genes_are_the_ones_the_tutorial_points_at(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            status = asyncio.run(main.post_demo_genome_install(
                main.DemoGenomeInstallRequest(output_dir=tmpdir)
            ))
            import sqlite3
            conn = sqlite3.connect(status["index"])
            try:
                rows = conn.execute("SELECT name FROM genes").fetchall()
            finally:
                conn.close()
            names = {r[0] for r in rows}
            for expected in ("Welcome", "To", "Ensembl", "Go"):
                self.assertIn(expected, names)

    def test_install_without_an_output_dir_is_a_bad_request(self):
        with self.assertRaises(main.HTTPException) as caught:
            asyncio.run(main.post_demo_genome_install(
                main.DemoGenomeInstallRequest(output_dir="  ")
            ))
        self.assertEqual(caught.exception.status_code, 400)

    def test_status_endpoint_describes_the_catalogue_entry(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            status = asyncio.run(main.get_demo_genome(output_dir=tmpdir))
            species = status["species"]
            self.assertEqual(species["key"], demo_genome.DEMO_SPECIES_KEY)
            self.assertEqual(len(species["assemblies"]), 1)
            self.assertTrue(species["is_demo"])
            self.assertFalse(status["installed"])
            self.assertTrue(status["available"], "the bundled fixture should be findable")


if __name__ == "__main__":
    unittest.main()


class TutorialWorkspaceTests(unittest.TestCase):
    def test_workspace_sits_inside_the_users_output_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = demo_genome.tutorial_workspace(tmpdir)
            self.assertEqual(workspace.parent, Path(tmpdir).resolve())
            self.assertEqual(workspace.name, demo_genome.TUTORIAL_WORKSPACE_DIR)

    def test_reset_removes_only_the_workspace(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            keep = root / "local_data" / "Homo_sapiens"
            keep.mkdir(parents=True)
            (keep / "important.txt").write_text("do not delete", encoding="utf-8")

            demo_genome.install_demo_genome(str(demo_genome.tutorial_workspace(tmpdir)))
            self.assertTrue(demo_genome.tutorial_workspace(tmpdir).is_dir())

            result = demo_genome.reset_tutorial_workspace(tmpdir)
            self.assertTrue(result["removed"])
            self.assertFalse(demo_genome.tutorial_workspace(tmpdir).exists())
            self.assertTrue((keep / "important.txt").is_file(), "real data must survive")

    def test_reset_is_harmless_when_there_is_nothing_there(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertFalse(demo_genome.reset_tutorial_workspace(tmpdir)["removed"])

    def test_reset_refuses_an_empty_output_dir(self):
        with self.assertRaises(ValueError):
            demo_genome.reset_tutorial_workspace("")

    def test_a_config_pointing_at_the_tutorial_workspace_is_recognised(self):
        self.assertTrue(main._is_tutorial_workspace_path(f"/somewhere/{demo_genome.TUTORIAL_WORKSPACE_DIR}"))
        self.assertFalse(main._is_tutorial_workspace_path("/somewhere/real_output"))
        self.assertFalse(main._is_tutorial_workspace_path(""))
        self.assertFalse(main._is_tutorial_workspace_path(None))

    def test_a_config_pointing_at_the_tutorial_workspace_is_never_saved(self):
        # The guarantee behind the sandbox: whatever the frontend does, and in whatever
        # order its effects run, the tutorial's scratch directory cannot become the saved
        # output directory. Run against a temporary config file, not the real one.
        with tempfile.TemporaryDirectory() as tmpdir:
            config_file = Path(tmpdir) / "config.json"
            real_output_dir = str(Path(tmpdir) / "genomes")
            config_file.write_text(json.dumps({"output_dir": real_output_dir}), encoding="utf-8")

            with patch.object(main, "CONFIG_FILE", config_file):
                tutorial_dir = str(Path(real_output_dir) / demo_genome.TUTORIAL_WORKSPACE_DIR)
                asyncio.run(main.update_config(
                    main.ConfigUpdate(output_dir=tutorial_dir, active_species=[])
                ))
                saved = json.loads(config_file.read_text(encoding="utf-8"))
                self.assertEqual(saved.get("output_dir"), real_output_dir,
                                 "the tutorial workspace must never be saved as the output dir")

    def test_a_normal_config_save_is_untouched_by_the_guard(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_file = Path(tmpdir) / "config.json"
            config_file.write_text(json.dumps({"output_dir": str(Path(tmpdir) / "old")}), encoding="utf-8")
            wanted = str(Path(tmpdir) / "new_genomes")

            with patch.object(main, "CONFIG_FILE", config_file):
                asyncio.run(main.update_config(main.ConfigUpdate(output_dir=wanted)))
                saved = json.loads(config_file.read_text(encoding="utf-8"))
                self.assertEqual(saved.get("output_dir"), wanted)


if __name__ == "__main__":
    unittest.main()


class TutorialSessionTests(unittest.TestCase):
    """The genome the browser is allowed to resolve while a tutorial runs.

    A tutorial deliberately never saves its genome to the configuration, but the browser
    resolves genomes from the configuration — so this registry is the bridge, and what it
    refuses is the whole of its safety.
    """

    def setUp(self):
        demo_genome.clear_tutorial_session_genome()

    def tearDown(self):
        demo_genome.clear_tutorial_session_genome()

    def test_starts_empty(self):
        self.assertEqual(demo_genome.tutorial_session_species(), [])

    def test_registers_and_clears_the_demo_genome(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = demo_genome.tutorial_workspace(tmp)
            demo_genome.set_tutorial_session_genome({
                "species_key": demo_genome.DEMO_SPECIES_KEY,
                "assembly": demo_genome.DEMO_ASSEMBLY,
                "files": {"fasta": str(workspace / "local_data" / "x" / "y.fa")},
            })
            registered = demo_genome.tutorial_session_species()
            self.assertEqual(len(registered), 1)
            self.assertEqual(registered[0]["species_key"], demo_genome.DEMO_SPECIES_KEY)
        demo_genome.clear_tutorial_session_genome()
        self.assertEqual(demo_genome.tutorial_session_species(), [])

    def test_refuses_anything_but_the_demo_genome(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = demo_genome.tutorial_workspace(tmp)
            with self.assertRaises(ValueError):
                demo_genome.set_tutorial_session_genome({
                    "species_key": "homo_sapiens",
                    "files": {"fasta": str(workspace / "a.fa")},
                })
        self.assertEqual(demo_genome.tutorial_session_species(), [])

    def test_refuses_files_outside_the_tutorial_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                demo_genome.set_tutorial_session_genome({
                    "species_key": demo_genome.DEMO_SPECIES_KEY,
                    "files": {"fasta": str(Path(tmp) / "local_data" / "real.fa")},
                })
        self.assertEqual(demo_genome.tutorial_session_species(), [])

    def test_a_registered_genome_becomes_browsable(self):
        """The point of the whole thing: ``_resolve_browse_genome_context`` finds it."""
        with tempfile.TemporaryDirectory() as tmp:
            workspace = demo_genome.tutorial_workspace(tmp)
            workspace.mkdir(parents=True, exist_ok=True)
            status = demo_genome.install_demo_genome(str(workspace))
            record = {
                "species_key": demo_genome.DEMO_SPECIES_KEY,
                "assembly": demo_genome.DEMO_ASSEMBLY,
                "provider": demo_genome.DEMO_PROVIDER,
                "files": status["files"],
            }
            demo_genome.set_tutorial_session_genome(record)
            resolved = main._browsable_active_species({"active_species": []})
            self.assertEqual([s["species_key"] for s in resolved], [demo_genome.DEMO_SPECIES_KEY])

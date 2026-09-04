import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import tutorial_packages  # noqa: E402


def document(identifier="recorded-tutorial"):
    return {
        "format": tutorial_packages.FORMAT,
        "schemaVersion": tutorial_packages.SCHEMA_VERSION,
        "id": identifier,
        "title": "Recorded tutorial",
        "blurb": "Made in the builder",
        "steps": [{
            "id": "open-download",
            "view": "download",
            "title": "Open Download",
            "body": "Open the Download view.",
            "spotlight": {"target": {"id": "app.viewButton", "version": 1, "params": {"buttonId": "download"}}},
        }],
    }


class TutorialPackagesTests(unittest.TestCase):
    def test_drafts_save_list_and_load_atomically(self):
        with tempfile.TemporaryDirectory() as output:
            saved = tutorial_packages.save_draft(output, document())
            self.assertTrue(saved["saved"])
            loaded = tutorial_packages.load_draft(output, "recorded-tutorial")
            self.assertEqual(loaded["title"], "Recorded tutorial")
            listed = tutorial_packages.list_drafts(output)
            self.assertEqual([entry["tutorial"]["id"] for entry in listed], ["recorded-tutorial"])
            tutorial_packages.save_checkpoint(output, "recorded-tutorial", "Before recording", loaded)
            checkpoints = tutorial_packages.list_checkpoints(output, "recorded-tutorial")
            self.assertEqual(checkpoints[0]["name"], "Before recording")
            self.assertEqual(checkpoints[0]["tutorial"]["id"], "recorded-tutorial")

    def test_package_round_trip_includes_hashed_assets(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as destination:
            tutorial = document()
            tutorial["datasets"] = [{
                "id": "embedded:tiny@1",
                "recipeId": "tiny",
                "embedded": True,
            }]
            tutorial_packages.save_draft(source, tutorial)
            draft = tutorial_packages.drafts_root(source) / "recorded-tutorial"
            asset = draft / "datasets" / "tiny" / "slice.gff3"
            asset.parent.mkdir(parents=True)
            asset.write_text("##gff-version 3\n", encoding="utf-8")
            package = Path(source) / "recorded.egtutorial"
            tutorial_packages.export_package(source, "recorded-tutorial", package)
            scan = tutorial_packages.scan_package(package)
            self.assertTrue(scan["compatible"])
            tutorial_packages.import_package(package, destination)
            self.assertEqual(
                (tutorial_packages.drafts_root(destination) / "recorded-tutorial" / "datasets" / "tiny" / "slice.gff3").read_text(),
                "##gff-version 3\n",
            )

    def test_package_excludes_assets_for_detached_datasets(self):
        with tempfile.TemporaryDirectory() as output:
            tutorial_packages.save_draft(output, document())
            stale = tutorial_packages.drafts_root(output) / "recorded-tutorial" / "datasets" / "detached" / "slice.gff3"
            stale.parent.mkdir(parents=True)
            stale.write_text("##gff-version 3\n", encoding="utf-8")
            package = Path(output) / "recorded.egtutorial"
            tutorial_packages.export_package(output, "recorded-tutorial", package)
            with zipfile.ZipFile(package) as archive:
                self.assertNotIn("datasets/detached/slice.gff3", archive.namelist())

    def test_package_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "unsafe.egtutorial"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("manifest.json", json.dumps({
                    "format": tutorial_packages.FORMAT,
                    "schemaVersion": 1,
                    "files": [],
                }))
                archive.writestr("tutorial.json", json.dumps(document()))
                archive.writestr("../outside.json", "{}")
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                tutorial_packages.scan_package(path)

    def test_package_rejects_declared_executable_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "executable.egtutorial"
            tutorial_bytes = json.dumps(document()).encode()
            script = b"alert('no')"
            import hashlib
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("manifest.json", json.dumps({
                    "format": tutorial_packages.FORMAT,
                    "schemaVersion": 1,
                    "tutorialId": "recorded-tutorial",
                    "files": [
                        {"path": "tutorial.json", "size": len(tutorial_bytes), "sha256": hashlib.sha256(tutorial_bytes).hexdigest()},
                        {"path": "datasets/run.js", "size": len(script), "sha256": hashlib.sha256(script).hexdigest()},
                    ],
                }))
                archive.writestr("tutorial.json", tutorial_bytes)
                archive.writestr("datasets/run.js", script)
            scan = tutorial_packages.scan_package(path)
            self.assertTrue(any("Unsupported" in problem for problem in scan["problems"]))

    def test_portable_document_rejects_selectors_and_local_paths(self):
        invalid = document()
        invalid["steps"][0]["selector"] = "#button"
        invalid["steps"][0]["copy"] = "/Users/someone/private.fa"
        problems = tutorial_packages.validate_document(invalid)
        self.assertTrue(any("selector" in problem for problem in problems))
        self.assertTrue(any("absolute" in problem for problem in problems))

        invalid_capability = document()
        invalid_capability["steps"][0]["interactionPolicy"] = {
            "targets": [{"target": {"id": "download.search", "version": 1}, "capabilities": ["run-shell"]}],
        }
        self.assertTrue(any("unsupported capability" in problem for problem in tutorial_packages.validate_document(invalid_capability)))

    def test_drafts_cannot_shadow_built_in_tutorial_ids(self):
        with tempfile.TemporaryDirectory() as output:
            with self.assertRaisesRegex(ValueError, "reserved"):
                tutorial_packages.save_draft(output, document("getting-started"))

    def test_drafts_do_not_follow_symlinked_tutorial_directories(self):
        with tempfile.TemporaryDirectory() as output, tempfile.TemporaryDirectory() as outside:
            root = tutorial_packages.drafts_root(output)
            root.mkdir(parents=True)
            (root / "recorded-tutorial").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                tutorial_packages.save_draft(output, document())

    def test_promotion_writes_declarative_repository_json_and_registry(self):
        with tempfile.TemporaryDirectory() as output, tempfile.TemporaryDirectory() as repository:
            tutorial_dir = Path(repository) / "frontend" / "src" / "tutorials"
            tutorial_dir.mkdir(parents=True)
            tutorial_packages.save_draft(output, document())
            promoted = tutorial_packages.promote_draft(output, "recorded-tutorial", repository)
            destination = Path(promoted["tutorial"])
            self.assertEqual(destination.name, "recorded-tutorial.tutorial.json")
            self.assertEqual(json.loads(destination.read_text())["format"], tutorial_packages.FORMAT)
            registry = Path(promoted["registry"]).read_text()
            self.assertIn("./generated/recorded-tutorial.tutorial.json", registry)
            self.assertNotIn("export default {", destination.read_text())


if __name__ == "__main__":
    unittest.main()

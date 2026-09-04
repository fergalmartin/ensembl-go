"""Notes transfer over the endpoints: what reaches disk, and what cannot come back.

Handlers are awaited directly rather than driven over HTTP, matching the rest of
backend/tests. The two tests that matter most are the resurrection test and the
stale-timestamp test — both exist because _load_user_notes unions every store it
can read while _save_user_notes writes only one.
"""

import asyncio
import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
import notes_transfer as nt  # noqa: E402

from fastapi import HTTPException  # noqa: E402


GENOME_KEY = "ensembl::homo_sapiens::GRCh38"


def _target(gene_id="ENSG00000141510", label="TP53", genome_key=GENOME_KEY, kind="gene"):
    return main.NoteTargetModel(kind=kind, genome_key=genome_key, id=gene_id, label=label)


def _create(**kwargs):
    return asyncio.run(main.create_user_note(main.UserNoteCreateRequest(**kwargs)))


def _export(**kwargs):
    return asyncio.run(main.export_user_notes(main.NotesExportRequest(**kwargs)))


def _scan(path):
    return asyncio.run(main.scan_user_notes_import(main.NotesImportScanRequest(path=str(path))))


def _apply(path, **kwargs):
    return asyncio.run(
        main.apply_user_notes_import(main.NotesImportApplyRequest(path=str(path), **kwargs))
    )


def _stored():
    return main._load_user_notes(main.load_config())["notes"]


@contextmanager
def _store(output_dir=None):
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        cache_notes = root / "user_notes.json"
        with patch.object(main, "CONFIG_FILE", root / "config.json"), \
                patch.object(main, "DEFAULT_USER_NOTES_FILE", cache_notes), \
                patch.object(main, "USER_NOTES_FILE", cache_notes):
            config = {**main.DEFAULT_CONFIG}
            if output_dir is not None:
                config["output_dir"] = str(root / output_dir)
            main.save_config(config)
            yield root, cache_notes


def _write_store(path, notes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"version": main.USER_NOTES_STORE_VERSION, "notes": notes}, indent=2),
        encoding="utf-8",
    )


def _raw_note(note_id, body, updated_at, title="", kind="gene", target_id="ENSG00000141510"):
    return {
        "id": note_id,
        "target": {
            "kind": kind, "genome_key": GENOME_KEY, "id": target_id,
            "label": "TP53", "genome_selection_key": "",
        },
        "title": title, "body": body, "tags": [], "tags_updated_at": "",
        "created_at": "2026-01-01T00:00:00Z", "updated_at": updated_at,
        "archived": False, "archived_at": "", "status": "backlog",
        "priority": "medium", "completed": False, "completed_at": "", "todo_order": 0,
    }


class ExportTests(unittest.TestCase):
    def test_export_writes_the_selected_notes(self):
        with _store() as (root, _cache):
            a = _create(target=_target(), body="Exon 4 differs.")
            b = _create(target=_target(gene_id="ENSG00000134193", label="REG4"), body="Second.")
            out = root / "out"

            result = _export(directory=str(out), filename="notes", format="json",
                             note_ids=[a["id"], b["id"]])

            self.assertTrue(result["ok"])
            self.assertEqual(result["count"], 2)
            self.assertEqual(result["filename"], "notes.json")
            written = json.loads((out / "notes.json").read_text(encoding="utf-8"))
            self.assertEqual({n["id"] for n in written["notes"]}, {a["id"], b["id"]})

    def test_export_only_writes_what_was_asked_for(self):
        with _store() as (root, _cache):
            a = _create(target=_target(), body="Wanted.")
            _create(target=_target(gene_id="ENSG2"), body="Not wanted.")

            _export(directory=str(root / "out"), filename="one", format="csv", note_ids=[a["id"]])

            text = (root / "out" / "one.csv").read_text(encoding="utf-8")
            self.assertIn("Wanted.", text)
            self.assertNotIn("Not wanted.", text)

    def test_extension_is_appended_per_format(self):
        with _store() as (root, _cache):
            note = _create(target=_target(), body="x")
            for fmt, ext in (("json", ".json"), ("csv", ".csv"), ("tsv", ".tsv")):
                result = _export(directory=str(root / "out"), filename=f"n_{fmt}",
                                 format=fmt, note_ids=[note["id"]])
                self.assertTrue(result["filename"].endswith(ext))

    def test_create_mode_refuses_to_clobber(self):
        with _store() as (root, _cache):
            note = _create(target=_target(), body="x")
            _export(directory=str(root / "out"), filename="notes", format="json", note_ids=[note["id"]])

            with self.assertRaises(HTTPException) as ctx:
                _export(directory=str(root / "out"), filename="notes", format="json",
                        note_ids=[note["id"]])
            self.assertEqual(ctx.exception.status_code, 409)

    def test_overwrite_mode_replaces(self):
        with _store() as (root, _cache):
            note = _create(target=_target(), body="x")
            args = dict(directory=str(root / "out"), filename="notes", format="json",
                        note_ids=[note["id"]])
            _export(**args)
            result = _export(**args, mode="overwrite")
            self.assertTrue(result["ok"])

    def test_unknown_format_is_rejected(self):
        with _store() as (root, _cache):
            note = _create(target=_target(), body="x")
            with self.assertRaises(HTTPException) as ctx:
                _export(directory=str(root / "out"), filename="notes", format="exe",
                        note_ids=[note["id"]])
            self.assertEqual(ctx.exception.status_code, 400)

    def test_empty_selection_is_rejected(self):
        with _store() as (root, _cache):
            with self.assertRaises(HTTPException) as ctx:
                _export(directory=str(root / "out"), filename="notes", format="json", note_ids=[])
            self.assertEqual(ctx.exception.status_code, 400)

    def test_unknown_ids_are_reported_not_fatal(self):
        with _store() as (root, _cache):
            note = _create(target=_target(), body="x")
            result = _export(directory=str(root / "out"), filename="notes", format="json",
                             note_ids=[note["id"], "note_doesnotexist"])
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["missing_ids"], ["note_doesnotexist"])

    def test_todos_and_notes_share_one_file(self):
        with _store() as (root, _cache):
            note = _create(target=_target(), body="A gene note.")
            task = _create(target=_target(kind="todo", genome_key="global::todos",
                                          gene_id="tasks", label="Todo"),
                           title="Check REG4", status="in_progress", priority="high")

            _export(directory=str(root / "out"), filename="both", format="csv",
                    note_ids=[note["id"], task["id"]])

            lines = (root / "out" / "both.csv").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 3)
            header = lines[0].split(",")
            self.assertIn("todo_status", header)
            # The task sorts first, and the gene note leaves the todo columns blank.
            self.assertIn("in_progress", lines[1])
            self.assertNotIn("in_progress", lines[2])


class ScanTests(unittest.TestCase):
    def _exported(self, root, fmt="json"):
        a = _create(target=_target(), body="Exon 4 differs.")
        b = _create(target=_target(gene_id="ENSG00000134193", label="REG4"), body="Second.")
        _export(directory=str(root / "out"), filename="notes", format=fmt,
                note_ids=[a["id"], b["id"]])
        return root / "out" / f"notes.{fmt}", [a, b]

    def test_scan_reports_identical_for_a_round_trip(self):
        with _store() as (root, _cache):
            path, _ = self._exported(root)
            scan = _scan(path)
            self.assertEqual(scan["summary"]["identical"], 2)
            self.assertEqual(scan["summary"]["new"], 0)
            self.assertEqual(scan["summary"]["differs"], 0)
            self.assertEqual(scan["document_errors"], [])

    def test_scan_of_a_csv_round_trip_is_also_identical(self):
        with _store() as (root, _cache):
            path, _ = self._exported(root, fmt="csv")
            scan = _scan(path)
            self.assertEqual(scan["summary"]["identical"], 2)

    def test_scan_changes_nothing(self):
        with _store() as (root, _cache):
            path, _ = self._exported(root)
            before = _stored()
            _scan(path)
            self.assertEqual(_stored(), before)

    def test_scan_reports_new_notes_against_an_empty_store(self):
        with _store() as (root, _cache):
            path, notes = self._exported(root)
            for note in notes:
                asyncio.run(main.delete_user_note(note["id"]))
            scan = _scan(path)
            self.assertEqual(scan["summary"]["new"], 2)

    def test_scan_flags_invalid_rows_without_failing(self):
        with _store() as (root, _cache):
            path, _ = self._exported(root, fmt="csv")
            # read_text translates newlines, so split on what it actually returns.
            lines = path.read_text(encoding="utf-8").splitlines()
            columns = lines[0].split(",")
            broken = lines[1].split(",")
            broken[columns.index("target_id")] = ""
            path.write_text("\r\n".join([lines[0], ",".join(broken), *lines[2:]]) + "\r\n",
                            encoding="utf-8")

            scan = _scan(path)
            self.assertEqual(scan["summary"]["invalid"], 1)
            self.assertEqual(scan["applicable"], 1)
            self.assertTrue(any(row["status"] == "invalid" for row in scan["rows"]))

    def test_missing_header_column_is_a_document_error(self):
        with _store() as (root, _cache):
            path, _ = self._exported(root, fmt="csv")
            lines = path.read_text(encoding="utf-8").splitlines()
            columns = lines[0].split(",")
            drop = columns.index("id")
            rebuilt = [",".join(c for i, c in enumerate(line.split(",")) if i != drop)
                       for line in lines if line]
            path.write_text("\r\n".join(rebuilt) + "\r\n", encoding="utf-8")

            scan = _scan(path)
            self.assertTrue(scan["document_errors"])
            self.assertEqual(scan["applicable"], 0)

    def test_missing_file_is_a_404(self):
        with _store() as (root, _cache):
            with self.assertRaises(HTTPException) as ctx:
                _scan(root / "nope.json")
            self.assertEqual(ctx.exception.status_code, 404)

    def test_near_duplicates_are_reported(self):
        with _store() as (root, _cache):
            original = _create(target=_target(), title="Coverage dip", body="Same target.")
            _export(directory=str(root / "out"), filename="dup", format="json",
                    note_ids=[original["id"]])
            path = root / "out" / "dup.json"
            document = json.loads(path.read_text(encoding="utf-8"))
            document["notes"][0]["id"] = "note_differentid1"
            path.write_text(json.dumps(document), encoding="utf-8")

            scan = _scan(path)
            self.assertEqual(len(scan["near_duplicates"]), 1)
            self.assertEqual(scan["near_duplicates"][0]["existing_id"], original["id"])


class ApplyTests(unittest.TestCase):
    def _export_all(self, root, fmt="json", name="notes"):
        ids = [note["id"] for note in _stored()]
        _export(directory=str(root / "out"), filename=name, format=fmt, note_ids=ids)
        return root / "out" / f"{name}.{fmt}"

    def test_reimporting_an_export_changes_nothing(self):
        with _store() as (root, _cache):
            _create(target=_target(), body="Exon 4 differs.")
            _create(target=_target(gene_id="ENSG2", label="REG4"), body="Second.")
            path = self._export_all(root)

            result = _apply(path, strategy="newer_wins", digest=_scan(path)["digest"])

            self.assertEqual(result["added"], 0)
            self.assertEqual(result["updated"], 0)
            self.assertEqual(result["unchanged"], 2)
            self.assertEqual(len(_stored()), 2)

    def test_newer_wins_restores_deleted_notes(self):
        with _store() as (root, _cache):
            note = _create(target=_target(), body="Worth keeping.")
            path = self._export_all(root)
            asyncio.run(main.delete_user_note(note["id"]))
            self.assertEqual(_stored(), [])

            result = _apply(path, strategy="newer_wins")

            self.assertEqual(result["added"], 1)
            self.assertEqual(_stored()[0]["body"], "Worth keeping.")

    def test_apply_refuses_when_the_file_changed_after_the_scan(self):
        with _store() as (root, _cache):
            _create(target=_target(), body="x")
            path = self._export_all(root)
            digest = _scan(path)["digest"]
            path.write_text(path.read_text(encoding="utf-8").replace("x", "y"), encoding="utf-8")

            with self.assertRaises(HTTPException) as ctx:
                _apply(path, strategy="newer_wins", digest=digest)
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertEqual(ctx.exception.detail["code"], "file_changed")

    def test_store_changed_is_reported_when_notes_moved_during_review(self):
        with _store() as (root, _cache):
            _create(target=_target(), body="x")
            path = self._export_all(root)
            scan = _scan(path)
            _create(target=_target(gene_id="ENSG_LATE"), body="Written while reviewing.")

            result = _apply(path, strategy="newer_wins", digest=scan["digest"],
                            store_digest=scan["store_digest"])
            self.assertTrue(result["store_changed"])

    def test_add_as_new_never_overwrites(self):
        with _store() as (root, _cache):
            _create(target=_target(), body="Mine.")
            path = self._export_all(root)

            result = _apply(path, strategy="add_as_new")

            self.assertEqual(result["added"], 1)
            bodies = sorted(note["body"] for note in _stored())
            self.assertEqual(bodies, ["Mine.", "Mine."])
            self.assertEqual(len({note["id"] for note in _stored()}), 2)

    def test_unknown_strategy_is_rejected(self):
        with _store() as (root, _cache):
            _create(target=_target(), body="x")
            path = self._export_all(root)
            with self.assertRaises(HTTPException) as ctx:
                _apply(path, strategy="vibes")
            self.assertEqual(ctx.exception.status_code, 400)

    def test_a_file_with_no_usable_notes_is_rejected(self):
        with _store() as (root, _cache):
            empty = root / "empty.json"
            empty.write_text(json.dumps({"notes": []}), encoding="utf-8")
            with self.assertRaises(HTTPException) as ctx:
                _apply(empty, strategy="newer_wins")
            self.assertEqual(ctx.exception.status_code, 400)

    def test_a_todo_without_a_title_is_dropped_not_stored(self):
        with _store() as (root, _cache):
            path = root / "todo.json"
            path.write_text(json.dumps({"notes": [
                {"id": "note_titledtodo1", "target": {"kind": "todo", "genome_key": "global::todos",
                                                      "id": "tasks", "label": "Todo"},
                 "title": "Real task", "body": ""},
                {"id": "note_untitledtod", "target": {"kind": "todo", "genome_key": "global::todos",
                                                      "id": "tasks", "label": "Todo"},
                 "title": "", "body": "no title"},
            ]}), encoding="utf-8")

            result = _apply(path, strategy="newer_wins")

            self.assertEqual(result["added"], 1)
            self.assertEqual([n["title"] for n in _stored()], ["Real task"])


class DestructiveImportTests(unittest.TestCase):
    """replace_all across two stores — the case _save_user_notes alone gets wrong."""

    def test_replace_all_does_not_let_notes_resurrect_from_a_second_store(self):
        with _store(output_dir="output") as (root, cache_notes):
            sidecar = root / "output" / "local_data" / main.OUTPUT_DIR_USER_NOTES_FILENAME
            _write_store(sidecar, [_raw_note("note_sidecar0001", "In the sidecar.", "2026-01-01T00:00:00Z")])
            _write_store(cache_notes, [_raw_note("note_cachedir001", "In the cache dir.", "2026-01-01T00:00:00Z")])
            self.assertEqual(len(_stored()), 2)

            path = root / "replacement.json"
            path.write_text(json.dumps({"notes": [
                _raw_note("note_imported001", "The only note now.", "2026-05-01T00:00:00Z"),
            ]}), encoding="utf-8")

            result = _apply(path, strategy="replace_all")

            self.assertEqual(result["deleted"], 2)
            # The union on the next load must not bring the old stores back.
            self.assertEqual([n["id"] for n in _stored()], ["note_imported001"])

    def test_replace_matching_survives_an_older_copy_in_a_second_store(self):
        with _store(output_dir="output") as (root, cache_notes):
            sidecar = root / "output" / "local_data" / main.OUTPUT_DIR_USER_NOTES_FILENAME
            _write_store(sidecar, [_raw_note("note_shared00001", "Sidecar copy.", "2026-01-01T00:00:00Z")])
            _write_store(cache_notes, [_raw_note("note_shared00001", "Cache copy, newer.", "2026-04-01T00:00:00Z")])

            path = root / "incoming.json"
            path.write_text(json.dumps({"notes": [
                # Deliberately older than both stored copies.
                _raw_note("note_shared00001", "From the file.", "2025-01-01T00:00:00Z"),
            ]}), encoding="utf-8")

            _apply(path, strategy="replace_matching")

            stored = _stored()
            self.assertEqual(len(stored), 1)
            self.assertEqual(stored[0]["body"], "From the file.")

    def test_replace_all_backs_up_every_store_first(self):
        with _store(output_dir="output") as (root, cache_notes):
            sidecar = root / "output" / "local_data" / main.OUTPUT_DIR_USER_NOTES_FILENAME
            _write_store(sidecar, [_raw_note("note_sidecar0001", "Irreplaceable prose.", "2026-01-01T00:00:00Z")])
            _write_store(cache_notes, [_raw_note("note_cachedir001", "Also irreplaceable.", "2026-01-01T00:00:00Z")])

            path = root / "replacement.json"
            path.write_text(json.dumps({"notes": [
                _raw_note("note_imported001", "New.", "2026-05-01T00:00:00Z"),
            ]}), encoding="utf-8")

            result = _apply(path, strategy="replace_all")

            self.assertEqual(len(result["backup_paths"]), 2)
            bodies = set()
            for backup in result["backup_paths"]:
                self.assertTrue(Path(backup).exists())
                for note in json.loads(Path(backup).read_text(encoding="utf-8"))["notes"]:
                    bodies.add(note["body"])
            self.assertEqual(bodies, {"Irreplaceable prose.", "Also irreplaceable."})

    def test_non_destructive_import_takes_no_backup(self):
        with _store() as (root, _cache):
            _create(target=_target(), body="x")
            path = root / "in.json"
            path.write_text(json.dumps({"notes": [
                _raw_note("note_new00000001", "Added.", "2026-05-01T00:00:00Z"),
            ]}), encoding="utf-8")

            result = _apply(path, strategy="newer_wins")
            self.assertEqual(result["backup_paths"], [])


if __name__ == "__main__":
    unittest.main()

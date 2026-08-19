"""User-notes store: where notes land, and what it takes to lose one.

Handlers are awaited directly rather than driven over HTTP, matching the rest
of backend/tests — it keeps the test dependencies unchanged.
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

from fastapi import HTTPException  # noqa: E402


GENOME_KEY = "ensembl::homo_sapiens::GRCh38"


def _target(gene_id="ENSG00000141510", label="TP53", genome_key=GENOME_KEY, kind="gene", selection_key=""):
    return main.NoteTargetModel(
        kind=kind,
        genome_key=genome_key,
        id=gene_id,
        label=label,
        genome_selection_key=selection_key,
    )


def _create(**kwargs):
    return asyncio.run(main.create_user_note(main.UserNoteCreateRequest(**kwargs)))


def _list(**kwargs):
    return asyncio.run(main.list_user_notes(**kwargs))


def _index(**kwargs):
    return asyncio.run(main.user_notes_index(**kwargs))


def _update(note_id, **kwargs):
    return asyncio.run(main.update_user_note(note_id, main.UserNoteUpdateRequest(**kwargs)))


def _delete(note_id):
    return asyncio.run(main.delete_user_note(note_id))


def _archive(note_id, archived=True):
    return asyncio.run(main.set_user_note_archived(
        note_id,
        main.UserNoteArchiveRequest(archived=archived),
    ))


def _bulk_delete(*note_ids):
    return asyncio.run(main.bulk_delete_user_notes(
        main.UserNoteBulkDeleteRequest(note_ids=list(note_ids)),
    ))


@contextmanager
def _store(output_dir=None):
    """Redirect the config and the cache-level notes file at a temp dir."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        cache_file = root / "config.json"
        cache_notes = root / "user_notes.json"
        with patch.object(main, "CONFIG_FILE", cache_file), \
                patch.object(main, "DEFAULT_USER_NOTES_FILE", cache_notes), \
                patch.object(main, "USER_NOTES_FILE", cache_notes):
            config = {**main.DEFAULT_CONFIG}
            if output_dir is not None:
                config["output_dir"] = str(root / output_dir)
            main.save_config(config)
            yield root, cache_notes


class UserNotesStorageTests(unittest.TestCase):
    def test_notes_persist_to_output_dir_sidecar(self):
        with _store(output_dir="output") as (root, cache_notes):
            created = _create(target=_target(), body="Exon 4 differs.")

            sidecar = root / "output" / "local_data" / main.OUTPUT_DIR_USER_NOTES_FILENAME
            self.assertTrue(sidecar.exists())
            saved = json.loads(sidecar.read_text(encoding="utf-8"))
            self.assertEqual(saved["version"], main.USER_NOTES_STORE_VERSION)
            self.assertEqual(saved["notes"][0]["id"], created["id"])
            self.assertEqual(saved["notes"][0]["body"], "Exon 4 differs.")
            self.assertFalse(cache_notes.exists())

    def test_notes_fall_back_to_cache_dir_without_output_dir(self):
        with _store() as (_root, cache_notes):
            created = _create(target=_target(), body="No output dir set.")

            self.assertTrue(cache_notes.exists())
            saved = json.loads(cache_notes.read_text(encoding="utf-8"))
            self.assertEqual(saved["notes"][0]["id"], created["id"])

    def test_notes_in_both_stores_are_merged_not_dropped(self):
        # The deliberate divergence from the track registry: repointing
        # output_dir must not hide notes written under the old one.
        with _store(output_dir="output") as (root, cache_notes):
            cache_notes.write_text(json.dumps({
                "version": 1,
                "notes": [{
                    "id": "note_fromcache01",
                    "target": {"kind": "gene", "genome_key": GENOME_KEY, "id": "ENSG00000141510"},
                    "title": "Written earlier",
                    "body": "under a different output dir",
                    "created_at": "2026-08-01T09:00:00Z",
                    "updated_at": "2026-08-01T09:00:00Z",
                }],
            }), encoding="utf-8")

            created = _create(target=_target(), body="Written now.")
            listed = _list()["notes"]
            ids = {note["id"] for note in listed}
            self.assertEqual(ids, {"note_fromcache01", created["id"]})
            legacy = next(note for note in listed if note["id"] == "note_fromcache01")
            self.assertEqual(legacy["tags"], [])
            self.assertEqual(legacy["tags_updated_at"], "")

    def test_later_updated_at_wins_when_both_stores_hold_the_same_note(self):
        with _store(output_dir="output") as (root, cache_notes):
            _create(target=_target(), body="new")
            sidecar = root / "output" / "local_data" / main.OUTPUT_DIR_USER_NOTES_FILENAME
            store = json.loads(sidecar.read_text(encoding="utf-8"))
            note_id = store["notes"][0]["id"]

            stale = json.loads(json.dumps(store))
            stale["notes"][0]["body"] = "old"
            stale["notes"][0]["updated_at"] = "2020-01-01T00:00:00Z"
            cache_notes.write_text(json.dumps(stale), encoding="utf-8")

            notes = _list()["notes"]
            self.assertEqual(len(notes), 1)
            self.assertEqual(notes[0]["body"], "new")
            self.assertEqual(notes[0]["id"], note_id)

    def test_unparseable_store_is_quarantined_not_overwritten(self):
        with _store() as (_root, cache_notes):
            cache_notes.write_text("{ this is not json", encoding="utf-8")

            _create(target=_target(), body="After the corruption.")

            quarantined = list(cache_notes.parent.glob("user_notes.json.corrupt-*"))
            self.assertEqual(len(quarantined), 1)
            self.assertEqual(quarantined[0].read_text(encoding="utf-8"), "{ this is not json")
            self.assertEqual(json.loads(cache_notes.read_text(encoding="utf-8"))["notes"][0]["body"],
                             "After the corruption.")


class UserNotesApiTests(unittest.TestCase):
    def test_create_requires_a_findable_target(self):
        with _store():
            with self.assertRaises(HTTPException) as ctx:
                _create(target=_target(gene_id=""))
            self.assertEqual(ctx.exception.status_code, 400)

            with self.assertRaises(HTTPException) as ctx:
                _create(target=_target(genome_key=""))
            self.assertEqual(ctx.exception.status_code, 400)

    def test_list_filters_by_kind_genome_and_target(self):
        with _store():
            _create(target=_target(gene_id="ENSG1", label="A"), body="a")
            _create(target=_target(gene_id="ENSG2", label="B"), body="b")
            _create(target=_target(gene_id="ENSG1", genome_key="ncbi::homo_sapiens::GRCh38"), body="c")
            _create(target=_target(gene_id="chr1:100-200", kind="region"), body="d")

            self.assertEqual(len(_list()["notes"]), 4)
            self.assertEqual(len(_list(kind="gene")["notes"]), 3)
            self.assertEqual(len(_list(genome_key=GENOME_KEY)["notes"]), 3)
            self.assertEqual(len(_list(kind="gene", genome_key=GENOME_KEY, target_id="ENSG1")["notes"]), 1)

    def test_dataset_release_is_stripped_from_the_lookup_key(self):
        # A note written while release 116 was loaded must still be found once
        # the user updates to 117. This is the whole durability guarantee.
        with _store():
            _create(
                target=_target(genome_key=f"{GENOME_KEY}::dataset::release_116",
                               selection_key=f"{GENOME_KEY}::dataset::release_116"),
                body="Written against 116.",
            )

            found = _list(genome_key=GENOME_KEY)["notes"]
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0]["target"]["genome_key"], GENOME_KEY)
            # Provenance is kept, just never used to find the note.
            self.assertEqual(found[0]["target"]["genome_selection_key"],
                             f"{GENOME_KEY}::dataset::release_116")

            also_found = _list(genome_key=f"{GENOME_KEY}::dataset::release_117")["notes"]
            self.assertEqual(len(also_found), 1)

    def test_update_preserves_created_at_and_bumps_updated_at(self):
        with _store():
            created = _create(target=_target(), body="first")
            updated = _update(created["id"], title="Splice check", body="second")

            self.assertEqual(updated["created_at"], created["created_at"])
            self.assertGreaterEqual(updated["updated_at"], created["updated_at"])
            self.assertEqual(updated["title"], "Splice check")
            self.assertEqual(updated["body"], "second")

    def test_tags_normalize_persist_and_only_move_their_timestamp_when_changed(self):
        with _store():
            created = _create(
                target=_target(),
                body="tagged",
                tags=[" Needs   review ", "RNA-seq", "needs review"],
            )
            self.assertEqual(created["tags"], ["Needs review", "RNA-seq"])
            self.assertTrue(created["tags_updated_at"])

            body_only = _update(created["id"], body="edited")
            self.assertEqual(body_only["tags_updated_at"], created["tags_updated_at"])

            retagged = _update(created["id"], tags=["RNA-seq", "Follow up"])
            self.assertEqual(retagged["tags"], ["RNA-seq", "Follow up"])
            self.assertGreaterEqual(retagged["tags_updated_at"], created["tags_updated_at"])

            archived = _archive(created["id"])
            self.assertEqual(archived["tags"], retagged["tags"])
            self.assertEqual(archived["tags_updated_at"], retagged["tags_updated_at"])

    def test_tag_validation_rejects_invalid_or_excessive_values(self):
        with _store():
            with self.assertRaises(HTTPException) as ctx:
                _create(target=_target(), body="x", tags=["bad,tag"])
            self.assertEqual(ctx.exception.status_code, 400)

            with self.assertRaises(HTTPException) as ctx:
                _create(target=_target(), body="x", tags=[""])
            self.assertEqual(ctx.exception.status_code, 400)

            with self.assertRaises(HTTPException) as ctx:
                _create(target=_target(), body="x", tags=[f"tag {index}" for index in range(main.MAX_NOTE_TAGS + 1)])
            self.assertEqual(ctx.exception.status_code, 400)

            with self.assertRaises(HTTPException) as ctx:
                _create(target=_target(), body="x", tags=["x" * (main.MAX_NOTE_TAG_CHARS + 1)])
            self.assertEqual(ctx.exception.status_code, 400)

    def test_update_with_stale_updated_at_returns_409_and_the_current_note(self):
        with _store():
            created = _create(target=_target(), body="first")
            _update(created["id"], body="second")

            with self.assertRaises(HTTPException) as ctx:
                _update(created["id"], body="third", updated_at=created["updated_at"])
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertEqual(ctx.exception.detail["note"]["body"], "second")

    def test_update_without_updated_at_force_writes(self):
        with _store():
            created = _create(target=_target(), body="first")
            _update(created["id"], body="second")

            forced = _update(created["id"], body="mine wins")
            self.assertEqual(forced["body"], "mine wins")

    def test_update_with_matching_updated_at_succeeds(self):
        with _store():
            created = _create(target=_target(), body="first")
            updated = _update(created["id"], body="second", updated_at=created["updated_at"])
            self.assertEqual(updated["body"], "second")

    def test_update_unknown_note_returns_404(self):
        with _store():
            with self.assertRaises(HTTPException) as ctx:
                _update("note_missing", body="x")
            self.assertEqual(ctx.exception.status_code, 404)

    def test_delete_removes_the_note_and_404s_when_unknown(self):
        with _store():
            created = _create(target=_target(), body="doomed")
            self.assertEqual(_delete(created["id"]), {"deleted": created["id"]})
            self.assertEqual(_list()["notes"], [])

            with self.assertRaises(HTTPException) as ctx:
                _delete(created["id"])
            self.assertEqual(ctx.exception.status_code, 404)

    def test_archive_round_trips_and_can_be_restored(self):
        with _store():
            created = _create(target=_target(), body="keep this")

            archived = _archive(created["id"])
            self.assertTrue(archived["archived"])
            self.assertTrue(archived["archived_at"])
            self.assertEqual(archived["body"], "keep this")
            self.assertTrue(_list()["notes"][0]["archived"])

            restored = _archive(created["id"], False)
            self.assertFalse(restored["archived"])
            self.assertEqual(restored["archived_at"], "")

    def test_archived_notes_are_excluded_from_the_canvas_index(self):
        with _store():
            active = _create(target=_target(gene_id="ENSG1", label="A"), body="active")
            archived = _create(target=_target(gene_id="ENSG1", label="A"), body="archived")
            _archive(archived["id"])

            entries = _index(kind="gene", genome_key=GENOME_KEY)["entries"]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["count"], 1)
            self.assertEqual(entries[0]["target_id"], "ENSG1")
            self.assertNotEqual(active["id"], archived["id"])

    def test_bulk_delete_removes_only_the_requested_notes(self):
        with _store():
            first = _create(target=_target(gene_id="ENSG1"), body="one")
            second = _create(target=_target(gene_id="ENSG1"), body="two")
            kept = _create(target=_target(gene_id="ENSG2"), body="three")

            result = _bulk_delete(first["id"], second["id"], "note_missing", first["id"])
            self.assertEqual(result["count"], 2)
            self.assertEqual(set(result["deleted"]), {first["id"], second["id"]})
            self.assertEqual([note["id"] for note in _list()["notes"]], [kept["id"]])

    def test_index_groups_by_target_with_counts_and_latest_timestamp(self):
        with _store():
            _create(target=_target(gene_id="ENSG1", label="A"), body="one")
            second = _create(target=_target(gene_id="ENSG1", label="A"), body="two")
            _create(target=_target(gene_id="ENSG2", label="B"), body="three")
            _create(target=_target(gene_id="chr1:1-2", kind="region"), body="not a gene")

            entries = _index(kind="gene", genome_key=GENOME_KEY)["entries"]
            by_target = {entry["target_id"]: entry for entry in entries}

            self.assertEqual(set(by_target), {"ENSG1", "ENSG2"})
            self.assertEqual(by_target["ENSG1"]["count"], 2)
            self.assertEqual(by_target["ENSG1"]["label"], "A")
            self.assertGreaterEqual(by_target["ENSG1"]["updated_at"], second["created_at"])
            self.assertEqual(by_target["ENSG2"]["count"], 1)

    def test_non_gene_kind_round_trips(self):
        with _store():
            created = _create(target=_target(gene_id="chr17:7668402-7687550", kind="region"),
                              body="Deletion seen in three samples.")

            found = _list(kind="region")["notes"]
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0]["target"]["kind"], "region")
            self.assertEqual(_delete(created["id"]), {"deleted": created["id"]})

    def test_genome_note_round_trips_without_a_gene(self):
        with _store():
            created = _create(
                target=_target(gene_id="general", label="General notes", kind="genome"),
                body="Assembly-wide observation.",
            )
            found = _list(kind="genome", genome_key=GENOME_KEY)["notes"]
            self.assertEqual([note["id"] for note in found], [created["id"]])

    def test_todo_requires_a_title_and_persists_workflow_fields(self):
        with _store():
            todo_target = _target(gene_id="tasks", label="Todo", genome_key="global::todos", kind="todo")
            with self.assertRaises(HTTPException) as ctx:
                _create(target=todo_target, title="")
            self.assertEqual(ctx.exception.status_code, 400)

            created = _create(
                target=todo_target,
                title="Review REG4 notes",
                status="in_progress",
                priority="high",
                todo_order=2048,
            )
            self.assertEqual(created["status"], "in_progress")
            self.assertEqual(created["priority"], "high")
            self.assertEqual(created["todo_order"], 2048)

            completed = _update(created["id"], completed=True, status="waiting", priority="high")
            self.assertTrue(completed["completed"])
            self.assertTrue(completed["completed_at"])
            self.assertEqual(completed["status"], "completed")
            self.assertEqual(completed["priority"], "high")

            abandoned = _update(created["id"], status="abandoned")
            self.assertFalse(abandoned["completed"])
            self.assertEqual(abandoned["completed_at"], "")
            self.assertEqual(abandoned["status"], "abandoned")

            with self.assertRaises(HTTPException) as ctx:
                _update(created["id"], title="")
            self.assertEqual(ctx.exception.status_code, 400)

    def test_bodies_and_titles_are_capped(self):
        with _store():
            created = _create(
                target=_target(),
                title="t" * (main.MAX_NOTE_TITLE_CHARS + 50),
                body="b" * (main.MAX_NOTE_BODY_CHARS + 50),
            )
            self.assertEqual(len(created["title"]), main.MAX_NOTE_TITLE_CHARS)
            self.assertEqual(len(created["body"]), main.MAX_NOTE_BODY_CHARS)


class UserNotesEnvironmentTests(unittest.TestCase):
    def test_cache_dir_honours_the_electron_user_data_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with patch.dict(main.os.environ, {"ENSEMBL_GO_USER_DATA_DIR": str(root)}):
                self.assertEqual(main.get_cache_dir(), (root / "cache").resolve())


if __name__ == "__main__":
    unittest.main()

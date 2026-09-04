"""Notes transfer: what survives a round trip, and what a merge is allowed to do.

Pure-module tests — notes_transfer imports neither FastAPI nor main, so nothing
here needs a store or an event loop.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import notes_transfer as nt  # noqa: E402


GENOME_KEY = "ensembl::homo_sapiens::GRCh38"


def note(
    note_id="note_aaaaaaaaaaaa",
    kind="gene",
    target_id="ENSG00000141510",
    label="TP53",
    genome_key=GENOME_KEY,
    title="",
    body="",
    tags=(),
    created_at="2026-01-01T00:00:00Z",
    updated_at="2026-01-02T00:00:00Z",
    archived=False,
    archived_at="",
    status="backlog",
    priority="medium",
    completed=False,
    completed_at="",
    todo_order=0,
    selection_key="",
):
    return {
        "id": note_id,
        "target": {
            "kind": kind,
            "genome_key": genome_key,
            "id": target_id,
            "label": label,
            "genome_selection_key": selection_key,
        },
        "title": title,
        "body": body,
        "tags": list(tags),
        "created_at": created_at,
        "updated_at": updated_at,
        "archived": archived,
        "archived_at": archived_at,
        "status": status,
        "priority": priority,
        "completed": completed,
        "completed_at": completed_at,
        "todo_order": todo_order,
    }


def todo(note_id="note_todo00000001", title="Check REG4", **kwargs):
    kwargs.setdefault("kind", "todo")
    kwargs.setdefault("genome_key", "global::todos")
    kwargs.setdefault("target_id", "tasks")
    kwargs.setdefault("label", "Todo")
    kwargs.setdefault("status", "in_progress")
    kwargs.setdefault("priority", "high")
    kwargs.setdefault("todo_order", 1024)
    return note(note_id=note_id, title=title, **kwargs)


MIXED = [
    note(body="Exon 4 differs."),
    note(note_id="note_bbbbbbbbbbbb", kind="genome", target_id="general",
         label="General notes", title="Assembly notes", body="Scaffolded."),
    todo(),
    note(note_id="note_cccccccccccc", kind="region", target_id="chr17:7668402-7687550",
         label="", body="Busy region."),
    note(note_id="note_dddddddddddd", body="Old thought.", archived=True,
         archived_at="2026-02-01T00:00:00Z"),
]


def roundtrip(notes, fmt):
    text = nt.serialise_notes(notes, fmt=fmt)
    parsed = nt.parse_transfer_text(text, fmt=fmt)
    assert not parsed["document_errors"], parsed["document_errors"]
    for row in parsed["rows"]:
        assert not row["errors"], (row["line"], row["errors"])
    return nt.valid_notes(parsed)


class RoundTripTests(unittest.TestCase):
    def test_json_round_trip_is_identity(self):
        self.assertEqual(roundtrip(MIXED, "json"), MIXED)

    def test_csv_round_trip_is_identity(self):
        self.assertEqual(roundtrip(MIXED, "csv"), MIXED)

    def test_tsv_round_trip_is_identity(self):
        self.assertEqual(roundtrip(MIXED, "tsv"), MIXED)

    def test_awkward_bodies_survive_csv(self):
        awkward = [
            note(note_id="note_000000000001", body='He said "yes", then left.'),
            note(note_id="note_000000000002", body="line one\nline two\r\nline three"),
            note(note_id="note_000000000003", body="col\tsep\tvalues"),
            note(note_id="note_000000000004", body="=cmd|'/c calc'!A1"),
            note(note_id="note_000000000005", body="ΔΔG rose 2.4 kcal·mol⁻¹ — 中文"),
            note(note_id="note_000000000006", body="x" * 200_000),
            note(note_id="note_000000000007", title="'already quoted", body="-1 fold"),
        ]
        self.assertEqual(roundtrip(awkward, "csv"), awkward)

    def test_awkward_bodies_survive_tsv(self):
        awkward = [
            note(note_id="note_000000000002", body="line one\nline two"),
            note(note_id="note_000000000003", body="col\tsep\tvalues"),
        ]
        self.assertEqual(roundtrip(awkward, "tsv"), awkward)

    def test_tags_round_trip_including_awkward_characters(self):
        tagged = [note(tags=["REG4", "needs review", "5' UTR"])]
        self.assertEqual(roundtrip(tagged, "csv")[0]["tags"], ["REG4", "needs review", "5' UTR"])


class SpreadsheetGuardTests(unittest.TestCase):
    def test_formula_leads_are_guarded(self):
        for value in ("=SUM(A1)", "+1", "-1", "@here", "\tx", "\rx"):
            self.assertEqual(nt.spreadsheet_guard(value), "'" + value)

    def test_guard_is_invertible(self):
        for value in ("=SUM(A1)", "+1", "-1", "@here", "plain", "", "'quoted"):
            self.assertEqual(nt.unguard_spreadsheet(nt.spreadsheet_guard(value)), value)

    def test_ordinary_text_is_untouched(self):
        self.assertEqual(nt.spreadsheet_guard("REG4 looks fine"), "REG4 looks fine")

    def test_leading_apostrophe_on_ordinary_text_is_kept(self):
        self.assertEqual(nt.unguard_spreadsheet("'tis a note"), "'tis a note")


class HeaderTests(unittest.TestCase):
    def _csv(self, header, *rows):
        return "\r\n".join([header, *rows]) + "\r\n"

    def test_missing_required_column_is_a_document_error(self):
        text = self._csv("kind,genome_key,target_id", "gene,%s,ENSG1" % GENOME_KEY)
        parsed = nt.parse_transfer_text(text, fmt="csv")
        self.assertTrue(parsed["document_errors"])
        self.assertIn("id", parsed["document_errors"][0])
        self.assertEqual(nt.valid_notes(parsed), [])

    def test_unknown_column_is_a_warning_only(self):
        text = nt.serialise_delimited([note()], delimiter=",")
        text = text.replace("todo_order", "todo_order,mystery", 1)
        text = text.rstrip("\r\n") + ",extra\r\n"
        parsed = nt.parse_transfer_text(text, fmt="csv")
        self.assertEqual(parsed["document_errors"], [])
        self.assertTrue(parsed["document_warnings"])
        self.assertEqual(len(nt.valid_notes(parsed)), 1)

    def test_reordered_columns_parse_by_name(self):
        rows = nt.serialise_delimited([note(body="Reordered.")], delimiter=",").splitlines()
        header = rows[0].split(",")
        values = rows[1].split(",")
        order = list(reversed(range(len(header))))
        flipped = "\r\n".join([
            ",".join(header[i] for i in order),
            ",".join(values[i] for i in order),
        ]) + "\r\n"
        parsed = nt.parse_transfer_text(flipped, fmt="csv")
        self.assertEqual(parsed["document_errors"], [])
        self.assertEqual(nt.valid_notes(parsed)[0]["body"], "Reordered.")

    def test_header_with_no_data_rows_is_an_error(self):
        parsed = nt.parse_transfer_text(",".join(nt.TRANSFER_COLUMNS) + "\r\n", fmt="csv")
        self.assertTrue(parsed["document_errors"])

    def test_excel_utf8_bom_does_not_eat_the_id_column(self):
        text = "﻿" + nt.serialise_delimited([note(body="BOM.")], delimiter=",")
        parsed = nt.parse_transfer_text(text, fmt="csv")
        self.assertEqual(parsed["document_errors"], [])
        self.assertEqual(nt.valid_notes(parsed)[0]["id"], "note_aaaaaaaaaaaa")


class RowValidationTests(unittest.TestCase):
    def _row(self, **overrides):
        row = nt.note_to_row(note())
        row.update(overrides)
        return row

    def test_missing_target_id_is_an_error(self):
        parsed, errors, _ = nt.row_to_note(self._row(target_id=""), line=2)
        self.assertIsNone(parsed)
        self.assertTrue(any("target_id" in e for e in errors))

    def test_missing_genome_key_is_an_error(self):
        parsed, errors, _ = nt.row_to_note(self._row(genome_key=""), line=2)
        self.assertIsNone(parsed)
        self.assertTrue(any("genome_key" in e for e in errors))

    def test_todo_without_a_title_is_an_error(self):
        row = nt.note_to_row(todo(title="x"))
        row["title"] = ""
        parsed, errors, _ = nt.row_to_note(row, line=2)
        self.assertIsNone(parsed)
        self.assertTrue(any("todo_title_required" in e for e in errors))

    def test_numeric_timestamp_is_rejected_not_guessed(self):
        parsed, errors, _ = nt.row_to_note(self._row(updated_at="46256.3837"), line=2)
        self.assertIsNone(parsed)
        self.assertTrue(any("timestamp_is_number" in e for e in errors))

    def test_boolean_spellings_are_accepted(self):
        for token in ("true", "TRUE", "1", "yes", "Y"):
            parsed, errors, _ = nt.row_to_note(self._row(archived=token), line=2)
            self.assertEqual(errors, [])
            self.assertTrue(parsed["archived"])
        for token in ("false", "FALSE", "0", "no", ""):
            parsed, errors, _ = nt.row_to_note(self._row(archived=token), line=2)
            self.assertEqual(errors, [])
            self.assertFalse(parsed["archived"])

    def test_unparseable_boolean_is_an_error(self):
        parsed, errors, _ = nt.row_to_note(self._row(archived="maybe"), line=2)
        self.assertIsNone(parsed)
        self.assertTrue(any("archived" in e for e in errors))

    def test_dataset_release_is_stripped_from_the_genome_key(self):
        row = self._row(genome_key=GENOME_KEY + "::dataset::ensembl/2025_12")
        parsed, errors, _ = nt.row_to_note(row, line=2)
        self.assertEqual(errors, [])
        self.assertEqual(parsed["target"]["genome_key"], GENOME_KEY)

    def test_body_at_the_excel_cell_limit_warns(self):
        _, errors, warnings = nt.row_to_note(self._row(body="x" * nt.SPREADSHEET_CELL_LIMIT), line=2)
        self.assertEqual(errors, [])
        self.assertTrue(any("spreadsheet_truncated" in w for w in warnings))

    def test_unknown_todo_status_falls_back_with_a_warning(self):
        row = nt.note_to_row(todo())
        row["todo_status"] = "procrastinating"
        parsed, errors, warnings = nt.row_to_note(row, line=2)
        self.assertEqual(errors, [])
        self.assertEqual(parsed["status"], "backlog")
        self.assertTrue(any("unknown todo_status" in w for w in warnings))


class ColumnShapeTests(unittest.TestCase):
    def test_todo_columns_are_blank_for_a_gene_note(self):
        row = nt.note_to_row(note())
        for column in ("todo_status", "todo_priority", "todo_completed", "todo_completed_at", "todo_order"):
            self.assertEqual(row[column], "", column)

    def test_todo_columns_are_populated_for_a_task(self):
        row = nt.note_to_row(todo(completed=True, completed_at="2026-03-01T00:00:00Z"))
        self.assertEqual(row["todo_status"], "in_progress")
        self.assertEqual(row["todo_priority"], "high")
        self.assertEqual(row["todo_completed"], "true")
        self.assertEqual(row["todo_order"], "1024")

    def test_one_file_carries_todos_and_notes_together(self):
        text = nt.serialise_delimited([todo(), note(body="A gene note.")], delimiter=",")
        parsed = nt.valid_notes(nt.parse_transfer_text(text, fmt="csv"))
        kinds = [record["target"]["kind"] for record in parsed]
        self.assertEqual(kinds, ["todo", "gene"])
        self.assertEqual(parsed[1]["status"], "backlog")


class DiffTests(unittest.TestCase):
    def test_statuses(self):
        stored = note(body="Stored.")
        by_id = {stored["id"]: stored}
        same = diff = None
        [same] = nt.diff_against_store([dict(stored)], by_id)
        self.assertEqual(same["status"], "identical")
        [diff] = nt.diff_against_store([note(body="Changed.")], by_id)
        self.assertEqual(diff["status"], "differs")
        [fresh] = nt.diff_against_store([note(note_id="note_new000000000")], by_id)
        self.assertEqual(fresh["status"], "new")

    def test_csv_round_trip_reports_identical(self):
        stored = MIXED
        by_id = {record["id"]: record for record in stored}
        parsed = roundtrip(stored, "csv")
        statuses = {row["status"] for row in nt.diff_against_store(parsed, by_id)}
        self.assertEqual(statuses, {"identical"})

    def test_target_change_is_flagged(self):
        stored = note(body="Same text.")
        moved = note(target_id="ENSG00000134193", label="REG4", body="Same text.")
        [row] = nt.diff_against_store([moved], {stored["id"]: stored})
        self.assertEqual(row["status"], "differs")
        self.assertTrue(any("target_changed" in w for w in row["warnings"]))

    def test_blanking_an_existing_note_is_flagged(self):
        stored = note(body="Hard-won paragraph.")
        blank = note(body="", updated_at="2027-01-01T00:00:00Z")
        [row] = nt.diff_against_store([blank], {stored["id"]: stored})
        self.assertTrue(any("would_blank_existing" in w for w in row["warnings"]))


class NearDuplicateTests(unittest.TestCase):
    def test_same_target_and_title_with_a_different_id_is_reported(self):
        stored = [note(title="Coverage dip")]
        incoming = [note(note_id="note_zzzzzzzzzzzz", title="Coverage dip")]
        found = nt.find_near_duplicates(incoming, stored)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["existing_id"], "note_aaaaaaaaaaaa")

    def test_untitled_notes_are_never_near_duplicates(self):
        stored = [note(title="", body="one")]
        incoming = [note(note_id="note_zzzzzzzzzzzz", title="", body="two")]
        self.assertEqual(nt.find_near_duplicates(incoming, stored), [])

    def test_a_matching_id_is_not_a_near_duplicate(self):
        stored = [note(title="Coverage dip")]
        self.assertEqual(nt.find_near_duplicates([note(title="Coverage dip")], stored), [])


class MergeTests(unittest.TestCase):
    NOW = "2026-06-01T00:00:00Z"

    def setUp(self):
        self.minted = iter(f"note_minted{i:06d}" for i in range(100))

    def mint(self):
        return next(self.minted)

    def merge(self, existing, incoming, strategy):
        return nt.apply_merge(existing, incoming, strategy, now=self.NOW, mint_id=self.mint)

    def test_unknown_strategy_raises(self):
        with self.assertRaises(ValueError):
            self.merge([], [], "vibes")

    def test_newer_wins_takes_the_later_copy(self):
        stored = note(body="Old.", updated_at="2026-01-01T00:00:00Z")
        fresh = note(body="New.", updated_at="2026-05-01T00:00:00Z")
        result, counts = self.merge([stored], [fresh], "newer_wins")
        self.assertEqual(result[0]["body"], "New.")
        self.assertEqual(counts["updated"], 1)

    def test_newer_wins_keeps_the_stored_copy_when_the_file_is_older(self):
        stored = note(body="New.", updated_at="2026-05-01T00:00:00Z")
        stale = note(body="Old.", updated_at="2026-01-01T00:00:00Z")
        result, counts = self.merge([stored], [stale], "newer_wins")
        self.assertEqual(result[0]["body"], "New.")
        self.assertEqual(counts["unchanged"], 1)

    def test_newer_wins_preserves_incoming_timestamps(self):
        fresh = note(body="New.", updated_at="2026-05-01T00:00:00Z")
        result, _ = self.merge([note(updated_at="2026-01-01T00:00:00Z")], [fresh], "newer_wins")
        self.assertEqual(result[0]["updated_at"], "2026-05-01T00:00:00Z")

    def test_newer_but_blank_never_wipes_a_written_note(self):
        stored = note(body="Hard-won paragraph.", updated_at="2026-01-01T00:00:00Z")
        blank = note(title="", body="", updated_at="2027-01-01T00:00:00Z")
        result, counts = self.merge([stored], [blank], "newer_wins")
        self.assertEqual(result[0]["body"], "Hard-won paragraph.")
        self.assertEqual(counts["skipped"], 1)
        self.assertEqual(counts["updated"], 0)

    def test_newer_wins_adds_unknown_ids(self):
        result, counts = self.merge([note()], [note(note_id="note_new000000000")], "newer_wins")
        self.assertEqual(len(result), 2)
        self.assertEqual(counts["added"], 1)

    def test_replace_matching_stamps_now_so_it_beats_a_second_store(self):
        stored = note(body="New.", updated_at="2026-05-01T00:00:00Z")
        older = note(body="From the file.", updated_at="2026-01-01T00:00:00Z")
        result, counts = self.merge([stored], [older], "replace_matching")
        self.assertEqual(result[0]["body"], "From the file.")
        self.assertEqual(result[0]["updated_at"], self.NOW)
        self.assertEqual(counts["updated"], 1)

    def test_replace_matching_leaves_identical_notes_alone(self):
        stored = note(body="Same.")
        result, counts = self.merge([stored], [dict(stored)], "replace_matching")
        self.assertEqual(result[0]["updated_at"], stored["updated_at"])
        self.assertEqual(counts["unchanged"], 1)
        self.assertEqual(counts["updated"], 0)

    def test_replace_matching_leaves_unmatched_stored_notes_alone(self):
        keep = note(note_id="note_keep00000000", body="Untouched.")
        result, _ = self.merge([keep], [note(body="Imported.")], "replace_matching")
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["body"], "Untouched.")

    def test_add_as_new_mints_fresh_ids_and_keeps_everything(self):
        stored = note(body="Mine.")
        result, counts = self.merge([stored], [note(body="Theirs."), note(body="Also theirs.")], "add_as_new")
        self.assertEqual(len(result), 3)
        self.assertEqual(counts["added"], 2)
        ids = [record["id"] for record in result]
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(ids[0], stored["id"])
        self.assertTrue(all(i.startswith("note_minted") for i in ids[1:]))

    def test_add_as_new_preserves_incoming_timestamps(self):
        result, _ = self.merge([], [note(updated_at="2026-05-01T00:00:00Z")], "add_as_new")
        self.assertEqual(result[0]["updated_at"], "2026-05-01T00:00:00Z")

    def test_replace_all_is_exactly_the_file(self):
        stored = [note(note_id="note_gone00000000"), note(note_id="note_kept00000000")]
        incoming = [note(note_id="note_kept00000000", body="Kept."), note(note_id="note_new000000000")]
        result, counts = self.merge(stored, incoming, "replace_all")
        self.assertEqual([r["id"] for r in result], ["note_kept00000000", "note_new000000000"])
        self.assertEqual(counts["deleted"], 1)
        self.assertEqual(counts["updated"], 1)
        self.assertEqual(counts["added"], 1)

    def test_blank_ids_are_minted_rather_than_colliding(self):
        result, counts = self.merge([], [note(note_id=""), note(note_id="")], "newer_wins")
        self.assertEqual(len({r["id"] for r in result}), 2)
        self.assertEqual(counts["added"], 2)

    def test_missing_timestamps_are_filled_at_merge_time(self):
        result, _ = self.merge([], [note(created_at="", updated_at="")], "newer_wins")
        self.assertEqual(result[0]["created_at"], self.NOW)
        self.assertEqual(result[0]["updated_at"], self.NOW)

    def test_merge_does_not_mutate_its_inputs(self):
        stored = note(body="Stored.")
        incoming = note(body="Incoming.", updated_at="2027-01-01T00:00:00Z")
        self.merge([stored], [incoming], "replace_matching")
        self.assertEqual(stored["body"], "Stored.")
        self.assertEqual(incoming["updated_at"], "2027-01-01T00:00:00Z")


class DigestTests(unittest.TestCase):
    def test_store_digest_ignores_order(self):
        a = [note(note_id="note_1"), note(note_id="note_2")]
        self.assertEqual(nt.store_digest(a), nt.store_digest(list(reversed(a))))

    def test_store_digest_moves_when_a_note_is_edited(self):
        before = [note(updated_at="2026-01-01T00:00:00Z")]
        after = [note(updated_at="2026-01-02T00:00:00Z")]
        self.assertNotEqual(nt.store_digest(before), nt.store_digest(after))


class SniffTests(unittest.TestCase):
    def test_extension_wins(self):
        self.assertEqual(nt.sniff_transfer_format("notes.json", "id,kind"), "json")
        self.assertEqual(nt.sniff_transfer_format("notes.tsv", "{"), "tsv")
        self.assertEqual(nt.sniff_transfer_format("notes.csv", "{"), "csv")

    def test_content_is_the_fallback(self):
        self.assertEqual(nt.sniff_transfer_format("notes.txt", '  {"notes": []}'), "json")
        self.assertEqual(nt.sniff_transfer_format("notes.txt", "id\tkind\tgenome_key"), "tsv")
        self.assertEqual(nt.sniff_transfer_format("notes.txt", "id,kind,genome_key"), "csv")


if __name__ == "__main__":
    unittest.main()

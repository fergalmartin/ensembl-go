import asyncio
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    TrackHubDiscoverRequest,
    TrackHubGenomeRequest,
    TrackHubImportItem,
    TrackHubImportRequest,
    _compute_trackhub_import_key,
    _normalize_trackhub_source_meta,
    _read_trackhub_import_tasks,
    _run_trackhub_import_task,
    _trackhub_import_tasks,
    _trackhub_import_tasks_guard,
    _validate_trackhub_data_url,
    discover_trackhub_tracks,
    import_trackhub_tracks,
)


class TrackHubIntegrationTests(unittest.TestCase):
    def tearDown(self):
        self._clear_tasks()

    def _clear_tasks(self):
        with _trackhub_import_tasks_guard:
            _trackhub_import_tasks.clear()

    def test_normalize_source_meta_computes_stable_import_key(self):
        raw = {
            "hub_id": "hubA",
            "track_id": "trackA",
            "assembly": "GRCh38",
            "format": "bigWig",
            "data_url": "https://example.org/path/track.bw",
        }
        normalized = _normalize_trackhub_source_meta(raw)
        self.assertIsNotNone(normalized)
        expected = _compute_trackhub_import_key("hubA", "trackA", "GRCh38", "https://example.org/path/track.bw")
        self.assertEqual(normalized["import_key"], expected)
        self.assertEqual(normalized["format"], "bigWig")

    def test_validate_trackhub_data_url_upgrades_http(self):
        upgraded = _validate_trackhub_data_url("http://ftp.ensembl.org/pub/papers/regulation/hg38/overview/RegBuild.bb")
        self.assertEqual(
            upgraded,
            "https://ftp.ensembl.org/pub/papers/regulation/hg38/overview/RegBuild.bb",
        )

    def test_discover_groups_by_genome_and_filters_to_supported_formats(self):
        genome = TrackHubGenomeRequest(
            genome_key="species_a::ASM1",
            species_key="species_a",
            scientific_name="Species alpha",
            common_name="Alpha",
            assembly="ASM1",
            assembly_name="ASM1",
        )
        mock_payload = {
            "species_a::ASM1": {
                "genome_key": "species_a::ASM1",
                "tracks": [
                    {
                        "hub_id": "hub1",
                        "hub_name": "Hub One",
                        "track_id": "tr_bw",
                        "track_name": "RNA signal",
                        "assembly": "ASM1",
                        "format": "bigWig",
                        "data_url": "https://example.org/rna.bw",
                        "description": "Signal",
                        "import_key": "key_bw",
                    },
                    {
                        "hub_id": "hub1",
                        "hub_name": "Hub One",
                        "track_id": "tr_bed",
                        "track_name": "Unsupported BED",
                        "assembly": "ASM1",
                        "format": "bed",
                        "data_url": "https://example.org/unsupported.bed",
                        "description": "Unsupported",
                        "import_key": "key_bed",
                    },
                ],
                "error": "",
            }
        }

        with patch("main.list_tracks_for_genomes", return_value=mock_payload):
            response = asyncio.run(discover_trackhub_tracks(TrackHubDiscoverRequest(genomes=[genome], refresh=False)))

        self.assertIn("genomes", response)
        self.assertEqual(len(response["genomes"]), 1)
        rows = response["genomes"][0]["tracks"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["type"], "bigwig")
        self.assertEqual(rows[0]["import_key"], "key_bw")

    def test_import_endpoint_preserves_provided_import_key(self):
        source_meta = {
            "hub_id": "hub1",
            "hub_name": "Hub",
            "track_id": "track1",
            "track_name": "Track 1",
            "assembly": "ASM1",
            "format": "bigWig",
            "data_url": "https://example.org/track1.bw",
            "description": "",
            "import_key": "provided_key_1",
        }
        request = TrackHubImportRequest(
            output_dir="/tmp/out",
            items=[
                TrackHubImportItem(
                    genome_key="species_a::ASM1",
                    species_key="species_a",
                    assembly="ASM1",
                    label="Track 1",
                    source_meta=source_meta,
                )
            ],
        )

        created_coroutines = []

        def _capture_task(coro):
            created_coroutines.append(coro)
            return None

        try:
            with patch("main.asyncio.create_task", side_effect=_capture_task):
                response = asyncio.run(import_trackhub_tracks(request))

            self.assertEqual(response.get("status"), "started")
            tasks = _read_trackhub_import_tasks()
            self.assertEqual(len(tasks), 1)
            self.assertEqual(tasks[0]["import_key"], "provided_key_1")
        finally:
            for coro in created_coroutines:
                try:
                    coro.close()
                except Exception:
                    pass

    def test_import_endpoint_rejects_unsupported_formats(self):
        request = TrackHubImportRequest(
            output_dir="/tmp/out",
            items=[
                TrackHubImportItem(
                    genome_key="species_a::ASM1",
                    species_key="species_a",
                    assembly="ASM1",
                    source_meta={
                        "hub_id": "hub1",
                        "track_id": "track_bad",
                        "assembly": "ASM1",
                        "format": "bed",
                        "data_url": "https://example.org/track_bad.bed",
                    },
                )
            ],
        )
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(import_trackhub_tracks(request))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_run_import_task_downloads_and_registers(self):
        task_id = "task-trackhub-1"
        source_meta = {
            "hub_id": "hub1",
            "hub_name": "Hub",
            "track_id": "track1",
            "track_name": "Track 1",
            "assembly": "ASM1",
            "format": "bigWig",
            "data_url": "http://example.org/track1.bw",
            "description": "",
            "import_key": "provided_key_2",
        }
        item = TrackHubImportItem(
            genome_key="species_a::ASM1",
            species_key="species_a",
            assembly="ASM1",
            label="Track 1",
            source_meta=source_meta,
        )

        with _trackhub_import_tasks_guard:
            _trackhub_import_tasks[task_id] = {
                "id": task_id,
                "status": "queued",
                "progress": 0.0,
                "error": "",
                "message": "Queued",
                "genome_key": "species_a::ASM1",
                "created_at": "",
                "updated_at": "",
                "_updated_ts": time.time(),
                "import_key": "provided_key_2",
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            asm_dir = Path(tmpdir) / "local_data" / "species_a" / "ASM1"

            def _fake_download(_task_id, _url, destination):
                self.assertEqual(_url, "https://example.org/track1.bw")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"BW")

            register_mock = AsyncMock(
                return_value={
                    "id": "trk_1",
                    "label": "Track 1",
                    "genome_key": "species_a::ASM1",
                    "source": "trackhub",
                    "source_meta": {"import_key": "provided_key_2"},
                }
            )

            with patch("main._resolve_species_assembly_dir", return_value=asm_dir), \
                patch("main._find_existing_trackhub_track", return_value=None), \
                patch("main._trackhub_download_sync", side_effect=_fake_download), \
                patch("main.register_track", register_mock):
                asyncio.run(_run_trackhub_import_task(task_id, tmpdir, item))

        tasks = _read_trackhub_import_tasks()
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["status"], "completed")
        self.assertEqual(tasks[0]["message"], "Track imported.")
        self.assertEqual(register_mock.await_count, 1)
        entry = register_mock.await_args.args[0]
        self.assertEqual(entry.source, "trackhub")
        self.assertEqual(entry.display_mode, "signal_plot")
        self.assertEqual((entry.bigwig_settings or {}).get("data_type"), "custom")
        self.assertEqual(entry.source_meta.get("import_key"), "provided_key_2")
        self.assertEqual(entry.source_meta.get("data_url"), "https://example.org/track1.bw")


if __name__ == "__main__":
    unittest.main()

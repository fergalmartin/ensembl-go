import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trackhub_registry import (  # noqa: E402
    _TRACKHUB_CACHE,
    _TRACKHUB_CACHE_LOCK,
    _TRACKDB_CACHE,
    _TRACKDB_CACHE_LOCK,
    _assembly_query_tokens,
    _fetch_tracks_for_genome,
    _load_trackdb_tracks,
    _parse_trackdb_stanzas,
    _search_registry,
    list_tracks_for_genomes,
)


class _FakeResponse:
    def __init__(self, payload=None, text="", status_code=200):
        self._payload = payload
        self.text = text
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class TrackHubRegistryAdapterTests(unittest.TestCase):
    def tearDown(self):
        with _TRACKHUB_CACHE_LOCK:
            _TRACKHUB_CACHE.clear()
        with _TRACKDB_CACHE_LOCK:
            _TRACKDB_CACHE.clear()

    def test_search_registry_uses_pagination(self):
        responses = [
            _FakeResponse(
                {
                    "total_entries": 7,
                    "items": [{"trackdb_id": 1}],
                    "next": "https://www.trackhubregistry.org/api/search?page=2",
                }
            ),
            _FakeResponse(
                {
                    "total_entries": 7,
                    "items": [{"trackdb_id": 2}],
                    "next": None,
                }
            ),
        ]

        call_pages = []

        def _fake_post(_url, params=None, json=None, timeout=None, headers=None):
            del timeout, headers
            call_pages.append((params.get("page"), dict(json or {})))
            return responses.pop(0)

        with patch("trackhub_registry.requests.post", side_effect=_fake_post):
            items, err = _search_registry({"assembly": "GRCh38"})

        self.assertEqual(err, "")
        self.assertEqual(len(items), 2)
        self.assertEqual(call_pages, [(1, {"assembly": "GRCh38"}), (2, {"assembly": "GRCh38"})])

    def test_parse_trackdb_stanzas(self):
        text = """
track First
bigDataUrl first.bb
type bigBed 12
shortLabel First label

track Second
bigDataUrl second.bw
type bigWig
longLabel Second label
""".strip()

        stanzas = _parse_trackdb_stanzas(text)
        self.assertEqual(len(stanzas), 2)
        self.assertEqual(stanzas[0]["track"], "First")
        self.assertEqual(stanzas[1]["bigdataurl"], "second.bw")

    def test_load_trackdb_tracks_extracts_bigbed_bigwig(self):
        text = """
track Parent
shortLabel Parent only

track BedTrack
bigDataUrl ./data/regions.bb
type bigBed 9
shortLabel Regions
longLabel Region annotations

track WigTrack
bigDataUrl https://example.org/signal.bw
type bigWig
shortLabel Signal
""".strip()

        meta = {
            "hub_id": "hub://example",
            "hub_name": "Example Hub",
            "hub_long_label": "Hub description",
            "trackdb_url": "http://example.org/trackDb.txt",
            "assembly_name": "GRCh38",
            "assembly_accession": "GCA_000001405.15",
            "species": "Homo sapiens",
        }

        with patch("trackhub_registry.requests.get", return_value=_FakeResponse(text=text)):
            tracks, err = _load_trackdb_tracks(meta)

        self.assertEqual(err, "")
        self.assertEqual(len(tracks), 2)
        self.assertEqual(tracks[0]["type"], "bigbed")
        self.assertEqual(tracks[0]["data_url"], "https://example.org/data/regions.bb")
        self.assertEqual(tracks[1]["type"], "bigwig")
        self.assertEqual(tracks[1]["data_url"], "https://example.org/signal.bw")

    def test_assembly_query_tokens_include_version_and_base(self):
        tokens = _assembly_query_tokens(
            {
                "assembly": "GCA_000001405.29",
                "assembly_name": "GRCh38.p14",
            }
        )
        self.assertIn("GCA_000001405.29", tokens)
        self.assertIn("GCA_000001405", tokens)
        self.assertIn("GRCh38.p14", tokens)
        self.assertIn("GRCh38", tokens)

    def test_fetch_tracks_for_genome_is_uncapped(self):
        raw_search_item = {
            "trackdb_id": 1,
            "source": {"url": "https://example.org/trackDb.txt"},
            "hub": {"url": "https://example.org/hub.txt", "name": "Example Hub"},
            "assembly": {"accession": "GCA_000001405.15", "name": "GRCh38"},
            "species": {"scientific_name": "Homo sapiens", "common_name": "Human"},
        }
        tracks = []
        for idx in range(3001):
            track_type = "bigwig" if idx % 2 == 0 else "bigbed"
            tracks.append(
                {
                    "hub_id": "https://example.org/hub.txt",
                    "hub_name": "Example Hub",
                    "track_id": f"trk_{idx:04d}",
                    "track_name": f"Track {idx:04d}",
                    "assembly": "GRCh38",
                    "format": "bigWig" if track_type == "bigwig" else "bigBed",
                    "type": track_type,
                    "data_url": f"https://example.org/data/{idx:04d}.{'bw' if track_type == 'bigwig' else 'bb'}",
                    "description": "",
                    "species": "Homo sapiens",
                    "import_key": f"imp_{idx:04d}",
                }
            )

        with patch("trackhub_registry._search_registry", return_value=([raw_search_item], "")), \
            patch("trackhub_registry._load_trackdb_tracks", return_value=(tracks, "")):
            discovered, err = _fetch_tracks_for_genome(
                {
                    "genome_key": "homo_sapiens::GCA_000001405.29",
                    "species_key": "homo_sapiens",
                    "scientific_name": "Homo sapiens",
                    "common_name": "Human",
                    "assembly": "GCA_000001405.29",
                    "assembly_name": "GRCh38.p14",
                }
            )

        self.assertEqual(err, "")
        self.assertEqual(len(discovered), 3001)

    def test_fetch_tracks_for_genome_returns_deterministic_sorted_rows(self):
        raw_search_item = {
            "trackdb_id": 1,
            "source": {"url": "https://example.org/trackDb.txt"},
            "hub": {"url": "https://example.org/hub.txt", "name": "Hub Z"},
            "assembly": {"accession": "GCA_000001405.15", "name": "GRCh38"},
            "species": {"scientific_name": "Homo sapiens", "common_name": "Human"},
        }
        unsorted_tracks = [
            {
                "hub_id": "h2",
                "hub_name": "Hub B",
                "track_id": "t3",
                "track_name": "Gamma",
                "assembly": "GRCh38",
                "format": "bigWig",
                "type": "bigwig",
                "data_url": "https://example.org/z.bw",
                "description": "",
                "species": "Homo sapiens",
                "import_key": "k3",
            },
            {
                "hub_id": "h1",
                "hub_name": "Hub A",
                "track_id": "t1",
                "track_name": "Beta",
                "assembly": "GRCh38",
                "format": "bigBed",
                "type": "bigbed",
                "data_url": "https://example.org/b.bb",
                "description": "",
                "species": "Homo sapiens",
                "import_key": "k1",
            },
            {
                "hub_id": "h1",
                "hub_name": "Hub A",
                "track_id": "t2",
                "track_name": "Alpha",
                "assembly": "GRCh38",
                "format": "bigWig",
                "type": "bigwig",
                "data_url": "https://example.org/a.bw",
                "description": "",
                "species": "Homo sapiens",
                "import_key": "k2",
            },
        ]

        with patch("trackhub_registry._search_registry", return_value=([raw_search_item], "")), \
            patch("trackhub_registry._load_trackdb_tracks", return_value=(unsorted_tracks, "")):
            discovered, err = _fetch_tracks_for_genome(
                {
                    "genome_key": "homo_sapiens::GCA_000001405.29",
                    "species_key": "homo_sapiens",
                    "scientific_name": "Homo sapiens",
                    "common_name": "Human",
                    "assembly": "GCA_000001405.29",
                    "assembly_name": "GRCh38.p14",
                }
            )

        self.assertEqual(err, "")
        ordered = [(r["hub_name"], r["type"], r["track_name"], r["data_url"]) for r in discovered]
        self.assertEqual(
            ordered,
            [
                ("Hub A", "bigbed", "Beta", "https://example.org/b.bb"),
                ("Hub A", "bigwig", "Alpha", "https://example.org/a.bw"),
                ("Hub B", "bigwig", "Gamma", "https://example.org/z.bw"),
            ],
        )

    def test_fetch_tracks_requires_assembly_match_not_species_only(self):
        raw_search_item = {
            "trackdb_id": 1,
            "source": {"url": "https://example.org/grch38/trackDb.txt"},
            "hub": {"url": "https://example.org/hub.txt", "name": "GRCh38 Hub"},
            "assembly": {"accession": "GCA_000001405.29", "name": "GRCh38"},
            "species": {"scientific_name": "Homo sapiens", "common_name": "Human"},
        }

        with patch("trackhub_registry._search_registry", return_value=([raw_search_item], "")), \
            patch("trackhub_registry._load_trackdb_tracks") as load_trackdb:
            discovered, err = _fetch_tracks_for_genome(
                {
                    "genome_key": "homo_sapiens::GCA_009914755.4",
                    "species_key": "homo_sapiens",
                    "scientific_name": "Homo sapiens",
                    "common_name": "Human",
                    "assembly": "GCA_009914755.4",
                    "assembly_name": "T2T-CHM13v2.0",
                }
            )

        self.assertEqual(discovered, [])
        self.assertIn("No track hub records", err)
        load_trackdb.assert_not_called()

    def test_fetch_tracks_allows_patch_level_assembly_name_match(self):
        raw_search_item = {
            "trackdb_id": 1,
            "source": {"url": "https://example.org/grch38/trackDb.txt"},
            "hub": {"url": "https://example.org/hub.txt", "name": "GRCh38 Hub"},
            "assembly": {"accession": "GCA_000001405.15", "name": "GRCh38"},
            "species": {"scientific_name": "Homo sapiens", "common_name": "Human"},
        }
        tracks = [
            {
                "hub_id": "https://example.org/hub.txt",
                "hub_name": "GRCh38 Hub",
                "track_id": "signal",
                "track_name": "Signal",
                "assembly": "GRCh38",
                "format": "bigWig",
                "type": "bigwig",
                "data_url": "https://example.org/signal.bw",
                "description": "",
                "species": "Homo sapiens",
                "import_key": "signal_key",
            }
        ]

        with patch("trackhub_registry._search_registry", return_value=([raw_search_item], "")), \
            patch("trackhub_registry._load_trackdb_tracks", return_value=(tracks, "")):
            discovered, err = _fetch_tracks_for_genome(
                {
                    "genome_key": "homo_sapiens::GCA_000001405.29",
                    "species_key": "homo_sapiens",
                    "scientific_name": "Homo sapiens",
                    "common_name": "Human",
                    "assembly": "GCA_000001405.29",
                    "assembly_name": "GRCh38.p14",
                }
            )

        self.assertEqual(err, "")
        self.assertEqual([row["track_id"] for row in discovered], ["signal"])

    def test_list_tracks_for_genomes_uses_disk_cache_between_processes(self):
        genome = {
            "genome_key": "species_a::ASM1",
            "species_key": "species_a",
            "scientific_name": "Species alpha",
            "common_name": "Alpha",
            "assembly": "ASM1",
            "assembly_name": "ASM1",
        }
        payload_tracks = [
            {
                "hub_id": "hub1",
                "hub_name": "Hub",
                "track_id": "track1",
                "track_name": "Track 1",
                "assembly": "ASM1",
                "format": "bigWig",
                "type": "bigwig",
                "data_url": "https://example.org/track1.bw",
                "description": "",
                "species": "Species alpha",
                "import_key": "key1",
            }
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("trackhub_registry.TRACKHUB_REGISTRY_DISK_CACHE_DIR", tmpdir):
                with patch("trackhub_registry._fetch_tracks_for_genome", return_value=(payload_tracks, "")):
                    first = list_tracks_for_genomes([genome], refresh=True)
                self.assertEqual(first["species_a::ASM1"]["tracks"][0]["track_id"], "track1")

                with _TRACKHUB_CACHE_LOCK:
                    _TRACKHUB_CACHE.clear()

                with patch("trackhub_registry._fetch_tracks_for_genome", side_effect=AssertionError("network should not run")):
                    second = list_tracks_for_genomes([genome], refresh=False)

        self.assertEqual(second["species_a::ASM1"]["tracks"][0]["track_id"], "track1")


if __name__ == "__main__":
    unittest.main()

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    VCF_SETTINGS_DEFAULTS,
    TrackRegistryEntry,
    TrackRegistryUpdateEntry,
    VcfBlockTileRequest,
    VcfBlockTilesRequest,
    _build_vcf_block_spans_fast,
    _browse_vcf_block_tiles_sync,
    _hydrate_track_defaults,
    _normalize_vcf_display_mode,
    list_tracks,
    register_track,
    update_track,
)


class _FakeVariant:
    def __init__(self, pos: int):
        self.pos = int(pos)


class _FakeVcfHandle:
    def __init__(self, positions):
        self._positions = [int(p) for p in positions]

    def fetch(self, _chrom: str, start: int, end: int):
        lo = int(start)
        hi = int(end)
        for pos in self._positions:
            if lo <= pos < hi:
                yield _FakeVariant(pos)


class VcfSettingsTests(unittest.TestCase):
    def test_vcf_mode_normalization_keeps_adaptive_token(self):
        self.assertEqual(_normalize_vcf_display_mode("adaptive"), "adaptive")
        self.assertEqual(_normalize_vcf_display_mode("block_lollipop"), "adaptive")
        self.assertEqual(_normalize_vcf_display_mode("lollipop"), "density_lollipop")
        self.assertEqual(_normalize_vcf_display_mode(None), "density_lollipop")

    def test_hydrate_track_defaults_migrates_legacy_vcf_tracks(self):
        migrated = _hydrate_track_defaults(
            {
                "id": "trk_old",
                "path": "/tmp/legacy.vcf.gz",
                "label": "Legacy",
                "type": "vcf",
                "display_mode": "adaptive",
            }
        )
        self.assertEqual(migrated["display_mode"], "density_lollipop")
        self.assertEqual(migrated["vcf_settings"]["genic_color"], VCF_SETTINGS_DEFAULTS["genic_color"])
        self.assertEqual(migrated["vcf_settings"]["intergenic_color"], VCF_SETTINGS_DEFAULTS["intergenic_color"])

        preserved = _hydrate_track_defaults(
            {
                "id": "trk_new",
                "path": "/tmp/new.vcf.gz",
                "label": "Configured",
                "type": "vcf",
                "display_mode": "adaptive",
                "vcf_settings": {
                    "genic_color": "#112233",
                    "intergenic_color": "#445566",
                },
            }
        )
        self.assertEqual(preserved["display_mode"], "adaptive")
        self.assertEqual(preserved["vcf_settings"]["genic_color"], "#112233")
        self.assertEqual(preserved["vcf_settings"]["intergenic_color"], "#445566")

    def test_register_update_and_list_vcf_settings(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            registry_path = tmp_path / "track_registry.json"
            vcf_path = tmp_path / "sample.vcf.gz"
            vcf_path.write_bytes(b"\x1f\x8b")
            Path(str(vcf_path) + ".tbi").write_bytes(b"index")

            with patch("main.TRACK_REGISTRY_FILE", registry_path):
                created = asyncio.run(
                    register_track(
                        TrackRegistryEntry(
                            path=str(vcf_path),
                            label="Variants",
                            type="vcf",
                            display_mode="adaptive",
                            vcf_settings={
                                "genic_color": "#112233",
                                "intergenic_color": "not_a_color",
                            },
                        )
                    )
                )
                self.assertEqual(created["display_mode"], "adaptive")
                self.assertEqual(created["vcf_settings"]["genic_color"], "#112233")
                self.assertEqual(created["vcf_settings"]["intergenic_color"], VCF_SETTINGS_DEFAULTS["intergenic_color"])

                updated = asyncio.run(
                    update_track(
                        created["id"],
                        TrackRegistryUpdateEntry(
                            vcf_settings={"intergenic_color": "#445566"},
                            display_mode="block-lollipop",
                        ),
                    )
                )
                self.assertEqual(updated["display_mode"], "adaptive")
                self.assertEqual(updated["vcf_settings"]["genic_color"], "#112233")
                self.assertEqual(updated["vcf_settings"]["intergenic_color"], "#445566")

                legacy = {
                    "id": "trk_legacy",
                    "path": str(vcf_path),
                    "label": "Legacy",
                    "type": "vcf",
                    "display_mode": "adaptive",
                    "genome_key": "",
                }
                registry_path.write_text(json.dumps({"tracks": [legacy]}), encoding="utf-8")
                payload = list_tracks()
                tracks = payload.get("tracks") or []
                self.assertEqual(len(tracks), 1)
                self.assertEqual(tracks[0]["display_mode"], "density_lollipop")
                self.assertEqual(tracks[0]["vcf_settings"]["genic_color"], VCF_SETTINGS_DEFAULTS["genic_color"])

    def test_vcf_block_tiles_include_density_arrays(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vcf_path = Path(tmpdir) / "tile_source.vcf.gz"
            vcf_path.write_bytes(b"vcf")
            request = VcfBlockTilesRequest(
                path=str(vcf_path),
                chrom="chr1",
                genome="reference",
                coverage_threshold=0.25,
                tiles=[
                    VcfBlockTileRequest(
                        start=0,
                        end=1000,
                        level_id="L2",
                        block_bp=100,
                        window_bp=300,
                    )
                ],
            )
            fake_handle = _FakeVcfHandle([15, 120, 450, 455, 900])

            with patch("main._open_vcf_handle_unlocked", return_value=(fake_handle, (1, 1), str(vcf_path))), \
                    patch("main._resolve_vcf_chrom", return_value="chr1"), \
                    patch("main._load_vcf_gene_intervals", return_value=[(0, 260), (700, 760)]), \
                    patch("main._load_vcf_block_tile_cache", return_value=None), \
                    patch("main._save_vcf_block_tile_cache", return_value=None):
                payload = _browse_vcf_block_tiles_sync(request)

        tiles = payload.get("tiles") or []
        self.assertEqual(len(tiles), 1)
        tile = tiles[0]
        density_bins = tile.get("density_bins") or []
        density_classes = tile.get("density_classes") or []
        self.assertEqual(tile.get("density_stride_bp"), 100)
        self.assertEqual(len(density_bins), len(density_classes))
        self.assertGreater(len(density_bins), 0)
        self.assertTrue(all(float(v) >= 0.0 for v in density_bins))
        self.assertTrue(any(float(v) > 0.0 for v in density_bins))
        self.assertTrue(all(c in {"genic", "intergenic"} for c in density_classes))
        self.assertIn("block_spans", tile)

    def test_vcf_l0_density_uses_full_counts_not_leading_window_samples(self):
        positions = list(range(0, 10_000))
        fake_handle = _FakeVcfHandle(positions)

        payload = _build_vcf_block_spans_fast(
            fake_handle,
            "chr1",
            0,
            10_000,
            100,
            500,
            0.25,
            [],
            "L0",
        )

        density_bins = [float(v) for v in payload.get("density_bins") or []]
        self.assertGreater(len(density_bins), 10)
        self.assertLess(max(density_bins) - min(density_bins), 0.05)


if __name__ == "__main__":
    unittest.main()

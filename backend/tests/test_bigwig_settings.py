import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    BIGWIG_DATA_TYPE_DEFAULTS,
    TrackRegistryEntry,
    TrackRegistryUpdateEntry,
    _hydrate_track_defaults,
    _normalize_bigwig_display_mode,
    _normalize_bigwig_settings,
    list_tracks,
    register_track,
    update_track,
)


class BigWigSettingsTests(unittest.TestCase):
    def test_normalize_bigwig_settings_invalid_values(self):
        normalized = _normalize_bigwig_settings(
            {
                "data_type": "bad_type",
                "plot_color": "nope",
                "zoned_colors": ["#ff00ff"],
                "use_default_plot_color": False,
                "use_default_zoned_colors": False,
            }
        )
        self.assertEqual(normalized["data_type"], "rna_seq")
        self.assertEqual(normalized["plot_color"], BIGWIG_DATA_TYPE_DEFAULTS["rna_seq"]["plot_color"])
        self.assertEqual(normalized["zoned_colors"][0], "#ff00ff")
        self.assertEqual(normalized["zoned_colors"][1:], BIGWIG_DATA_TYPE_DEFAULTS["rna_seq"]["zoned_colors"][1:])

    def test_legacy_display_modes_normalize_to_signal_plot(self):
        self.assertEqual(_normalize_bigwig_display_mode("line_plot", "atac_seq"), "signal_plot")
        self.assertEqual(_normalize_bigwig_display_mode("bar_chart", "custom"), "signal_plot")

        hydrated = _hydrate_track_defaults(
            {
                "id": "trk_old",
                "path": "/tmp/old.bw",
                "label": "Old",
                "type": "bigwig",
                "display_mode": "line_plot",
            }
        )
        self.assertEqual(hydrated["display_mode"], "signal_plot")
        self.assertIn("bigwig_settings", hydrated)

    def test_register_and_update_bigwig_defaults_and_custom_preservation(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            registry_path = tmp_path / "track_registry.json"

            bw_default = tmp_path / "default.bw"
            bw_default.write_bytes(b"bw")
            bw_custom = tmp_path / "custom.bw"
            bw_custom.write_bytes(b"bw")

            with patch("main.TRACK_REGISTRY_FILE", registry_path):
                created_default = asyncio.run(
                    register_track(
                        TrackRegistryEntry(
                            path=str(bw_default),
                            label="Default",
                            type="bigwig",
                        )
                    )
                )
                self.assertEqual(created_default["display_mode"], "zoned_heatmap")
                self.assertEqual(created_default["bigwig_settings"]["data_type"], "rna_seq")

                updated_default = asyncio.run(
                    update_track(
                        created_default["id"],
                        TrackRegistryUpdateEntry(
                            bigwig_settings={"data_type": "atac_seq"},
                        ),
                    )
                )
                self.assertEqual(updated_default["display_mode"], "signal_plot")
                self.assertEqual(updated_default["bigwig_settings"]["data_type"], "atac_seq")
                self.assertEqual(
                    updated_default["bigwig_settings"]["plot_color"],
                    BIGWIG_DATA_TYPE_DEFAULTS["atac_seq"]["plot_color"],
                )

                custom_settings = {
                    "data_type": "atac_seq",
                    "plot_color": "#112233",
                    "zoned_colors": ["#111111", "#222222", "#333333", "#444444"],
                    "use_default_plot_color": False,
                    "use_default_zoned_colors": False,
                }
                created_custom = asyncio.run(
                    register_track(
                        TrackRegistryEntry(
                            path=str(bw_custom),
                            label="Custom",
                            type="bigwig",
                            bigwig_settings=custom_settings,
                        )
                    )
                )
                self.assertEqual(created_custom["display_mode"], "signal_plot")
                self.assertEqual(created_custom["bigwig_settings"]["plot_color"], "#112233")

                updated_custom = asyncio.run(
                    update_track(
                        created_custom["id"],
                        TrackRegistryUpdateEntry(
                            bigwig_settings={"data_type": "chip_seq"},
                        ),
                    )
                )
                self.assertEqual(updated_custom["bigwig_settings"]["data_type"], "chip_seq")
                self.assertEqual(updated_custom["bigwig_settings"]["plot_color"], "#112233")
                self.assertEqual(
                    updated_custom["bigwig_settings"]["zoned_colors"],
                    ["#111111", "#222222", "#333333", "#444444"],
                )

    def test_list_tracks_hydrates_legacy_bigwig_records(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            registry_path = tmp_path / "track_registry.json"
            registry_path.write_text(
                json.dumps(
                    {
                        "tracks": [
                            {
                                "id": "trk_legacy",
                                "path": str(tmp_path / "legacy.bw"),
                                "label": "Legacy",
                                "type": "bigwig",
                                "display_mode": "bar_chart",
                                "genome_key": "",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            with patch("main.TRACK_REGISTRY_FILE", registry_path):
                payload = list_tracks()

        tracks = payload.get("tracks") or []
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0]["display_mode"], "signal_plot")
        self.assertEqual(tracks[0]["bigwig_settings"]["data_type"], "rna_seq")


if __name__ == "__main__":
    unittest.main()

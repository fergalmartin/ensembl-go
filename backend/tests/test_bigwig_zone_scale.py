import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    BigWigZoneScaleRequest,
    _bigwig_zone_edges,
    _normalize_bigwig_settings,
    browse_bigwig_zone_scale,
    browse_bigwig_zone_scale_shared,
    pyBigWig,
)


class ZoneEdgeTests(unittest.TestCase):
    def test_edges_are_percentiles_of_peak_heights(self):
        samples = [float(v) for v in range(1, 1001)]  # 1..1000
        self.assertEqual(_bigwig_zone_edges(samples), [501.0, 901.0, 991.0, 1000.0])

    def test_one_spike_does_not_set_the_scale(self):
        samples = [5.0] * 5000 + [8.0] * 50 + [500000.0]
        edges = _bigwig_zone_edges(samples)
        self.assertLess(edges[-1], 10)

    def test_edges_always_increase_and_ignore_empty_samples(self):
        edges = _bigwig_zone_edges([2.0] * 100 + [0.0, None, float("nan")])
        self.assertEqual(len(edges), 4)
        self.assertTrue(all(b > a for a, b in zip(edges, edges[1:])))
        self.assertEqual(_bigwig_zone_edges([0.0, None]), [])


class ZoneScaleSettingTests(unittest.TestCase):
    def test_defaults_follow_the_data_type(self):
        self.assertEqual(_normalize_bigwig_settings({"data_type": "rna_seq"})["zone_scale"], "fixed")
        for data_type in ("atac_seq", "chip_seq", "custom"):
            self.assertEqual(_normalize_bigwig_settings({"data_type": data_type})["zone_scale"], "file")

    def test_a_track_registered_before_the_setting_gets_its_type_default(self):
        stored = {"data_type": "atac_seq", "plot_color": "#b52aa1", "zoned_colors": ["#86efac"] * 4}
        self.assertEqual(_normalize_bigwig_settings(stored)["zone_scale"], "file")

    def test_a_choice_is_kept_and_nonsense_is_not(self):
        self.assertEqual(_normalize_bigwig_settings({"data_type": "rna_seq", "zone_scale": "file"})["zone_scale"], "file")
        self.assertEqual(_normalize_bigwig_settings({}, previous={"data_type": "atac_seq", "zone_scale": "fixed"})["zone_scale"], "fixed")
        self.assertEqual(_normalize_bigwig_settings({"data_type": "atac_seq", "zone_scale": "log"})["zone_scale"], "file")


class SharedZoneTests(unittest.TestCase):
    def test_shared_zones_are_kept_with_their_scale(self):
        settings = _normalize_bigwig_settings({"data_type": "atac_seq", "zone_scale": "files", "shared_zones": [1, 3, 5, 8]})
        self.assertEqual((settings["zone_scale"], settings["shared_zones"]), ("files", [1.0, 3.0, 5.0, 8.0]))

    def test_without_shared_zones_the_files_own_peaks_are_the_nearest_thing(self):
        self.assertEqual(_normalize_bigwig_settings({"data_type": "atac_seq", "zone_scale": "files"})["zone_scale"], "file")


class CustomZoneTests(unittest.TestCase):
    def test_custom_zones_are_kept_when_sound(self):
        settings = _normalize_bigwig_settings({"data_type": "atac_seq", "zone_scale": "custom", "custom_zones": [1, 2, "4", 8.5]})
        self.assertEqual(settings["zone_scale"], "custom")
        self.assertEqual(settings["custom_zones"], [1.0, 2.0, 4.0, 8.5])

    def test_unsound_custom_zones_are_dropped(self):
        for bad in ([1, 1, 4, 8], [1, 2, 3], [0, 1, 2, 3], [1, 2, "x", 4], None):
            self.assertIsNone(_normalize_bigwig_settings({"custom_zones": bad})["custom_zones"], bad)

    def test_custom_zones_survive_other_edits(self):
        previous = {"data_type": "atac_seq", "zone_scale": "custom", "custom_zones": [1, 2, 3, 4]}
        settings = _normalize_bigwig_settings({"plot_color": "#123456", "use_default_plot_color": False}, previous=previous)
        self.assertEqual(settings["custom_zones"], [1.0, 2.0, 3.0, 4.0])
        self.assertEqual(settings["zone_scale"], "custom")


@unittest.skipIf(pyBigWig is None, "pyBigWig not installed")
class ZoneScaleEndpointTests(unittest.TestCase):
    def test_edges_come_from_the_files_own_peaks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "atac.bw"
            bw = pyBigWig.open(str(path), "w")
            bw.addHeader([("chr1", 5_000_000)])
            # A peak every 50 kb, heights cycling 1..9, plus one 5000 spike.
            starts = list(range(1000, 5_000_000, 50_000))
            values = [float(1 + (i % 9)) for i in range(len(starts))]
            values[10] = 5000.0
            bw.addEntries(["chr1"] * len(starts), starts, ends=[s + 200 for s in starts], values=values)
            bw.close()
            result = asyncio.run(browse_bigwig_zone_scale(str(path)))
        edges = result["thresholds"]
        self.assertEqual(len(edges), 4)
        self.assertTrue(all(b > a for a, b in zip(edges, edges[1:])))
        # Typical peaks (1-9) set the lower edges. With only ~100 peaks the spike is the
        # 99th percentile too, and the last edge is nudged just above it to stay increasing.
        self.assertTrue(1 <= edges[0] <= 9 and 1 <= edges[1] <= 9, edges)
        self.assertLessEqual(edges[-1], 5000.0 * 1.05 + 1e-9)
        self.assertEqual(result["max"], 5000.0)


    def test_several_files_share_one_scale_from_their_pooled_peaks(self):
        def write(path, height):
            bw = pyBigWig.open(str(path), "w")
            bw.addHeader([("chr1", 5_000_000)])
            starts = list(range(1000, 5_000_000, 50_000))
            bw.addEntries(["chr1"] * len(starts), starts, ends=[s + 200 for s in starts], values=[float(height)] * len(starts))
            bw.close()

        with tempfile.TemporaryDirectory() as tmp:
            low, high = Path(tmp) / "low.bw", Path(tmp) / "high.bw"
            write(low, 2)
            write(high, 10)
            own_low = asyncio.run(browse_bigwig_zone_scale(str(low)))["thresholds"]
            own_high = asyncio.run(browse_bigwig_zone_scale(str(high)))["thresholds"]
            shared = asyncio.run(browse_bigwig_zone_scale_shared(BigWigZoneScaleRequest(paths=[str(low), str(high)])))
            reversed_order = asyncio.run(browse_bigwig_zone_scale_shared(BigWigZoneScaleRequest(paths=[str(high), str(low)])))
        # Each file alone scales to itself, so the quiet one would look as strong as the
        # other. Together they share one scale reaching the stronger file's peaks, which is
        # what lets the two tracks be compared, and it does not depend on their order.
        self.assertLess(own_low[-1], 3)
        self.assertGreater(own_high[0], 9)
        self.assertEqual(shared["files"], 2)
        self.assertGreater(shared["thresholds"][-1], own_low[-1])
        self.assertGreaterEqual(shared["thresholds"][-1], 10.0)
        self.assertEqual(shared["thresholds"], reversed_order["thresholds"])
        self.assertEqual(shared["max"], 10.0)


if __name__ == "__main__":
    unittest.main()

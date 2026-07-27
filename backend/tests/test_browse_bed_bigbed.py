import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import browse_bed  # noqa: E402


class _FakeBigBed:
    def __init__(self):
        self.closed = False

    def chroms(self):
        return {"chr1": 1_000_000}

    def entries(self, chrom, start, end):
        if chrom != "chr1":
            return []
        if end <= 100 or start >= 260:
            return []
        return [
            (100, 180, "peakA\t42\t+\t100\t180\t255,0,0"),
            (220, 260, "peakB\t7\t-\t220\t260\t0,128,255"),
        ]

    def close(self):
        self.closed = True


class BrowseBedBigBedTests(unittest.TestCase):
    def test_bigbed_query_uses_binary_reader_and_returns_features(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bb_path = Path(tmpdir) / "test.bb"
            bb_path.write_bytes(b"BB")
            fake = _FakeBigBed()
            fake_module = SimpleNamespace(open=lambda _path: fake)

            with patch("main.pyBigWig", fake_module):
                payload = asyncio.run(
                    browse_bed(
                        genome="reference",
                        path=str(bb_path),
                        chrom="1",
                        start=0,
                        end=500,
                        level="fine",
                    )
                )

        self.assertTrue(payload["has_data"])
        self.assertEqual(payload["resolved_chrom"], "chr1")
        self.assertEqual(len(payload["features"]), 2)
        self.assertEqual(payload["features"][0]["name"], "peakA")
        self.assertEqual(payload["features"][0]["color"], "255,0,0")

    def test_bigbed_without_pybigwig_returns_clear_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bb_path = Path(tmpdir) / "missing_lib.bb"
            bb_path.write_bytes(b"BB")
            with patch("main.pyBigWig", None):
                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(
                        browse_bed(
                            genome="reference",
                            path=str(bb_path),
                            chrom="chr1",
                            start=0,
                            end=100,
                            level="fine",
                        )
                    )
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn("BigBed support is unavailable", str(ctx.exception.detail))


if __name__ == "__main__":
    unittest.main()

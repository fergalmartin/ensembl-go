import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import BigWigBatchRequest, BigWigBatchTile, browse_bigwig_batch  # noqa: E402


class _FakeBigWig:
    def __init__(self):
        self.stats_calls = []
        self.closed = False

    def chroms(self):
        return {"chr1": 1_000_000}

    def stats(self, chrom, start, end, type, nBins, exact):
        self.stats_calls.append((chrom, start, end, type, nBins, exact))
        return [float(index) for index in range(nBins)]

    def close(self):
        self.closed = True


class BigWigBatchEndpointTests(unittest.TestCase):
    def test_multiple_tiles_share_one_open_file_and_resolve_chrom_alias(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bigwig_path = Path(tmpdir) / "signal.bw"
            bigwig_path.write_bytes(b"BW")
            fake_bigwig = _FakeBigWig()
            open_calls = []

            def fake_open(path):
                open_calls.append(path)
                return fake_bigwig

            payload = BigWigBatchRequest(
                path=str(bigwig_path),
                chrom="1",
                genome="reference",
                tiles=[
                    BigWigBatchTile(start=0, end=500, bins=20),
                    BigWigBatchTile(start=500, end=1000, bins=25),
                ],
            )
            with (
                patch("main.pyBigWig", SimpleNamespace(open=fake_open)),
                patch("main._get_browse_db", return_value=object()),
                patch("main._get_browse_fasta", side_effect=RuntimeError("no fasta")),
            ):
                result = asyncio.run(browse_bigwig_batch(payload))

        self.assertEqual(result["resolved_chrom"], "chr1")
        self.assertEqual(len(result["tiles"]), 2)
        self.assertEqual(len(open_calls), 1)
        self.assertEqual(len(fake_bigwig.stats_calls), 2)
        self.assertEqual(len(result["tiles"][0]["bins"]), 20)
        self.assertEqual(len(result["tiles"][1]["bins"]), 25)
        self.assertTrue(fake_bigwig.closed)

    def test_tile_past_chromosome_end_keeps_its_bin_width(self):
        # Each value is the midpoint of the range it summarises, so a bin that covers the
        # wrong stretch of the chromosome shows up as the wrong number.
        class _MidpointBigWig(_FakeBigWig):
            def stats(self, chrom, start, end, type, nBins, exact):
                self.stats_calls.append((chrom, start, end, type, nBins, exact))
                width = (end - start) / nBins
                return [start + (index + 0.5) * width for index in range(nBins)]

        fake_bigwig = _MidpointBigWig()  # chr1 is 1,000,000 bp
        with tempfile.TemporaryDirectory() as tmpdir:
            bigwig_path = Path(tmpdir) / "signal.bw"
            bigwig_path.write_bytes(b"BW")
            payload = BigWigBatchRequest(
                path=str(bigwig_path),
                chrom="chr1",
                tiles=[BigWigBatchTile(start=995_000, end=1_005_000, bins=100)],  # 100 bp bins
            )
            with (
                patch("main.pyBigWig", SimpleNamespace(open=lambda _path: fake_bigwig)),
                patch("main._get_browse_db", return_value=object()),
                patch("main._get_browse_fasta", side_effect=RuntimeError("no fasta")),
            ):
                result = asyncio.run(browse_bigwig_batch(payload))

        bins = result["tiles"][0]["bins"]
        self.assertEqual(len(bins), 100)
        # The 50 bins before the end sit where the browser will draw them...
        for index in range(50):
            self.assertAlmostEqual(bins[index], 995_000 + index * 100 + 50)
        # ...and the 50 past it are empty rather than holding squeezed-in data.
        self.assertEqual(bins[50:], [None] * 50)

    def test_tile_ending_mid_bin_summarises_only_the_part_that_exists(self):
        fake_bigwig = _FakeBigWig()
        fake_bigwig.chroms = lambda: {"chr1": 1_000_050}
        with tempfile.TemporaryDirectory() as tmpdir:
            bigwig_path = Path(tmpdir) / "signal.bw"
            bigwig_path.write_bytes(b"BW")
            payload = BigWigBatchRequest(
                path=str(bigwig_path),
                chrom="chr1",
                tiles=[BigWigBatchTile(start=999_000, end=1_001_000, bins=20)],
            )
            with (
                patch("main.pyBigWig", SimpleNamespace(open=lambda _path: fake_bigwig)),
                patch("main._get_browse_db", return_value=object()),
                patch("main._get_browse_fasta", side_effect=RuntimeError("no fasta")),
            ):
                result = asyncio.run(browse_bigwig_batch(payload))

        queried = sorted((start, end, n_bins) for _c, start, end, _t, n_bins, _e in fake_bigwig.stats_calls)
        self.assertEqual(queried, [(999_000, 1_000_000, 10), (1_000_000, 1_000_050, 1)])
        bins = result["tiles"][0]["bins"]
        self.assertIsNotNone(bins[10])
        self.assertEqual(bins[11:], [None] * 9)


if __name__ == "__main__":
    unittest.main()

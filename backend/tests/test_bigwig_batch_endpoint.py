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


if __name__ == "__main__":
    unittest.main()

import random
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pysam  # noqa: E402

from main import ThreadSafeFasta, open_indexed_fasta  # noqa: E402

#: Large enough to span many BGZF blocks, which is what makes concurrent seeks
#: on a shared handle collide. A handful of short records never reproduces it.
SEQUENCE_LENGTH = 400_000
SEQUENCE_COUNT = 6
LINE_WIDTH = 60


def _build_fasta(directory: Path, bgzip: bool):
    """Write a multi-contig FASTA and return ``(path, {name: sequence})``."""
    random.seed(1234)
    sequences = {}
    plain = directory / "genome.fa"
    with open(plain, "w", encoding="utf-8") as handle:
        for index in range(SEQUENCE_COUNT):
            name = "contig_{0}".format(index)
            seq = "".join(random.choice("ACGT") for _ in range(SEQUENCE_LENGTH))
            sequences[name] = seq
            handle.write(">{0}\n".format(name))
            for offset in range(0, len(seq), LINE_WIDTH):
                handle.write(seq[offset:offset + LINE_WIDTH] + "\n")

    path = plain
    if bgzip:
        compressed = directory / "genome.fa.bgz"
        pysam.tabix_compress(str(plain), str(compressed), force=True)
        plain.unlink()
        path = compressed

    pysam.faidx(str(path))
    return path, sequences


class ThreadSafeFastaTests(unittest.TestCase):
    """Concurrent reads on one cached handle must stay correct.

    htslib keeps seek state on a FastaFile, so sharing an unguarded handle across
    the request threadpool corrupts reads — the failure mode is a blank sequence
    track and runs of N in Feature Explorer.
    """

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        directory = Path(cls._tmp.name) / "bgz"
        directory.mkdir(parents=True, exist_ok=True)
        cls.bgz_path, cls.sequences = _build_fasta(directory, True)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def _hammer(self, fasta, contig, expected, threads=48):
        errors = []
        mismatches = []

        def worker(index):
            start = (index * 997) % (SEQUENCE_LENGTH - 5000)
            end = start + 4000
            try:
                got = fasta.fetch(contig, start, end)
            except Exception as exc:  # noqa: BLE001 - recorded and asserted below
                errors.append("{0}: {1}".format(type(exc).__name__, exc))
                return
            if got.upper() != expected[start:end].upper():
                mismatches.append((start, end, len(got)))

        workers = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
        for thread in workers:
            thread.start()
        for thread in workers:
            thread.join()
        return errors, mismatches

    def test_bgzipped_fasta_survives_concurrent_fetches(self):
        fasta = open_indexed_fasta(str(self.bgz_path))
        self.addCleanup(fasta.close)
        contig = "contig_0"
        errors, mismatches = self._hammer(fasta, contig, self.sequences[contig])
        self.assertEqual(errors, [], "concurrent fetches raised")
        self.assertEqual(mismatches, [], "concurrent fetches returned wrong bases")

    def test_concurrent_fetches_across_contigs(self):
        fasta = open_indexed_fasta(str(self.bgz_path))
        self.addCleanup(fasta.close)
        errors = []
        mismatches = []

        def worker(index):
            contig = "contig_{0}".format(index % SEQUENCE_COUNT)
            start = (index * 5701) % (SEQUENCE_LENGTH - 3000)
            end = start + 2500
            try:
                got = fasta.fetch(contig, start, end)
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))
                return
            if got.upper() != self.sequences[contig][start:end].upper():
                mismatches.append((contig, start))

        workers = [threading.Thread(target=worker, args=(i,)) for i in range(60)]
        for thread in workers:
            thread.start()
        for thread in workers:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(mismatches, [])

    def test_metadata_accessors_are_wrapped(self):
        fasta = open_indexed_fasta(str(self.bgz_path))
        self.addCleanup(fasta.close)
        self.assertEqual(len(fasta.references), SEQUENCE_COUNT)
        self.assertEqual(
            fasta.get_reference_length("contig_0"), SEQUENCE_LENGTH
        )
        self.assertEqual(list(fasta.lengths), [SEQUENCE_LENGTH] * SEQUENCE_COUNT)

    def test_concurrent_metadata_and_fetch(self):
        # Feature Explorer interleaves region listing with sequence reads.
        fasta = open_indexed_fasta(str(self.bgz_path))
        self.addCleanup(fasta.close)
        errors = []

        def reader(index):
            try:
                if index % 3 == 0:
                    self.assertEqual(len(fasta.references), SEQUENCE_COUNT)
                else:
                    fasta.fetch("contig_1", index * 100, index * 100 + 900)
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))

        workers = [threading.Thread(target=reader, args=(i,)) for i in range(40)]
        for thread in workers:
            thread.start()
        for thread in workers:
            thread.join()
        self.assertEqual(errors, [])

    def test_wrapper_delegates_unknown_attributes(self):
        # `filename` is not wrapped explicitly, so it exercises __getattr__.
        fasta = open_indexed_fasta(str(self.bgz_path))
        self.addCleanup(fasta.close)
        name = fasta.filename
        if isinstance(name, bytes):
            name = name.decode()
        self.assertTrue(str(name).endswith(".bgz"))

    def test_open_indexed_fasta_returns_the_wrapper(self):
        fasta = open_indexed_fasta(str(self.bgz_path))
        self.addCleanup(fasta.close)
        self.assertIsInstance(fasta, ThreadSafeFasta)


class _OverlapDetector:
    """Stands in for a pysam handle and records concurrent entry.

    The real race lives in htslib's C code and only loses reliably on a large
    assembly, so a synthetic FASTA cannot be relied on to reproduce it. This
    asserts the property the fix actually provides — that two threads are never
    inside the underlying handle at once — without depending on timing luck.
    """

    def __init__(self):
        self.overlaps = 0
        self.calls = 0
        self._inside = 0
        self._guard = threading.Lock()

    def _enter(self):
        with self._guard:
            self.calls += 1
            self._inside += 1
            if self._inside > 1:
                self.overlaps += 1

    def _exit(self):
        with self._guard:
            self._inside -= 1

    def fetch(self, *args, **kwargs):
        self._enter()
        try:
            # Long enough that unserialised callers reliably overlap.
            threading.Event().wait(0.002)
            return "ACGT"
        finally:
            self._exit()

    @property
    def references(self):
        self._enter()
        try:
            threading.Event().wait(0.002)
            return ("contig_0",)
        finally:
            self._exit()

    def close(self):
        return None


def _hammer_handle(handle, threads=24):
    def worker(index):
        if index % 4 == 0:
            _ = handle.references
        else:
            handle.fetch("contig_0", index, index + 10)

    workers = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
    for thread in workers:
        thread.start()
    for thread in workers:
        thread.join()


class MutualExclusionTests(unittest.TestCase):
    def test_unwrapped_handle_overlaps(self):
        # Establishes that the detector can see overlap at all, so the wrapped
        # case below is a real result rather than a silent no-op.
        detector = _OverlapDetector()
        _hammer_handle(detector)
        self.assertEqual(detector.calls, 24)
        self.assertGreater(detector.overlaps, 0)

    def test_wrapper_serialises_every_access(self):
        detector = _OverlapDetector()
        _hammer_handle(ThreadSafeFasta(detector))
        self.assertEqual(detector.calls, 24)
        self.assertEqual(detector.overlaps, 0)

    def test_delegated_attributes_are_also_serialised(self):
        detector = _OverlapDetector()
        wrapped = ThreadSafeFasta(detector)

        def worker(_index):
            wrapped.fetch("contig_0", 0, 10)

        workers = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
        for thread in workers:
            thread.start()
        for thread in workers:
            thread.join()
        self.assertEqual(detector.overlaps, 0)


class PlainFastaConcurrencyTests(unittest.TestCase):
    def test_uncompressed_fasta_also_stays_correct(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path, sequences = _build_fasta(Path(tmp.name), False)

        fasta = open_indexed_fasta(str(path))
        self.addCleanup(fasta.close)

        errors = []
        mismatches = []

        def worker(index):
            start = (index * 1301) % (SEQUENCE_LENGTH - 4000)
            end = start + 3000
            try:
                got = fasta.fetch("contig_2", start, end)
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))
                return
            if got.upper() != sequences["contig_2"][start:end].upper():
                mismatches.append(start)

        workers = [threading.Thread(target=worker, args=(i,)) for i in range(40)]
        for thread in workers:
            thread.start()
        for thread in workers:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(mismatches, [])


if __name__ == "__main__":
    unittest.main()

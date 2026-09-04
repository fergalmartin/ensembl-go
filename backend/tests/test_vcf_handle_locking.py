import re
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pysam  # noqa: E402

import main  # noqa: E402
from main import locked_vcf  # noqa: E402

VCF_BODY = """##fileformat=VCFv4.2
##contig=<ID=chr1,length=100000>
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO
"""


def _write_vcf(directory: Path, name="test.vcf.gz", variants=400):
    plain = directory / "test.vcf"
    with open(plain, "w", encoding="utf-8") as handle:
        handle.write(VCF_BODY)
        for index in range(variants):
            pos = 100 + index * 37
            handle.write("chr1\t{0}\t.\tA\tG\t50\tPASS\t.\n".format(pos))

    compressed = directory / name
    pysam.tabix_compress(str(plain), str(compressed), force=True)
    plain.unlink()
    pysam.tabix_index(str(compressed), preset="vcf", force=True)
    return compressed


class LockedVcfTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.directory = Path(tmp.name)
        self.vcf = _write_vcf(self.directory)

    def test_yields_a_usable_handle(self):
        with locked_vcf(str(self.vcf)) as (handle, fingerprint, resolved):
            self.assertEqual(resolved, str(self.vcf.resolve()))
            self.assertTrue(fingerprint)
            records = list(handle.fetch("chr1", 0, 100000))
            self.assertEqual(len(records), 400)

    def test_handle_is_reused_between_calls(self):
        with locked_vcf(str(self.vcf)) as (first, _fp, _path):
            pass
        with locked_vcf(str(self.vcf)) as (second, _fp, _path):
            pass
        self.assertIs(first, second)

    def test_lock_is_released_after_the_block(self):
        with locked_vcf(str(self.vcf)) as (_handle, _fp, _path):
            pass
        # A second acquisition from another thread must not block.
        done = threading.Event()

        def worker():
            with locked_vcf(str(self.vcf)) as (_h, _f, _p):
                done.set()

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=5)
        self.assertTrue(done.is_set(), "lock was not released")

    def test_lock_is_released_when_the_body_raises(self):
        with self.assertRaises(RuntimeError):
            with locked_vcf(str(self.vcf)) as (_handle, _fp, _path):
                raise RuntimeError("boom")

        done = threading.Event()

        def worker():
            with locked_vcf(str(self.vcf)) as (_h, _f, _p):
                done.set()

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=5)
        self.assertTrue(done.is_set(), "lock leaked after an exception")

    def test_concurrent_readers_are_serialised(self):
        # The property that matters: two threads are never inside the handle at
        # once. VariantFile.fetch() is a lazy iterator, so the scan itself — not
        # just the fetch call — has to be covered.
        inside = {"now": 0, "max": 0}
        guard = threading.Lock()
        errors = []
        counts = []

        def worker(_index):
            try:
                with locked_vcf(str(self.vcf)) as (handle, _fp, _path):
                    with guard:
                        inside["now"] += 1
                        inside["max"] = max(inside["max"], inside["now"])
                    try:
                        counts.append(len(list(handle.fetch("chr1", 0, 100000))))
                    finally:
                        with guard:
                            inside["now"] -= 1
            except Exception as exc:  # noqa: BLE001
                errors.append("{0}: {1}".format(type(exc).__name__, exc))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(inside["max"], 1, "two threads held the handle at once")
        # Every reader saw the complete record set, not a truncated scan.
        self.assertEqual(set(counts), {400})

    def test_separate_files_do_not_block_each_other(self):
        other = _write_vcf(self.directory, name="other.vcf.gz", variants=10)
        first_held = threading.Event()
        second_done = threading.Event()

        def hold_first():
            with locked_vcf(str(self.vcf)) as (_h, _f, _p):
                first_held.set()
                second_done.wait(timeout=5)

        def use_second():
            first_held.wait(timeout=5)
            with locked_vcf(str(other)) as (handle, _f, _p):
                self.assertEqual(len(list(handle.fetch("chr1", 0, 100000))), 10)
            second_done.set()

        threads = [threading.Thread(target=hold_first), threading.Thread(target=use_second)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(second_done.is_set(), "a per-path lock blocked an unrelated VCF")

    def test_missing_file_raises_before_locking(self):
        from fastapi import HTTPException

        missing = self.directory / "nope.vcf.gz"
        with self.assertRaises(HTTPException) as ctx:
            with locked_vcf(str(missing)) as (_h, _f, _p):
                pass
        self.assertEqual(ctx.exception.status_code, 404)


class HandleAccessDisciplineTests(unittest.TestCase):
    """The cached handle must only be reachable through the locking helper."""

    @staticmethod
    def _enclosing_def(source, index):
        """Name of the top-level def containing ``source[index]``."""
        for cursor in range(index, -1, -1):
            match = re.match(r"^(?:async )?def (\w+)", source[cursor])
            if match:
                return match.group(1)
        return ""

    def test_no_caller_bypasses_the_context_manager(self):
        source = Path(main.__file__).read_text(encoding="utf-8").split("\n")
        uses = [
            (index, line.strip())
            for index, line in enumerate(source)
            if "_open_vcf_handle_unlocked(" in line
            and not line.strip().startswith("def ")
        ]
        self.assertTrue(uses, "the helper vanished; this guard needs updating")

        # The only permitted use is inside locked_vcf itself.
        for index, text in uses:
            self.assertEqual(
                self._enclosing_def(source, index),
                "locked_vcf",
                "line {0} reaches the VCF handle without locked_vcf: {1}".format(
                    index + 1, text
                ),
            )

    def test_every_vcf_scan_runs_under_the_context_manager(self):
        # Functions that consume a handle are only ever called from inside a
        # `with locked_vcf(...)` block; this asserts the entry points still are.
        source = Path(main.__file__).read_text(encoding="utf-8").split("\n")
        entry_points = {
            self._enclosing_def(source, index)
            for index, line in enumerate(source)
            if "locked_vcf(" in line and "with " in line
        }
        self.assertEqual(
            entry_points,
            {
                "_browse_vcf_block_tiles_sync",
                "_browse_vcf_tiles_sync",
                # The structure panel's variant overlay. It fetches once per
                # coding exon of one transcript, all inside the same `with`, so
                # the lock is held for a bounded scan like the tile builders.
                "_structure_variants_for_track",
            },
            "a new VCF entry point appeared; confirm it holds the handle lock",
        )

    def test_variant_file_is_only_constructed_in_one_place(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertEqual(
            len(re.findall(r"pysam\.VariantFile\(", source)),
            1,
            "a second VariantFile construction would bypass the shared cache and its lock",
        )


if __name__ == "__main__":
    unittest.main()

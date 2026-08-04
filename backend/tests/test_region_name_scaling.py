"""Region-name resolution has to stay linear in the size of the assembly.

A scaffold-level genome has hundreds of thousands of sequences. Resolving a name
used to scan all of them per lookup, and building a synonym index performs a
lookup per alias, so /api/browse/regions never returned: the browser sat on
"Building Index" waiting for it, and each poll that followed took another
request thread until the backend had none left for anything else.

The timings here are deliberately generous — they are there to catch a return to
quadratic behaviour, not to pin down a particular speed.
"""

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from assembly_report import (  # noqa: E402
    AssemblyReportRow,
    KnownRegions,
    build_synonym_index,
    resolve_region_name,
)


def _scaffold_rows(count, start=0):
    """Rows shaped like an NCBI report for an unplaced-scaffold assembly."""
    return [
        AssemblyReportRow(
            row_index=start + i,
            sequence_name=f"scaffold_{start + i}",
            assigned_molecule="na",
            genbank_accession=f"PVKX{start + i:08d}.1",
            refseq_accession="na",
            ucsc_style_name="na",
            sequence_role="unplaced-scaffold",
        )
        for i in range(count)
    ]


def _scaffold_names(count, start=0):
    return [f"PVKX{start + i:08d}.1" for i in range(count)]


class RegionNameScalingTests(unittest.TestCase):
    def test_building_a_synonym_index_scales_linearly(self):
        small = 2_000
        large = 20_000

        def build(count):
            rows = _scaffold_rows(count)
            known = _scaffold_names(count)
            started = time.perf_counter()
            build_synonym_index(rows, known)
            return time.perf_counter() - started

        build(200)  # warm any import-time work out of the measurement
        small_seconds = max(build(small), 1e-4)
        large_seconds = build(large)

        # Ten times the input must not cost anything like a hundred times the
        # work. Quadratic behaviour lands near 100x; linear lands near 10x.
        self.assertLess(
            large_seconds / small_seconds,
            30,
            f"{small} rows took {small_seconds:.3f}s but {large} took {large_seconds:.3f}s",
        )

    def test_a_large_assembly_is_indexed_in_reasonable_time(self):
        rows = _scaffold_rows(50_000)
        known = _scaffold_names(50_000)
        started = time.perf_counter()
        build_synonym_index(rows, known)
        self.assertLess(time.perf_counter() - started, 20)

    def test_a_prepared_lookup_is_reusable_across_resolutions(self):
        known = KnownRegions(_scaffold_names(50_000))
        started = time.perf_counter()
        for i in range(0, 50_000, 500):
            self.assertEqual(
                resolve_region_name(f"PVKX{i:08d}.1", known),
                f"PVKX{i:08d}.1",
            )
        self.assertLess(time.perf_counter() - started, 2)

    def test_resolution_still_answers_the_cases_it_always_did(self):
        known = KnownRegions(["1", "MT", "GL000001.1"])
        self.assertEqual(resolve_region_name("1", known), "1")
        self.assertEqual(resolve_region_name("chr1", known), "1")
        self.assertEqual(resolve_region_name("chrM", known), "MT")
        self.assertEqual(resolve_region_name("gl000001.1", known), "GL000001.1")
        self.assertIsNone(resolve_region_name("nope", known))
        self.assertIsNone(resolve_region_name("", known))
        self.assertIsNone(resolve_region_name("1", KnownRegions([])))

    def test_a_prepared_lookup_and_a_plain_list_agree(self):
        names = ["1", "MT", "GL000001.1"]
        for query in ("1", "chr1", "chrM", "gl000001.1", "nope"):
            self.assertEqual(
                resolve_region_name(query, names),
                resolve_region_name(query, KnownRegions(names)),
                query,
            )

    def test_an_ambiguous_lowercase_match_stays_unresolved(self):
        # Two regions differing only in case cannot be told apart, and guessing
        # one would silently browse the wrong sequence.
        known = KnownRegions(["ctg1", "CTG1"])
        self.assertIsNone(resolve_region_name("Ctg1", known))


if __name__ == "__main__":
    unittest.main()

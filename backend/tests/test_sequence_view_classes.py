import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sequence_view.classes import (  # noqa: E402
    FEATURE_PRIORITY,
    base_class_in_transcript,
    cds_frame_from_segments,
    gene_overlap_spans,
    gene_union_classes,
    location_classes,
    location_gene_classes,
    merge_runs,
    transcript_classes,
)


def interval(kind, start, end):
    return {"type": kind, "start": start, "end": end}


# A two-exon coding transcript on the plus strand, with the codons and splice
# sites _build_tx_feature_intervals would have verified against the sequence.
TWO_EXON = [
    interval("exon", 101, 120),
    interval("exon", 131, 150),
    interval("intron", 121, 130),
    interval("cds", 111, 120),
    interval("cds", 131, 140),
    interval("utr5", 101, 110),
    interval("utr3", 141, 150),
    interval("start_codon", 111, 113),
    interval("stop_codon", 138, 140),
    interval("donor", 121, 122),
    interval("acceptor", 129, 130),
]


class TranscriptClassesTest(unittest.TestCase):
    def test_runs_tile_the_window_without_gap_or_overlap(self):
        runs = transcript_classes(TWO_EXON, 101, 150)
        self.assertEqual(runs[0]["s"], 101)
        self.assertEqual(runs[-1]["e"], 150)
        for earlier, later in zip(runs, runs[1:]):
            self.assertEqual(later["s"], earlier["e"] + 1)

    def test_higher_priority_features_are_drawn_over_lower_ones(self):
        runs = {(r["s"], r["e"]): r["c"] for r in transcript_classes(TWO_EXON, 101, 150)}
        # A start codon sits inside the CDS and must still be visible.
        self.assertEqual(runs[(111, 113)], "start_codon")
        self.assertEqual(runs[(114, 120)], "cds")
        # Splice sites are drawn over the intron they bound.
        self.assertEqual(runs[(121, 122)], "donor")
        self.assertEqual(runs[(129, 130)], "acceptor")
        self.assertEqual(runs[(123, 128)], "intron")
        # A stop codon over the end of the CDS.
        self.assertEqual(runs[(138, 140)], "stop_codon")

    def test_the_priority_order_is_the_one_the_feature_explorer_paints(self):
        self.assertEqual(
            FEATURE_PRIORITY,
            ("start_codon", "stop_codon", "donor", "acceptor", "utr5", "utr3", "cds", "exon", "intron"),
        )

    def test_an_exon_that_is_neither_coding_nor_utr_is_named_non_coding(self):
        # The whole of a lncRNA. Left as "exon" it would reach the client as a
        # class it has no colour for, and the transcript would render blank.
        lnc = [interval("exon", 10, 20), interval("exon", 31, 40), interval("intron", 21, 30)]
        runs = transcript_classes(lnc, 10, 40)
        self.assertEqual(
            runs,
            [
                {"s": 10, "e": 20, "c": "noncoding"},
                {"s": 21, "e": 30, "c": "intron"},
                {"s": 31, "e": 40, "c": "noncoding"},
            ],
        )

    def test_the_window_clips_rather_than_the_features(self):
        runs = transcript_classes(TWO_EXON, 118, 124)
        self.assertEqual(runs[0]["s"], 118)
        self.assertEqual(runs[-1]["e"], 124)
        self.assertEqual({r["c"] for r in runs}, {"cds", "intron", "donor"})

    def test_an_unknown_feature_type_is_ignored_rather_than_emitted(self):
        runs = transcript_classes([interval("chromosome", 1, 100)], 1, 100)
        self.assertEqual(runs, [])


class CdsFrameTest(unittest.TestCase):
    def test_offsets_come_from_spliced_coding_space(self):
        # What _build_mode_segments(..., "cds") returns for a plus-strand CDS
        # split by an intron: coord_start counts from the 5' end, spliced.
        segments = [
            {"coord_start": 1, "coord_end": 10, "genomic_start": 111, "genomic_end": 120},
            {"coord_start": 11, "coord_end": 20, "genomic_start": 131, "genomic_end": 140},
        ]
        self.assertEqual(
            cds_frame_from_segments(segments),
            [{"s": 111, "e": 120, "o": 0}, {"s": 131, "e": 140, "o": 10}],
        )

    def test_a_minus_strand_frame_is_still_sorted_by_coordinate(self):
        # 5' to 3' runs the other way, so the segments arrive descending. The
        # client binary searches this list, so it must come back ascending, with
        # the offsets carrying the direction instead.
        segments = [
            {"coord_start": 1, "coord_end": 10, "genomic_start": 131, "genomic_end": 140},
            {"coord_start": 11, "coord_end": 20, "genomic_start": 111, "genomic_end": 120},
        ]
        frame = cds_frame_from_segments(segments)
        self.assertEqual(frame, [{"s": 111, "e": 120, "o": 10}, {"s": 131, "e": 140, "o": 0}])
        self.assertEqual([s["s"] for s in frame], sorted(s["s"] for s in frame))

    def test_a_codon_spanning_a_splice_junction_keeps_one_parity(self):
        # The point of carrying an offset per segment rather than one anchor:
        # counting genomic bases from the start codon would drift by the length
        # of the intron, and every codon after it would be shaded wrongly.
        frame = cds_frame_from_segments([
            {"coord_start": 1, "coord_end": 10, "genomic_start": 111, "genomic_end": 120},
            {"coord_start": 11, "coord_end": 20, "genomic_start": 131, "genomic_end": 140},
        ])

        def parity(coord):
            for segment in frame:
                if segment["s"] <= coord <= segment["e"]:
                    return ((segment["o"] + (coord - segment["s"])) // 3) % 2
            return None

        # Spliced offsets 9, 10 and 11 are one codon: genomic 120, 131 and 132.
        self.assertEqual(parity(120), parity(131))
        self.assertEqual(parity(131), parity(132))
        self.assertNotEqual(parity(132), parity(133))

    def test_a_malformed_segment_is_dropped(self):
        self.assertEqual(cds_frame_from_segments([{"coord_start": 0}]), [])
        self.assertEqual(cds_frame_from_segments([]), [])


class GeneUnionTest(unittest.TestCase):
    # One coding isoform, and a shorter non-coding one that starts later.
    CODING = {
        "exons": [{"start": 101, "end": 120}, {"start": 131, "end": 150}],
        "cds_list": [{"start": 111, "end": 120}, {"start": 131, "end": 140}],
        "utrs": [{"start": 101, "end": 110}, {"start": 141, "end": 150}],
    }
    SHORT = {
        "exons": [{"start": 111, "end": 120}, {"start": 131, "end": 150}],
        "cds_list": [],
        "utrs": [],
    }

    def test_one_isoform_alone_never_disagrees_with_itself(self):
        runs = gene_union_classes([self.CODING], 101, 150, 101, 150)
        self.assertEqual(
            runs,
            [
                {"s": 101, "e": 110, "c": "utr"},
                {"s": 111, "e": 120, "c": "coding"},
                {"s": 121, "e": 130, "c": "intron"},
                {"s": 131, "e": 140, "c": "coding"},
                {"s": 141, "e": 150, "c": "utr"},
            ],
        )

    def test_isoforms_that_disagree_make_a_base_mixed(self):
        runs = {(r["s"], r["e"]): r["c"] for r in gene_union_classes([self.CODING, self.SHORT], 101, 150, 101, 150)}
        # Coding in one isoform, exonic non-coding in the other.
        self.assertEqual(runs[(111, 120)], "mixed")
        # Both call it intronic, so it is not mixed.
        self.assertEqual(runs[(121, 130)], "intron")
        # Only the long isoform reaches here, so its vote stands unopposed.
        self.assertEqual(runs[(101, 110)], "utr")

    def test_an_isoform_that_does_not_cover_a_base_does_not_vote(self):
        # The rule that keeps "mixed" worth reading. Without it, 101-110 would be
        # mixed purely because the short isoform has not started yet, and the 5'
        # end of every gene with one short isoform would be mixed throughout.
        runs = {(r["s"], r["e"]): r["c"] for r in gene_union_classes([self.CODING, self.SHORT], 101, 150, 101, 150)}
        self.assertEqual(runs[(101, 110)], "utr")
        self.assertNotIn("mixed", [runs[key] for key in runs if key[1] <= 110])

    def test_a_base_inside_the_gene_but_outside_every_transcript_is_intronic(self):
        runs = gene_union_classes([self.CODING], 101, 200, 101, 200)
        self.assertEqual(runs[-1], {"s": 151, "e": 200, "c": "intron"})

    def test_flanking_sequence_gets_no_class_at_all(self):
        # The reader's flank is outside the gene, so describing it as intronic
        # would be wrong. It comes back as a gap in the runs and renders plain.
        runs = gene_union_classes([self.CODING], 51, 200, gene_start=101, gene_end=150)
        self.assertEqual(runs[0]["s"], 101)
        self.assertEqual(runs[-1]["e"], 150)

    def test_a_gene_with_no_transcripts_is_intronic_throughout(self):
        self.assertEqual(gene_union_classes([], 1, 50), [{"s": 1, "e": 50, "c": "intron"}])

    def test_a_transcript_with_no_exons_is_ignored(self):
        self.assertEqual(
            gene_union_classes([{"exons": [], "cds_list": [], "utrs": []}], 1, 10),
            [{"s": 1, "e": 10, "c": "intron"}],
        )

    def test_three_isoforms_agreeing_are_not_mixed(self):
        same = dict(self.CODING)
        runs = gene_union_classes([self.CODING, same, dict(self.CODING)], 101, 150, 101, 150)
        self.assertNotIn("mixed", {r["c"] for r in runs})

    def test_a_large_gene_with_many_isoforms_is_answered_by_sweeping(self):
        # Two and a half megabases, eighty isoforms. Walking bases would be a
        # quarter of a billion steps; this has to stay proportional to the
        # number of exon boundaries instead.
        isoforms = []
        for offset in range(80):
            exons = [{"start": 1 + i * 30_000 + offset, "end": 1 + i * 30_000 + offset + 999} for i in range(80)]
            isoforms.append({"exons": exons, "cds_list": exons[1:-1], "utrs": []})
        runs = gene_union_classes(isoforms, 1, 2_500_000, 1, 2_500_000)
        self.assertGreater(len(runs), 100)
        self.assertEqual(runs[0]["s"], 1)
        self.assertEqual(runs[-1]["e"], 2_500_000)


class LocationClassesTest(unittest.TestCase):
    def test_a_window_is_covered_end_to_end(self):
        runs = location_classes([{"start": 120, "end": 200}], 1, 300)
        self.assertEqual(
            runs,
            [
                {"s": 1, "e": 119, "c": "intergenic"},
                {"s": 120, "e": 200, "c": "genic"},
                {"s": 201, "e": 300, "c": "intergenic"},
            ],
        )

    def test_overlapping_genes_are_one_genic_run(self):
        # At this altitude the question is whether a base is in a gene at all.
        # Which gene, and where its edges fall, is the feature list's job.
        runs = location_classes([{"start": 120, "end": 200}, {"start": 150, "end": 260}], 1, 300)
        self.assertEqual(runs[1], {"s": 120, "e": 260, "c": "genic"})

    def test_a_nested_gene_does_not_split_its_host(self):
        runs = location_classes([{"start": 100, "end": 400}, {"start": 200, "end": 250}], 1, 500)
        self.assertEqual(runs[1], {"s": 100, "e": 400, "c": "genic"})

    def test_a_gene_reaching_past_the_window_is_clipped(self):
        runs = location_classes([{"start": 1, "end": 10_000}], 500, 600)
        self.assertEqual(runs, [{"s": 500, "e": 600, "c": "genic"}])

    def test_an_empty_region_is_all_intergenic(self):
        self.assertEqual(location_classes([], 1, 50), [{"s": 1, "e": 50, "c": "intergenic"}])


class LocationGeneClassesTest(unittest.TestCase):
    """A location drawn in the classes a gene is drawn in."""

    # One coding gene, and a non-coding gene lying across its 3' end.
    CODING_GENE = {
        "start": 101, "end": 150,
        "transcripts": [{
            "exons": [{"start": 101, "end": 120}, {"start": 131, "end": 150}],
            "cds_list": [{"start": 111, "end": 120}, {"start": 131, "end": 140}],
            "utrs": [{"start": 101, "end": 110}, {"start": 141, "end": 150}],
        }],
    }
    ANTISENSE = {
        "start": 131, "end": 200,
        "transcripts": [{"exons": [{"start": 131, "end": 200}], "cds_list": [], "utrs": []}],
    }

    def runs(self, genes, start=1, end=300):
        return {(r["s"], r["e"]): r["c"] for r in location_gene_classes(genes, start, end)}

    def test_a_lone_gene_reads_exactly_as_it_would_at_gene_level(self):
        at_location = location_gene_classes([self.CODING_GENE], 101, 150)
        at_gene = gene_union_classes(self.CODING_GENE["transcripts"], 101, 150, 101, 150)
        self.assertEqual(at_location, at_gene)

    def test_bases_no_gene_sits_on_are_intergenic(self):
        runs = self.runs([self.CODING_GENE])
        self.assertEqual(runs[(1, 100)], "intergenic")
        self.assertEqual(runs[(151, 300)], "intergenic")

    def test_a_window_is_covered_end_to_end(self):
        runs = location_gene_classes([self.CODING_GENE, self.ANTISENSE], 1, 300)
        self.assertEqual(runs[0]["s"], 1)
        self.assertEqual(runs[-1]["e"], 300)
        for earlier, later in zip(runs, runs[1:]):
            self.assertEqual(later["s"], earlier["e"] + 1, "no gap and no overlap")

    def test_genes_disagreeing_about_a_base_make_it_mixed(self):
        runs = self.runs([self.CODING_GENE, self.ANTISENSE])
        # 131-140 is coding to one gene and exonic non-coding to the other;
        # 141-150 is UTR to one and non-coding to the other. Both are
        # disagreements, so the whole overlap comes back as one mixed run.
        self.assertEqual(runs[(131, 150)], "mixed")

    def test_genes_agreeing_about_a_base_keep_that_class(self):
        # An overlap is not a disagreement. Two genes whose exons are both
        # non-coding here say the same thing, so the base keeps it.
        other = {
            "start": 131, "end": 145,
            "transcripts": [{"exons": [{"start": 131, "end": 145}], "cds_list": [], "utrs": []}],
        }
        runs = self.runs([self.ANTISENSE, other])
        self.assertEqual(runs[(131, 200)], "noncoding")

    def test_a_gene_with_no_isoforms_is_intronic_over_its_own_span(self):
        # Which is what the annotation says about it: it is inside a gene, and
        # no transcript claims it.
        runs = self.runs([{"start": 400, "end": 420, "transcripts": []}], 300, 500)
        self.assertEqual(runs[(400, 420)], "intron")
        self.assertEqual(runs[(300, 399)], "intergenic")

    def test_a_gene_is_clipped_to_the_tile_it_is_asked_about(self):
        runs = location_gene_classes([self.ANTISENSE], 150, 170)
        self.assertEqual(runs[0]["s"], 150)
        self.assertEqual(runs[-1]["e"], 170)

    def test_an_intron_stays_inside_its_own_gene(self):
        # The rule that bases no isoform covers are intronic holds only within
        # the gene. Between two genes they are intergenic, not one long intron.
        runs = self.runs([self.CODING_GENE, {"start": 250, "end": 260, "transcripts": []}])
        self.assertEqual(runs[(151, 249)], "intergenic")


class GeneOverlapSpansTest(unittest.TestCase):
    def test_genes_apart_never_overlap(self):
        spans = gene_overlap_spans(
            [{"start": 10, "end": 20}, {"start": 30, "end": 40}], 1, 100)
        self.assertEqual(spans, [])

    def test_two_genes_on_one_base_are_reported_once(self):
        spans = gene_overlap_spans(
            [{"start": 10, "end": 30}, {"start": 20, "end": 40}], 1, 100)
        self.assertEqual(spans, [{"s": 20, "e": 30, "n": 2}])

    def test_the_count_is_how_many_genes_claim_the_base(self):
        spans = gene_overlap_spans(
            [{"start": 1, "end": 100}, {"start": 10, "end": 90}, {"start": 20, "end": 30}],
            1, 100,
        )
        self.assertEqual(
            spans,
            [{"s": 10, "e": 19, "n": 2}, {"s": 20, "e": 30, "n": 3}, {"s": 31, "e": 90, "n": 2}],
        )

    def test_a_nested_gene_overlaps_its_host_for_its_whole_length(self):
        spans = gene_overlap_spans(
            [{"start": 1, "end": 1000}, {"start": 400, "end": 500}], 1, 1000)
        self.assertEqual(spans, [{"s": 400, "e": 500, "n": 2}])

    def test_overlap_outside_the_tile_is_not_reported_inside_it(self):
        spans = gene_overlap_spans(
            [{"start": 1, "end": 100}, {"start": 50, "end": 60}], 200, 300)
        self.assertEqual(spans, [])

    def test_a_gene_reaching_in_from_outside_still_counts(self):
        spans = gene_overlap_spans(
            [{"start": 1, "end": 250}, {"start": 200, "end": 400}], 100, 300)
        self.assertEqual(spans, [{"s": 200, "e": 250, "n": 2}])


class BaseInTranscriptTest(unittest.TestCase):
    """What one isoform says about one base, for the box a click opens."""

    PLUS = {
        "strand": "+",
        "exons": [{"start": 101, "end": 120}, {"start": 131, "end": 150}],
        "cds_list": [{"start": 111, "end": 120}, {"start": 131, "end": 140}],
        "utrs": [{"start": 101, "end": 110}, {"start": 141, "end": 150}],
    }

    def test_each_part_of_a_transcript_is_named(self):
        said = {c: base_class_in_transcript(self.PLUS, c) for c in (105, 115, 125, 135, 145)}
        self.assertEqual(said, {
            105: "utr5", 115: "coding", 125: "intron", 135: "coding", 145: "utr3",
        })

    def test_a_transcript_says_nothing_about_a_base_outside_it(self):
        # The rule that keeps "mixed" meaningful, and the box honest: an isoform
        # that does not cover a base must not appear in the list explaining it.
        self.assertIsNone(base_class_in_transcript(self.PLUS, 100))
        self.assertIsNone(base_class_in_transcript(self.PLUS, 151))
        self.assertIsNone(base_class_in_transcript({"exons": []}, 115))

    def test_five_and_three_prime_are_by_reading_order_not_by_position(self):
        minus = dict(self.PLUS, strand="-")
        self.assertEqual(base_class_in_transcript(minus, 105), "utr3")
        self.assertEqual(base_class_in_transcript(minus, 145), "utr5")

    def test_an_exon_of_a_transcript_with_no_cds_is_non_coding(self):
        lnc = {"strand": "+", "exons": [{"start": 1, "end": 50}], "cds_list": [], "utrs": []}
        self.assertEqual(base_class_in_transcript(lnc, 25), "noncoding")

    def test_an_untranslated_region_with_nothing_to_translate_is_non_coding(self):
        odd = {"strand": "+", "exons": [{"start": 1, "end": 50}], "cds_list": [],
               "utrs": [{"start": 1, "end": 50}]}
        self.assertEqual(base_class_in_transcript(odd, 25), "noncoding")

    def test_it_agrees_with_the_gene_level_answer_for_a_lone_isoform(self):
        # One isoform cannot disagree with itself, so the gene's answer is its
        # answer -- with the UTRs merged, which is the only difference between
        # what a gene says and what a transcript says.
        for coord in (105, 115, 125, 135, 145):
            runs = gene_union_classes([self.PLUS], coord, coord, 101, 150)
            said = base_class_in_transcript(self.PLUS, coord)
            self.assertEqual(runs[0]["c"], "utr" if said.startswith("utr") else said, coord)


class MergeRunsTest(unittest.TestCase):
    def test_touching_runs_of_one_class_become_one(self):
        self.assertEqual(
            merge_runs([{"s": 1, "e": 5, "c": "cds"}, {"s": 6, "e": 9, "c": "cds"}]),
            [{"s": 1, "e": 9, "c": "cds"}],
        )

    def test_a_gap_keeps_them_apart(self):
        merged = merge_runs([{"s": 1, "e": 5, "c": "cds"}, {"s": 7, "e": 9, "c": "cds"}])
        self.assertEqual(len(merged), 2)

    def test_different_classes_stay_apart(self):
        merged = merge_runs([{"s": 1, "e": 5, "c": "cds"}, {"s": 6, "e": 9, "c": "intron"}])
        self.assertEqual(len(merged), 2)


if __name__ == "__main__":
    unittest.main()

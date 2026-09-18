import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sequence_view.spans import (  # noqa: E402
    MAX_INTRON_COLLAPSE_GENES,
    clip_spans,
    exon_spans,
    exon_union,
    gene_spans,
    merge_spans,
    spans_for_level,
)


def exon(start, end):
    return {"start": start, "end": end}


def transcript(*exons):
    # A transcript's own extent is its outermost exons, which is what the
    # database holds and what its genic span is taken from.
    starts = [start for start, _ in exons]
    ends = [end for _, end in exons]
    return {
        "start": min(starts) if starts else 0,
        "end": max(ends) if ends else 0,
        "exons": [exon(start, end) for start, end in exons],
    }


class MergeSpansTest(unittest.TestCase):
    def test_overlapping_spans_become_one(self):
        self.assertEqual(
            merge_spans([{"s": 10, "e": 20}, {"s": 15, "e": 30}]),
            [{"s": 10, "e": 30}],
        )

    def test_touching_spans_become_one(self):
        # There is no gap between 20 and 21 to collapse, so keeping them apart
        # would invent one and put a marker over nothing.
        self.assertEqual(
            merge_spans([{"s": 10, "e": 20}, {"s": 21, "e": 30}]),
            [{"s": 10, "e": 30}],
        )

    def test_a_single_base_between_them_is_left_alone(self):
        self.assertEqual(
            merge_spans([{"s": 10, "e": 20}, {"s": 22, "e": 30}]),
            [{"s": 10, "e": 20}, {"s": 22, "e": 30}],
        )

    def test_spans_come_back_in_order_however_they_went_in(self):
        self.assertEqual(
            merge_spans([{"s": 100, "e": 110}, {"s": 1, "e": 5}]),
            [{"s": 1, "e": 5}, {"s": 100, "e": 110}],
        )

    def test_reversed_and_malformed_spans_survive(self):
        self.assertEqual(merge_spans([{"s": 20, "e": 10}]), [{"s": 10, "e": 20}])
        self.assertEqual(merge_spans([{"s": None, "e": 10}, None]), [])
        self.assertEqual(merge_spans([]), [])

    def test_pairs_are_accepted_as_well_as_dicts(self):
        self.assertEqual(merge_spans([(10, 20), (15, 30)]), [{"s": 10, "e": 30}])


class ClipSpansTest(unittest.TestCase):
    def test_only_the_parts_inside_the_window_survive(self):
        spans = [{"s": 1, "e": 50}, {"s": 100, "e": 200}, {"s": 500, "e": 600}]
        self.assertEqual(
            clip_spans(spans, 40, 550),
            [{"s": 40, "e": 50}, {"s": 100, "e": 200}, {"s": 500, "e": 550}],
        )

    def test_a_span_entirely_outside_is_dropped(self):
        self.assertEqual(clip_spans([{"s": 1, "e": 10}], 100, 200), [])


class ExonUnionTest(unittest.TestCase):
    def test_one_transcript_keeps_its_own_exons(self):
        self.assertEqual(
            exon_spans(transcript((101, 120), (201, 220))),
            [{"s": 101, "e": 120}, {"s": 201, "e": 220}],
        )

    def test_a_base_exonic_in_any_isoform_is_kept(self):
        # The second isoform's first exon extends past the first isoform's, and
        # its intron covers bases the first isoform transcribes. Both are kept:
        # a base that is exon in one transcript and intron in another is exactly
        # the kind someone collapsing introns still wants to see.
        union = exon_union([
            transcript((101, 120), (201, 220)),
            transcript((101, 150), (301, 320)),
        ])
        self.assertEqual(
            union,
            [{"s": 101, "e": 150}, {"s": 201, "e": 220}, {"s": 301, "e": 320}],
        )

    def test_no_transcripts_keeps_nothing(self):
        self.assertEqual(exon_union([]), [])


class GeneSpansTest(unittest.TestCase):
    def test_genes_merge_so_the_gaps_between_them_are_intergenic(self):
        rows = [
            {"start": 100, "end": 200},
            {"start": 150, "end": 260},
            {"start": 1000, "end": 1200},
        ]
        self.assertEqual(
            gene_spans(rows),
            [{"s": 100, "e": 260}, {"s": 1000, "e": 1200}],
        )


class SpansForLevelTest(unittest.TestCase):
    """The two lists, and what the client can subtract out of them.

    Nothing here collapses anything. What comes back is where the genes are and
    where their exons are; intergenic is the region minus the first and intronic
    is the first minus the second, and both of those subtractions -- with their
    flanks and their floors -- are the client's.
    """

    def test_a_transcript_answers_with_itself_and_its_exons(self):
        answer = spans_for_level(
            "transcript",
            window=(1, 1000),
            transcripts=[transcript((101, 120), (201, 220))],
        )
        self.assertEqual(answer["genic"], [{"s": 101, "e": 220}])
        self.assertEqual(answer["exonic"], [{"s": 101, "e": 120}, {"s": 201, "e": 220}])
        self.assertEqual(answer["offers"], ["intergenic", "intron"])

    def test_a_feature_is_answered_exactly_as_a_transcript_is(self):
        arguments = dict(window=(1, 1000), transcripts=[transcript((101, 120), (201, 220))])
        self.assertEqual(
            spans_for_level("feature", **arguments),
            spans_for_level("transcript", **arguments),
        )

    def test_a_gene_answers_with_its_own_span_and_the_union_of_its_isoforms(self):
        answer = spans_for_level(
            "gene",
            window=(1, 1000),
            genes=[{"start": 90, "end": 240}],
            transcripts=[
                transcript((101, 120), (201, 220)),
                transcript((101, 150)),
            ],
        )
        # The gene's own span, not the transcripts': the sequence between the
        # gene's edge and its first exon is intronic, and the flank outside it
        # is not.
        self.assertEqual(answer["genic"], [{"s": 90, "e": 240}])
        self.assertEqual(answer["exonic"], [{"s": 101, "e": 150}, {"s": 201, "e": 220}])

    def test_a_window_clips_both_lists(self):
        answer = spans_for_level(
            "transcript",
            window=(110, 210),
            transcripts=[transcript((101, 120), (201, 220))],
        )
        self.assertEqual(answer["genic"], [{"s": 110, "e": 210}])
        self.assertEqual(answer["exonic"], [{"s": 110, "e": 120}, {"s": 201, "e": 210}])

    def test_a_quiet_location_answers_with_genes_and_their_exons(self):
        answer = spans_for_level(
            "location",
            window=(1, 10_000),
            genes=[{"start": 100, "end": 5000}],
            gene_transcripts=[transcript((100, 200), (4900, 5000))],
            gene_count=1,
        )
        self.assertEqual(answer["genic"], [{"s": 100, "e": 5000}])
        self.assertEqual(answer["exonic"], [{"s": 100, "e": 200}, {"s": 4900, "e": 5000}])
        self.assertEqual(answer["offers"], ["intergenic", "intron"])

    def test_a_crowded_location_has_no_exons_to_offer_and_says_so(self):
        # Over the limit the isoforms are never read. `exonic` is None rather
        # than empty: nothing is exonic here and nobody asked are opposite
        # answers, and the first would make every base of every gene collapsible
        # as an intron.
        answer = spans_for_level(
            "location",
            window=(1, 10_000),
            genes=[{"start": 100, "end": 5000}],
            gene_transcripts=None,
            gene_count=MAX_INTRON_COLLAPSE_GENES + 1,
        )
        self.assertEqual(answer["genic"], [{"s": 100, "e": 5000}])
        self.assertIsNone(answer["exonic"])
        self.assertEqual(answer["offers"], ["intergenic"])
        # And says why, positively. The client must never reach that sentence by
        # noticing "intron" is absent: anything it fails to understand about an
        # answer would then come out as "too many genes here".
        self.assertEqual(answer["limited"], "gene_count")

    def test_a_region_under_the_limit_claims_no_reason_to_offer_less(self):
        answer = spans_for_level(
            "location",
            window=(1, 10_000),
            genes=[{"start": 100, "end": 5000}],
            gene_transcripts=[transcript((100, 200))],
            gene_count=12,
        )
        self.assertEqual(answer["offers"], ["intergenic", "intron"])
        self.assertNotIn("limited", answer)

    def test_the_limit_itself_still_offers_introns(self):
        answer = spans_for_level(
            "location",
            window=(1, 10_000),
            genes=[{"start": 100, "end": 5000}],
            gene_transcripts=[transcript((100, 200))],
            gene_count=MAX_INTRON_COLLAPSE_GENES,
        )
        self.assertEqual(answer["offers"], ["intergenic", "intron"])

    def test_a_location_with_no_genes_is_intergenic_throughout(self):
        answer = spans_for_level("location", window=(1, 10_000), genes=[], gene_count=0)
        self.assertEqual(answer["genic"], [])


if __name__ == "__main__":
    unittest.main()

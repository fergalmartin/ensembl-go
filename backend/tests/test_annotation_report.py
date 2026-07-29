import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from annotation.report import build_annotation_report  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"
GENOME = FIXTURES / "genome.fa"


def _write_temp(testcase, text, suffix=".gff3"):
    tmp = tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False)
    tmp.write(text)
    tmp.close()
    testcase.addCleanup(lambda: Path(tmp.name).unlink(missing_ok=True))
    return tmp.name


class HeadlineCountTests(unittest.TestCase):
    def test_stringtie_counts(self):
        report = build_annotation_report(str(FIXTURES / "stringtie.gtf"))
        self.assertEqual(report.dialect, "gtf")
        self.assertEqual(report.producer_guess, "StringTie")
        self.assertEqual(report.gene_count, 2)
        self.assertEqual(report.transcript_count, 3)
        self.assertEqual(report.exon_count, 6)
        self.assertEqual(report.cds_count, 0)
        self.assertEqual(report.coding_transcript_count, 0)
        self.assertEqual(report.monoexonic_transcript_count, 1)

    def test_ensembl_counts(self):
        report = build_annotation_report(str(FIXTURES / "ensembl.gff3"))
        self.assertEqual(report.gene_count, 3)
        self.assertEqual(report.transcript_count, 4)
        self.assertEqual(report.coding_transcript_count, 1)
        self.assertEqual(report.total_cds_bases, 600)

    def test_distributions(self):
        report = build_annotation_report(str(FIXTURES / "egapx.gff3"))
        self.assertEqual(report.transcripts_per_gene.maximum, 2)
        self.assertEqual(report.transcripts_per_gene.minimum, 1)
        self.assertEqual(report.exons_per_transcript.maximum, 2)

    def test_feature_type_histogram_includes_unmodelled_rows(self):
        report = build_annotation_report(str(FIXTURES / "refseq.gff3"))
        # `region` is not part of the gene model but must still be visible so
        # the user can see nothing was silently dropped.
        self.assertEqual(report.feature_type_counts.get("region"), 1)
        self.assertEqual(report.feature_type_counts.get("CDS"), 3)

    def test_exonic_and_cds_bases(self):
        report = build_annotation_report(str(FIXTURES / "helixer.gff3"))
        self.assertEqual(report.total_cds_bases, 600)
        self.assertEqual(report.total_exonic_bases, 801 + 151)


class ClassificationTests(unittest.TestCase):
    def test_biotypes_reported_as_provided_and_as_resolved(self):
        report = build_annotation_report(str(FIXTURES / "stringtie.gtf"))
        # Nothing in a StringTie GTF declares a biotype.
        self.assertEqual(report.source_transcript_biotype_counts, {"(none)": 3})
        self.assertEqual(report.transcript_biotype_counts.get("lncRNA"), 2)
        self.assertEqual(report.transcript_biotype_counts.get("sncRNA"), 1)

    def test_major_class_rollup(self):
        report = build_annotation_report(str(FIXTURES / "ensembl.gff3"))
        self.assertEqual(report.gene_major_class_counts.get("coding"), 1)
        self.assertEqual(report.gene_major_class_counts.get("lnoncoding"), 1)
        self.assertEqual(report.gene_major_class_counts.get("snoncoding"), 1)

    def test_biotype_rule_counts_explain_inference(self):
        report = build_annotation_report(str(FIXTURES / "braker.gtf"))
        self.assertEqual(report.biotype_rule_counts.get("inferred_from_cds"), 2)

    def test_no_coding_transcripts_is_noted(self):
        report = build_annotation_report(str(FIXTURES / "scallop.gtf"))
        codes = {issue.code for issue in report.issues}
        self.assertIn("no_coding_transcripts", codes)


class ConversionPreviewTests(unittest.TestCase):
    def test_gene_synthesis_is_previewed(self):
        report = build_annotation_report(str(FIXTURES / "stringtie.gtf"))
        self.assertEqual(report.inference_counts.get("gene_synthesised"), 2)

    def test_exon_derivation_is_previewed(self):
        report = build_annotation_report(str(FIXTURES / "augustus.gff3"))
        self.assertEqual(report.inference_counts.get("exons_from_cds"), 1)

    def test_utr_computation_is_previewed(self):
        report = build_annotation_report(str(FIXTURES / "egapx.gff3"))
        self.assertEqual(report.inference_counts.get("utrs_computed"), 2)

    def test_clean_ensembl_file_needs_little_inference(self):
        report = build_annotation_report(str(FIXTURES / "ensembl.gff3"))
        self.assertNotIn("gene_synthesised", report.inference_counts)
        self.assertNotIn("exons_from_cds", report.inference_counts)


class IdentifierAuditTests(unittest.TestCase):
    def test_duplicate_ids_recommend_generation(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
            "chr2\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr2\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr2\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
        )
        report = build_annotation_report(_write_temp(self, text))
        self.assertGreater(report.duplicate_id_across_regions_count, 0)
        self.assertTrue(report.id_generation_recommended)

    def test_clean_file_does_not_recommend_generation(self):
        report = build_annotation_report(str(FIXTURES / "ensembl.gff3"))
        self.assertFalse(report.id_generation_recommended)
        self.assertEqual(report.duplicate_id_count, 0)

    def test_orphan_parents_are_counted(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=nope\n"
            "chr1\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
        )
        report = build_annotation_report(_write_temp(self, text))
        self.assertGreater(report.orphan_parent_count, 0)


class FastaCrossCheckTests(unittest.TestCase):
    def _annotation(self, seqid_a="chr1", seqid_b="chr2"):
        return (
            "##gff-version 3\n"
            "{0}\tsrc\tgene\t10\t200\t.\t+\t.\tID=g1\n"
            "{0}\tsrc\tmRNA\t10\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "{0}\tsrc\texon\t10\t200\t.\t+\t.\tParent=t1\n"
            "{1}\tsrc\tgene\t10\t100\t.\t+\t.\tID=g2\n"
            "{1}\tsrc\tmRNA\t10\t100\t.\t+\t.\tID=t2;Parent=g2\n"
            "{1}\tsrc\texon\t10\t100\t.\t+\t.\tParent=t2\n"
        ).format(seqid_a, seqid_b)

    def test_matching_names_produce_no_mismatch(self):
        path = _write_temp(self, self._annotation())
        report = build_annotation_report(path, fasta_path=str(GENOME))
        self.assertTrue(report.fasta_checked)
        self.assertEqual(report.seqids_missing_from_fasta, [])
        self.assertEqual(report.fasta_seqids_without_annotation, 0)

    def test_missing_seqids_are_errors(self):
        path = _write_temp(self, self._annotation("scaffold_9", "scaffold_8"))
        report = build_annotation_report(path, fasta_path=str(GENOME))
        self.assertEqual(
            sorted(report.seqids_missing_from_fasta), ["scaffold_8", "scaffold_9"]
        )
        codes = {i.code: i.severity for i in report.issues}
        self.assertEqual(codes.get("seqid_missing_from_fasta"), "error")

    def test_chr_prefix_mismatch_is_diagnosed(self):
        # Annotation uses `1`/`2`, FASTA uses `chr1`/`chr2`.
        path = _write_temp(self, self._annotation("1", "2"))
        report = build_annotation_report(path, fasta_path=str(GENOME))
        self.assertIn("chr", report.naming_style_suggestion)
        self.assertIn("prefix", report.naming_style_suggestion)

    def test_features_past_sequence_end_are_errors(self):
        text = (
            "##gff-version 3\n"
            "chr2\tsrc\tgene\t10\t9000\t.\t+\t.\tID=g1\n"
            "chr2\tsrc\tmRNA\t10\t9000\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr2\tsrc\texon\t10\t9000\t.\t+\t.\tParent=t1\n"
        )
        report = build_annotation_report(
            _write_temp(self, text), fasta_path=str(GENOME)
        )
        codes = {i.code for i in report.issues}
        self.assertIn("feature_past_sequence_end", codes)

    def test_unannotated_fasta_regions_are_counted(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t10\t200\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t10\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t10\t200\t.\t+\t.\tParent=t1\n"
        )
        report = build_annotation_report(
            _write_temp(self, text), fasta_path=str(GENOME)
        )
        self.assertEqual(report.fasta_seqids_without_annotation, 1)

    def test_without_fasta_no_cross_check_is_claimed(self):
        report = build_annotation_report(str(FIXTURES / "ensembl.gff3"))
        self.assertFalse(report.fasta_checked)
        self.assertEqual(report.seqids_missing_from_fasta, [])


class SerialisationTests(unittest.TestCase):
    def test_as_dict_shape(self):
        payload = build_annotation_report(str(FIXTURES / "egapx.gff3")).as_dict()
        self.assertEqual(payload["counts"]["genes"], 2)
        self.assertEqual(payload["detected"]["dialect"], "gff3")
        self.assertIn("transcript_biotypes", payload["classification"])
        self.assertIn("inference", payload["conversion_preview"])
        self.assertIsInstance(payload["issues"], list)
        self.assertIsInstance(payload["error_count"], int)

    def test_error_and_warning_counts(self):
        text = "##gff-version 3\nchr1\tsrc\tgene\t900\t100\t.\t+\t.\tID=g1\n"
        report = build_annotation_report(_write_temp(self, text))
        self.assertGreater(report.error_count, 0)


class ProgressTests(unittest.TestCase):
    def test_annotation_report_emits_monotonic_work_based_progress(self):
        events = []
        report = build_annotation_report(
            str(FIXTURES / "stringtie.gtf"),
            fasta_path=str(GENOME),
            progress_callback=lambda stage, progress, message, counters: events.append(
                (stage, progress, message, counters)
            ),
        )
        self.assertEqual(report.gene_count, 2)
        self.assertGreater(len(events), 5)
        self.assertEqual(
            [event[1] for event in events],
            sorted(event[1] for event in events),
        )
        self.assertEqual(events[-1][0], "finalising_report")
        self.assertEqual(events[-1][1], 98.0)
        stages = {event[0] for event in events}
        self.assertIn("reading_fasta", stages)
        self.assertIn("parsing_annotation", stages)
        self.assertIn("building_gene_models", stages)
        self.assertIn("summarising_annotation", stages)
        self.assertTrue(any(event[3].get("features") for event in events))


if __name__ == "__main__":
    unittest.main()

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from annotation.biotype import (  # noqa: E402
    LNCRNA,
    PROTEIN_CODING,
    SNCRNA,
    derive_gene_biotype,
    major_class,
    resolve_transcript_biotype,
)
from annotation.normalize import normalize_annotation  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"


def _write_temp(testcase, text, suffix=".gff3"):
    tmp = tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False)
    tmp.write(text)
    tmp.close()
    testcase.addCleanup(lambda: Path(tmp.name).unlink(missing_ok=True))
    return tmp.name


def _genes_by_id(result):
    return {gene.gene_id: gene for gene in result.genes}


def _tx_by_id(result):
    return {tx.transcript_id: tx for tx in result.transcripts}


class GtfSupportTests(unittest.TestCase):
    """The five GTF producers that previously yielded an empty index."""

    def test_stringtie_builds_genes_from_gene_id(self):
        result = normalize_annotation(str(FIXTURES / "stringtie.gtf"))
        self.assertEqual(len(result.genes), 2)
        self.assertEqual(len(result.transcripts), 3)

        genes = _genes_by_id(result)
        self.assertEqual(len(genes["STRG.1"].transcripts), 2)
        self.assertIn("gene_synthesised", genes["STRG.1"].inferred)

        transcripts = _tx_by_id(result)
        self.assertEqual(
            [(b.start, b.end) for b in transcripts["STRG.1.1"].exons],
            [(1000, 1400), (2200, 2600), (4400, 5000)],
        )

    def test_stringtie_isoforms_share_one_gene(self):
        result = normalize_annotation(str(FIXTURES / "stringtie.gtf"))
        genes = _genes_by_id(result)
        self.assertEqual(
            sorted(tx.transcript_id for tx in genes["STRG.1"].transcripts),
            ["STRG.1.1", "STRG.1.2"],
        )

    def test_scallop(self):
        result = normalize_annotation(str(FIXTURES / "scallop.gtf"))
        self.assertEqual(len(result.genes), 2)
        self.assertEqual(len(result.transcripts), 2)

    def test_braker_bare_tokens_link_through_child_gene_id(self):
        result = normalize_annotation(str(FIXTURES / "braker.gtf"))
        self.assertEqual(len(result.genes), 2)
        genes = _genes_by_id(result)
        # The transcript row is a bare `g1.t1` with no parent; the link back to
        # gene `g1` is recovered from the gene_id on its children.
        self.assertEqual(genes["g1"].transcripts[0].transcript_id, "g1.t1")
        self.assertNotIn("gene_synthesised", genes["g1"].inferred)

    def test_tiberius_cds_only_file_reconstructs_both_levels(self):
        # Real Tiberius output has no gene, transcript or exon rows at all; the
        # whole model has to come from the CDS rows' transcript_id/gene_id.
        result = normalize_annotation(str(FIXTURES / "tiberius.gtf"))
        self.assertEqual(len(result.genes), 2)
        self.assertEqual(len(result.transcripts), 2)

        transcripts = _tx_by_id(result)
        self.assertEqual(sorted(transcripts), ["g1.t1", "g2.t1"])
        self.assertEqual(
            [(b.start, b.end) for b in transcripts["g1.t1"].exons],
            [(1000, 1399), (2200, 2396), (5000, 5002)],
        )
        self.assertEqual(transcripts["g1.t1"].cds_length, 600)
        self.assertEqual(transcripts["g1.t1"].biotype, PROTEIN_CODING)

    def test_cds_only_transcripts_do_not_fuse_across_regions(self):
        result = normalize_annotation(str(FIXTURES / "tiberius.gtf"))
        genes = _genes_by_id(result)
        self.assertEqual(genes["g1"].seqid, "PVKX01000002.1")
        self.assertEqual(genes["g2"].seqid, "PVKX01000003.1")

    def test_cds_only_file_reports_what_it_reconstructed(self):
        result = normalize_annotation(str(FIXTURES / "tiberius.gtf"))
        self.assertEqual(
            result.issues.count_for("transcript_synthesised_from_children"), 2
        )
        self.assertEqual(result.issues.count_for("gene_synthesised"), 2)
        self.assertFalse(result.issues.has_errors())

    def test_cds_only_children_keep_their_strand(self):
        result = normalize_annotation(str(FIXTURES / "tiberius.gtf"))
        genes = _genes_by_id(result)
        self.assertEqual(genes["g1"].strand, "+")
        self.assertEqual(genes["g2"].strand, "-")

    def test_same_transcript_id_on_two_regions_stays_separate(self):
        text = (
            'chr1\tsrc\tCDS\t100\t399\t.\t+\t0\ttranscript_id "t1"; gene_id "g1";\n'
            'chr2\tsrc\tCDS\t100\t399\t.\t+\t0\ttranscript_id "t1"; gene_id "g1";\n'
        )
        result = normalize_annotation(_write_temp(self, text, suffix=".gtf"))
        self.assertEqual(len(result.transcripts), 2)
        self.assertEqual(
            sorted(tx.seqid for tx in result.transcripts), ["chr1", "chr2"]
        )

    def test_child_with_no_parent_identifier_is_reported(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tCDS\t100\t399\t.\t+\t0\t.\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertGreater(result.issues.count_for("child_without_parent"), 0)

    def test_gtf_without_gene_rows_does_not_report_orphan_parents(self):
        # A GTF legitimately has no gene features; that is gene synthesis, not a
        # dangling reference, and must not be surfaced as a defect.
        result = normalize_annotation(str(FIXTURES / "stringtie.gtf"))
        self.assertEqual(result.issues.count_for("orphan_parent"), 0)


class StructuralInferenceTests(unittest.TestCase):
    def test_exons_derived_from_cds_when_absent(self):
        # The previous parser emitted a single exon spanning the intron here.
        result = normalize_annotation(str(FIXTURES / "augustus.gff3"))
        transcript = _tx_by_id(result)["g2.t1"]
        self.assertEqual(
            [(b.start, b.end) for b in transcript.exons],
            [(400, 600), (1000, 1200)],
        )
        self.assertIn("exons_from_cds", transcript.inferred)

    def test_stop_codon_folded_into_cds_for_gtf(self):
        result = normalize_annotation(str(FIXTURES / "braker.gtf"))
        transcript = _tx_by_id(result)["g1.t1"]
        self.assertIn("cds_extended_stop_codon", transcript.inferred)
        # The stop codon abuts the terminal CDS and must merge into one block,
        # not sit beside it as a spurious extra block.
        self.assertEqual(
            [(b.start, b.end) for b in transcript.cds],
            [(1000, 1399), (2200, 2399)],
        )
        self.assertEqual(transcript.cds_length, 600)

    def test_utrs_computed_from_cds_and_exons(self):
        result = normalize_annotation(str(FIXTURES / "egapx.gff3"))
        transcript = _tx_by_id(result)["XM_00000001.1"]
        self.assertEqual([(b.start, b.end) for b in transcript.utr5], [(1000, 1099)])
        self.assertEqual([(b.start, b.end) for b in transcript.utr3], [(2500, 2600)])
        self.assertIn("utrs_computed", transcript.inferred)

    def test_explicit_utrs_are_preserved_not_recomputed(self):
        result = normalize_annotation(str(FIXTURES / "helixer.gff3"))
        transcript = _tx_by_id(result)["Ha_chr1_000001.1"]
        self.assertEqual([(b.start, b.end) for b in transcript.utr5], [(1000, 1099)])
        self.assertNotIn("utrs_computed", transcript.inferred)

    def test_utr_orientation_on_minus_strand(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t900\t.\t-\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t900\t.\t-\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t300\t.\t-\t.\tParent=t1\n"
            "chr1\tsrc\texon\t700\t900\t.\t-\t.\tParent=t1\n"
            "chr1\tsrc\tCDS\t200\t300\t.\t-\t0\tParent=t1\n"
            "chr1\tsrc\tCDS\t700\t800\t.\t-\t0\tParent=t1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        transcript = result.transcripts[0]
        # On the minus strand the 5' UTR is the high-coordinate side.
        self.assertEqual([(b.start, b.end) for b in transcript.utr5], [(801, 900)])
        self.assertEqual([(b.start, b.end) for b in transcript.utr3], [(100, 199)])

    def test_phase_recomputed_in_translation_order(self):
        result = normalize_annotation(str(FIXTURES / "braker.gtf"))
        transcript = _tx_by_id(result)["g1.t1"]
        # First block 400 bp -> next block phase (3 - 400 % 3) % 3 == 2.
        self.assertEqual([b.phase for b in transcript.cds], [0, 2])

    def test_phase_recomputed_on_minus_strand(self):
        result = normalize_annotation(str(FIXTURES / "augustus.gff3"))
        transcript = _tx_by_id(result)["g2.t1"]
        # Translation starts at the high-coordinate block on the minus strand.
        by_start = {(b.start, b.end): b.phase for b in transcript.cds}
        self.assertEqual(by_start[(1000, 1200)], 0)
        self.assertEqual(by_start[(400, 600)], 0)

    def test_transcript_synthesised_for_gene_only_locus(self):
        result = normalize_annotation(str(FIXTURES / "refseq.gff3"))
        gene = _genes_by_id(result)["b0001"]
        self.assertEqual(len(gene.transcripts), 1)
        transcript = gene.transcripts[0]
        self.assertIn("transcript_synthesised", transcript.inferred)
        self.assertEqual(transcript.biotype, PROTEIN_CODING)
        self.assertEqual([(b.start, b.end) for b in transcript.cds], [(7000, 7299)])

    def test_gene_synthesised_for_orphan_transcript(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=t1\n"
            "chr1\tsrc\texon\t100\t300\t.\t+\t.\tParent=t1\n"
            "chr1\tsrc\tCDS\t100\t300\t.\t+\t0\tParent=t1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertEqual(len(result.genes), 1)
        gene = result.genes[0]
        self.assertEqual(gene.gene_id, "t1")
        self.assertIn("gene_synthesised", gene.inferred)

    def test_unknown_feature_types_are_classified_structurally(self):
        # A column-3 term we do not know must still load, decided by graph shape.
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tweird_locus\t100\t900\t.\t+\t.\tID=w1\n"
            "chr1\tsrc\tweird_product\t100\t900\t.\t+\t.\tID=w1.t1;Parent=w1\n"
            "chr1\tsrc\texon\t100\t300\t.\t+\t.\tParent=w1.t1\n"
            "chr1\tsrc\texon\t700\t900\t.\t+\t.\tParent=w1.t1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertEqual(len(result.genes), 1)
        self.assertEqual(len(result.transcripts), 1)
        # The unknown term is not a biotype, so length inference decides.
        self.assertEqual(result.transcripts[0].biotype, LNCRNA)

    def test_transcript_span_expanded_to_cover_children(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t400\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t400\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t900\t.\t+\t.\tParent=t1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        transcript = result.transcripts[0]
        self.assertEqual((transcript.start, transcript.end), (100, 900))
        self.assertIn("span_expanded_to_children", transcript.inferred)
        self.assertEqual((result.genes[0].start, result.genes[0].end), (100, 900))


class IdentifierTests(unittest.TestCase):
    def test_duplicate_ids_across_regions_stay_separate(self):
        # Previously these collapsed into one gene whose transcript claimed the
        # other chromosome's coordinates.
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t900\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=g1.t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t900\t.\t+\t.\tParent=g1.t1\n"
            "chr2\tsrc\tgene\t100\t900\t.\t+\t.\tID=g1\n"
            "chr2\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=g1.t1;Parent=g1\n"
            "chr2\tsrc\texon\t100\t900\t.\t+\t.\tParent=g1.t1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertEqual(len(result.genes), 2)
        self.assertEqual(sorted(g.seqid for g in result.genes), ["chr1", "chr2"])
        for gene in result.genes:
            self.assertEqual(len(gene.transcripts), 1)
            self.assertEqual(gene.transcripts[0].seqid, gene.seqid)
        self.assertGreater(result.issues.count_for("duplicate_id_across_regions"), 0)

    def test_orphan_parent_is_reported_for_gff3(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=t1;Parent=missing_gene\n"
            "chr1\tsrc\texon\t100\t900\t.\t+\t.\tParent=t1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertGreater(result.issues.count_for("orphan_parent"), 0)
        self.assertEqual(len(result.genes), 1)

    def test_ensembl_and_refseq_id_prefixes_are_stripped(self):
        ensembl = normalize_annotation(str(FIXTURES / "ensembl.gff3"))
        self.assertIn("ENSTEST00000000001", _genes_by_id(ensembl))
        self.assertIn("ENSTEST00000000101", _tx_by_id(ensembl))

        refseq = normalize_annotation(str(FIXTURES / "refseq.gff3"))
        self.assertIn("FOO1", _genes_by_id(refseq))
        self.assertIn("NM_000001.1", _tx_by_id(refseq))


class BiotypeTests(unittest.TestCase):
    def test_cds_implies_protein_coding(self):
        biotype, rule = resolve_transcript_biotype(None, "transcript", True, 900)
        self.assertEqual(biotype, PROTEIN_CODING)
        self.assertEqual(rule, "inferred_from_cds")

    def test_long_noncoding_uses_mature_length(self):
        biotype, rule = resolve_transcript_biotype(None, "transcript", False, 200)
        self.assertEqual(biotype, LNCRNA)
        self.assertEqual(rule, "inferred_length_ge_200")

    def test_short_noncoding(self):
        biotype, rule = resolve_transcript_biotype(None, "transcript", False, 199)
        self.assertEqual(biotype, SNCRNA)
        self.assertEqual(rule, "inferred_length_lt_200")

    def test_mature_length_not_genomic_span_decides(self):
        # A 151 bp single-exon transcript inside a wide locus is small non-coding.
        result = normalize_annotation(str(FIXTURES / "helixer.gff3"))
        transcript = _tx_by_id(result)["Ha_chr1_000002.1"]
        self.assertEqual(transcript.mature_length, 151)
        self.assertEqual(transcript.biotype, SNCRNA)

    def test_explicit_biotype_always_wins(self):
        # Ensembl and RefSeq assert biotypes; those must never be overridden.
        biotype, rule = resolve_transcript_biotype("lncRNA", "mRNA", True, 5000)
        self.assertEqual(biotype, LNCRNA)
        self.assertEqual(rule, "explicit")

    def test_mrna_feature_type_without_cds_is_not_called_coding(self):
        # StringTie-style GFF3 types every assembled transcript as mRNA.
        biotype, _ = resolve_transcript_biotype(None, "mRNA", False, 5000)
        self.assertEqual(biotype, LNCRNA)

    def test_ensembl_biotypes_are_preserved(self):
        result = normalize_annotation(str(FIXTURES / "ensembl.gff3"))
        transcripts = _tx_by_id(result)
        self.assertEqual(transcripts["ENSTEST00000000201"].biotype, LNCRNA)
        self.assertEqual(transcripts["ENSTEST00000000301"].biotype, "miRNA")
        self.assertEqual(transcripts["ENSTEST00000000102"].biotype, "retained_intron")

    def test_refseq_gbkey_and_gene_biotype(self):
        result = normalize_annotation(str(FIXTURES / "refseq.gff3"))
        genes = _genes_by_id(result)
        self.assertEqual(genes["FOO1"].biotype, PROTEIN_CODING)
        self.assertEqual(genes["TRNA1"].biotype, "tRNA")

    def test_gbkey_gene_is_not_treated_as_a_biotype(self):
        # `gbkey=Gene` says the row is a gene, not what kind of gene.
        result = normalize_annotation(str(FIXTURES / "refseq.gff3"))
        self.assertEqual(_genes_by_id(result)["b0001"].biotype, PROTEIN_CODING)

    def test_gene_biotype_prefers_coding_isoform(self):
        self.assertEqual(
            derive_gene_biotype([LNCRNA, PROTEIN_CODING, SNCRNA]), PROTEIN_CODING
        )
        self.assertEqual(derive_gene_biotype([SNCRNA, LNCRNA]), LNCRNA)
        self.assertEqual(derive_gene_biotype([], explicit="pseudogene"), "pseudogene")

    def test_major_class_mapping(self):
        self.assertEqual(major_class(PROTEIN_CODING), "coding")
        self.assertEqual(major_class(LNCRNA), "lnoncoding")
        self.assertEqual(major_class(SNCRNA), "snoncoding")
        self.assertEqual(major_class("processed_pseudogene"), "pseudogene")
        self.assertEqual(major_class("miRNA"), "snoncoding")

    def test_retained_intron_without_cds_is_not_flagged(self):
        result = normalize_annotation(str(FIXTURES / "ensembl.gff3"))
        self.assertEqual(result.issues.count_for("coding_biotype_without_cds"), 0)

    def test_protein_coding_without_cds_is_flagged_but_kept(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t900\t.\t+\t.\tID=g1;biotype=protein_coding\n"
            "chr1\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=t1;Parent=g1;biotype=protein_coding\n"
            "chr1\tsrc\texon\t100\t900\t.\t+\t.\tParent=t1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertEqual(result.transcripts[0].biotype, PROTEIN_CODING)
        self.assertGreater(result.issues.count_for("coding_biotype_without_cds"), 0)


class CanonicalTranscriptTests(unittest.TestCase):
    def test_source_tag_is_honoured(self):
        result = normalize_annotation(str(FIXTURES / "ensembl.gff3"))
        gene = _genes_by_id(result)["ENSTEST00000000001"]
        canonical = [tx.transcript_id for tx in gene.transcripts if tx.is_canonical]
        self.assertEqual(canonical, ["ENSTEST00000000101"])

    def test_refseq_select_tag_is_honoured(self):
        result = normalize_annotation(str(FIXTURES / "refseq.gff3"))
        gene = _genes_by_id(result)["FOO1"]
        self.assertTrue(gene.transcripts[0].is_canonical)

    def test_longest_cds_wins_without_a_tag(self):
        result = normalize_annotation(str(FIXTURES / "egapx.gff3"))
        gene = _genes_by_id(result)["LOC100001"]
        canonical = [tx.transcript_id for tx in gene.transcripts if tx.is_canonical]
        self.assertEqual(canonical, ["XM_00000001.1"])

    def test_exactly_one_canonical_per_gene(self):
        for name in ("stringtie.gtf", "egapx.gff3", "ensembl.gff3", "refseq.gff3"):
            result = normalize_annotation(str(FIXTURES / name))
            for gene in result.genes:
                flagged = [tx for tx in gene.transcripts if tx.is_canonical]
                self.assertEqual(len(flagged), 1, "{0}: {1}".format(name, gene.gene_id))


class MalformedInputTests(unittest.TestCase):
    def test_start_after_end_is_rejected_not_rendered(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t900\t100\t.\t+\t.\tID=g1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertGreater(result.issues.count_for("start_after_end"), 0)
        self.assertEqual(len(result.genes), 0)

    def test_start_below_one_is_rejected(self):
        text = "##gff-version 3\nchr1\tsrc\tgene\t0\t100\t.\t+\t.\tID=g1\n"
        result = normalize_annotation(_write_temp(self, text))
        self.assertGreater(result.issues.count_for("start_below_one"), 0)

    def test_non_integer_coordinates_are_rejected(self):
        text = "##gff-version 3\nchr1\tsrc\tgene\tNA\t100\t.\t+\t.\tID=g1\n"
        result = normalize_annotation(_write_temp(self, text))
        self.assertGreater(result.issues.count_for("non_integer_coordinates"), 0)

    def test_short_lines_are_reported(self):
        text = "##gff-version 3\nchr1\tsrc\tgene\t1\t9\n"
        result = normalize_annotation(_write_temp(self, text))
        self.assertGreater(result.issues.count_for("malformed_line"), 0)

    def test_features_past_sequence_end_are_reported(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t9000\t.\t+\t.\tID=g1\n"
        )
        result = normalize_annotation(
            _write_temp(self, text), sequence_lengths={"chr1": 500}
        )
        self.assertGreater(result.issues.count_for("feature_past_sequence_end"), 0)

    def test_embedded_fasta_section_is_not_parsed_as_features(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t900\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t900\t.\t+\t.\tParent=t1\n"
            "##FASTA\n"
            ">chr1\n"
            "ACGTACGTACGTACGT\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertEqual(len(result.genes), 1)
        self.assertEqual(result.issues.count_for("malformed_line"), 0)

    def test_empty_file_reports_an_error(self):
        result = normalize_annotation(_write_temp(self, "##gff-version 3\n"))
        self.assertGreater(result.issues.count_for("no_features"), 0)
        self.assertTrue(result.issues.has_errors())

    def test_crlf_line_endings(self):
        text = (
            "##gff-version 3\r\n"
            "chr1\tsrc\tgene\t100\t900\t.\t+\t.\tID=g1;biotype=protein_coding\r\n"
            "chr1\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=t1;Parent=g1\r\n"
            "chr1\tsrc\texon\t100\t900\t.\t+\t.\tParent=t1\r\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        self.assertEqual(len(result.genes), 1)
        self.assertEqual(result.genes[0].biotype, PROTEIN_CODING)

    def test_ignored_feature_types_do_not_create_genes(self):
        result = normalize_annotation(str(FIXTURES / "refseq.gff3"))
        # The `region` row must not become a gene.
        self.assertNotIn("NC_000001.11:1..100000", _genes_by_id(result))
        self.assertEqual(len(result.genes), 3)

    def test_feature_type_histogram_counts_ignored_rows(self):
        result = normalize_annotation(str(FIXTURES / "refseq.gff3"))
        self.assertEqual(result.feature_type_counts.get("region"), 1)
        self.assertEqual(result.feature_type_counts.get("gene"), 3)


if __name__ == "__main__":
    unittest.main()

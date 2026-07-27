import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import create_gff_index, _extract_protein_ids_from_gff  # noqa: E402


class NcbiGffIndexTests(unittest.TestCase):
    def _build_index(self, gff_content: str):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        root = Path(tmpdir.name)
        gff_path = root / "test.gff3"
        db_path = root / "test.index.db"
        gff_path.write_text(gff_content, encoding="utf-8")
        create_gff_index(str(gff_path), str(db_path))
        return gff_path, db_path

    def test_gene_parented_cds_creates_coding_transcript_without_syn_prefix(self):
        gff_content = """##gff-version 3
chr1\tRefSeq\tgene\t100\t300\t.\t+\t.\tID=gene-b0001;Name=thrA;gbkey=Gene;locus_tag=b0001
chr1\tRefSeq\tCDS\t100\t300\t.\t+\t0\tID=cds-NP_000001.1;Parent=gene-b0001;gbkey=CDS;protein_id=NP_000001.1
"""
        gff_path, db_path = self._build_index(gff_content)

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT id, parent_gene_id, data FROM transcripts WHERE id = ?",
                ("b0001",),
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["parent_gene_id"], "b0001")

            payload = json.loads(row["data"])
            self.assertEqual(payload["feature_id"], "b0001")
            self.assertEqual(payload["biotype"], "protein_coding")
            self.assertEqual(len(payload["cds_list"]), 1)
            self.assertEqual(payload["cds_list"][0]["start"], 100)
            self.assertEqual(payload["cds_list"][0]["end"], 300)

            missing = conn.execute(
                "SELECT 1 FROM transcripts WHERE id = ?",
                ("_syn_b0001",),
            ).fetchone()
            self.assertIsNone(missing)
        finally:
            conn.close()

        protein_ids = _extract_protein_ids_from_gff(
            str(gff_path),
            {"b0001"},
            {"b0001": "b0001"},
        )
        self.assertEqual(protein_ids, {"b0001": "NP_000001.1"})

    def test_gene_parented_cds_is_copied_onto_existing_rna_transcript(self):
        gff_content = """##gff-version 3
chr1\tRefSeq\tgene\t400\t900\t.\t+\t.\tID=gene-AB57_0001;Name=dnaA;gene_biotype=protein_coding;locus_tag=AB57_0001
chr1\tRefSeq\tmRNA\t400\t900\t.\t+\t.\tID=rna-AB57_0001;Parent=gene-AB57_0001;gbkey=mRNA
chr1\tRefSeq\tCDS\t400\t900\t.\t+\t0\tID=cds-WP_000001.1;Parent=gene-AB57_0001;gbkey=CDS;protein_id=WP_000001.1
"""
        gff_path, db_path = self._build_index(gff_content)

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT id, parent_gene_id, data FROM transcripts WHERE id = ?",
                ("AB57_0001",),
            ).fetchone()
            self.assertIsNotNone(row)
            payload = json.loads(row["data"])
            self.assertEqual(payload["biotype"], "protein_coding")
            self.assertEqual(payload["exons"][0]["start"], 400)
            self.assertEqual(payload["exons"][0]["end"], 900)
            self.assertEqual(len(payload["cds_list"]), 1)
            self.assertEqual(payload["cds_list"][0]["start"], 400)
            self.assertEqual(payload["cds_list"][0]["end"], 900)
        finally:
            conn.close()

        protein_ids = _extract_protein_ids_from_gff(
            str(gff_path),
            {"AB57_0001"},
            {"AB57_0001": "AB57_0001"},
        )
        self.assertEqual(protein_ids, {"AB57_0001": "WP_000001.1"})

    def test_protein_coding_gene_without_explicit_cds_uses_gene_span(self):
        gff_content = """##gff-version 3
chr1\tRefSeq\tgene\t1000\t1299\t.\t-\t.\tID=gene-AB57_0002;Name=recA;gene_biotype=protein_coding;locus_tag=AB57_0002
"""
        _, db_path = self._build_index(gff_content)

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT id, parent_gene_id, data FROM transcripts WHERE id = ?",
                ("AB57_0002",),
            ).fetchone()
            self.assertIsNotNone(row)
            payload = json.loads(row["data"])
            self.assertEqual(payload["biotype"], "protein_coding")
            self.assertEqual(payload["exons"][0]["start"], 1000)
            self.assertEqual(payload["exons"][0]["end"], 1299)
            self.assertEqual(len(payload["cds_list"]), 1)
            self.assertEqual(payload["cds_list"][0]["start"], 1000)
            self.assertEqual(payload["cds_list"][0]["end"], 1299)
            self.assertEqual(payload["cds_list"][0]["strand"], "-")
        finally:
            conn.close()

    def test_retained_intron_transcript_does_not_inherit_parent_gene_cds(self):
        gff_content = """##gff-version 3
chr1\tensembl_havana\tgene\t100\t999\t.\t+\t.\tID=gene:GENE1;Name=GENE1;biotype=protein_coding;gene_id=GENE1
chr1\tensembl_havana\tmRNA\t100\t900\t.\t+\t.\tID=transcript:TX_CODING;Parent=gene:GENE1;Name=GENE1-201;biotype=protein_coding;transcript_id=TX_CODING
chr1\tensembl_havana\texon\t100\t250\t.\t+\t.\tParent=transcript:TX_CODING
chr1\tensembl_havana\tCDS\t151\t250\t.\t+\t0\tID=CDS:PROT1;Parent=transcript:TX_CODING;protein_id=PROT1
chr1\thavana\tlnc_RNA\t400\t600\t.\t+\t.\tID=transcript:TX_RETAINED;Parent=gene:GENE1;Name=GENE1-202;biotype=retained_intron;transcript_id=TX_RETAINED
chr1\thavana\texon\t400\t450\t.\t+\t.\tParent=transcript:TX_RETAINED
chr1\thavana\texon\t500\t600\t.\t+\t.\tParent=transcript:TX_RETAINED
"""
        _, db_path = self._build_index(gff_content)

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            coding = conn.execute(
                "SELECT data FROM transcripts WHERE id = ?",
                ("TX_CODING",),
            ).fetchone()
            retained = conn.execute(
                "SELECT data FROM transcripts WHERE id = ?",
                ("TX_RETAINED",),
            ).fetchone()
            self.assertIsNotNone(coding)
            self.assertIsNotNone(retained)

            coding_payload = json.loads(coding["data"])
            self.assertEqual(coding_payload["biotype"], "protein_coding")
            self.assertEqual(len(coding_payload["cds_list"]), 1)
            self.assertEqual(coding_payload["cds_list"][0]["start"], 151)

            retained_payload = json.loads(retained["data"])
            self.assertEqual(retained_payload["biotype"], "retained_intron")
            self.assertEqual(retained_payload["cds_list"], [])
        finally:
            conn.close()

    def test_protein_coding_transcript_without_explicit_cds_uses_exons_not_parent_gene_span(self):
        gff_content = """##gff-version 3
chr1\tensembl_havana\tgene\t100\t999\t.\t+\t.\tID=gene:GENE2;Name=GENE2;biotype=protein_coding;gene_id=GENE2
chr1\tensembl_havana\tmRNA\t200\t800\t.\t+\t.\tID=transcript:TX_NO_CDS;Parent=gene:GENE2;Name=GENE2-201;biotype=protein_coding;transcript_id=TX_NO_CDS
chr1\tensembl_havana\texon\t200\t250\t.\t+\t.\tParent=transcript:TX_NO_CDS
chr1\tensembl_havana\texon\t700\t800\t.\t+\t.\tParent=transcript:TX_NO_CDS
"""
        _, db_path = self._build_index(gff_content)

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT data FROM transcripts WHERE id = ?",
                ("TX_NO_CDS",),
            ).fetchone()
            self.assertIsNotNone(row)
            payload = json.loads(row["data"])
            self.assertEqual(payload["biotype"], "protein_coding")
            self.assertEqual(payload["cds_list"], [
                {"feature_type": "CDS", "start": 200, "end": 250, "strand": "+"},
                {"feature_type": "CDS", "start": 700, "end": 800, "strand": "+"},
            ])
        finally:
            conn.close()

    def test_protein_coding_cds_not_defined_does_not_synthesize_translation(self):
        gff_content = """##gff-version 3
chr1\tensembl_havana\tgene\t100\t999\t.\t+\t.\tID=gene:GENE3;Name=GENE3;biotype=protein_coding;gene_id=GENE3
chr1\tensembl_havana\ttranscript\t200\t800\t.\t+\t.\tID=transcript:TX_NO_TRANSLATION;Parent=gene:GENE3;Name=GENE3-201;biotype=protein_coding_CDS_not_defined;transcript_id=TX_NO_TRANSLATION
chr1\tensembl_havana\texon\t200\t250\t.\t+\t.\tParent=transcript:TX_NO_TRANSLATION
chr1\tensembl_havana\texon\t700\t800\t.\t+\t.\tParent=transcript:TX_NO_TRANSLATION
"""
        _, db_path = self._build_index(gff_content)

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT data FROM transcripts WHERE id = ?",
                ("TX_NO_TRANSLATION",),
            ).fetchone()
            self.assertIsNotNone(row)
            payload = json.loads(row["data"])
            self.assertEqual(payload["biotype"], "protein_coding_CDS_not_defined")
            self.assertEqual(payload["cds_list"], [])
        finally:
            conn.close()

    def test_transcript_children_before_parent_are_preserved(self):
        gff_content = """##gff-version 3
chr1\tensembl\tgene\t100\t900\t.\t+\t.\tID=gene:GENE4;Name=GENE4;biotype=lncRNA
chr1\tensembl\texon\t200\t250\t.\t+\t.\tParent=transcript:TX_CHILD_FIRST
chr1\tensembl\tfive_prime_UTR\t200\t220\t.\t+\t.\tParent=transcript:TX_CHILD_FIRST
chr1\tensembl\tlnc_RNA\t200\t800\t.\t+\t.\tID=transcript:TX_CHILD_FIRST;Parent=gene:GENE4;biotype=lncRNA
chr1\tensembl\texon\t700\t800\t.\t+\t.\tParent=transcript:TX_CHILD_FIRST
"""
        _, db_path = self._build_index(gff_content)

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT data FROM transcripts WHERE id = ?",
                ("TX_CHILD_FIRST",),
            ).fetchone()
            self.assertIsNotNone(row)
            payload = json.loads(row["data"])
            self.assertEqual(payload["exons"], [
                {"feature_type": "exon", "start": 200, "end": 250, "strand": "+"},
                {"feature_type": "exon", "start": 700, "end": 800, "strand": "+"},
            ])
            self.assertEqual(payload["utrs"], [
                {"feature_type": "five_prime_UTR", "start": 200, "end": 220, "strand": "+"},
            ])
        finally:
            conn.close()

    def test_missing_exons_fall_back_to_transcript_not_gene_bounds(self):
        gff_content = """##gff-version 3
chr1\tensembl\tgene\t100\t900\t.\t-\t.\tID=gene:GENE5;Name=GENE5;biotype=lncRNA
chr1\tensembl\tlnc_RNA\t300\t600\t.\t-\t.\tID=transcript:TX_NO_EXONS;Parent=gene:GENE5;biotype=lncRNA
"""
        _, db_path = self._build_index(gff_content)

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT data FROM transcripts WHERE id = ?",
                ("TX_NO_EXONS",),
            ).fetchone()
            self.assertIsNotNone(row)
            payload = json.loads(row["data"])
            self.assertEqual(payload["exons"], [
                {"feature_type": "exon", "start": 300, "end": 600, "strand": "-"},
            ])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()

import csv
import gzip
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from annotation.convert import convert_annotation, converted_basename  # noqa: E402
from annotation.emit import escape_attribute  # noqa: E402
from annotation.identifiers import (  # noqa: E402
    IdentifierError,
    audit_identifiers,
    normalize_prefix,
)
from annotation.normalize import normalize_annotation  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "annotation"

ALL_FIXTURES = [
    "stringtie.gtf",
    "scallop.gtf",
    "braker.gtf",
    "tiberius.gtf",
    "augustus.gff3",
    "helixer.gff3",
    "egapx.gff3",
    "ensembl.gff3",
    "refseq.gff3",
]


def _tmpdir(testcase):
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    return tmp.name


def _write_temp(testcase, text, suffix=".gff3"):
    tmp = tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False)
    tmp.write(text)
    tmp.close()
    testcase.addCleanup(lambda: Path(tmp.name).unlink(missing_ok=True))
    return tmp.name


def _read_rows(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    rows = []
    with opener(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#") or not line.strip():
                continue
            rows.append(line.rstrip("\n").split("\t"))
    return rows


def _read_pragmas(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return [line.rstrip("\n") for line in handle if line.startswith("#")]


def _attrs(row):
    out = {}
    for chunk in row[8].split(";"):
        if "=" in chunk:
            key, _, value = chunk.partition("=")
            out[key] = value
    return out


class BasenameTests(unittest.TestCase):
    def test_extensions_are_stripped(self):
        self.assertEqual(converted_basename("genes.gtf"), "genes.ensembl.gff3")
        self.assertEqual(converted_basename("genes.gff3.gz"), "genes.ensembl.gff3")
        self.assertEqual(converted_basename("/a/b/braker.gtf.gz"), "braker.ensembl.gff3")
        self.assertEqual(converted_basename("annotation.gff"), "annotation.ensembl.gff3")

    def test_unknown_extension_is_kept_whole(self):
        self.assertEqual(converted_basename("weird.txt"), "weird.txt.ensembl.gff3")


class CanonicalOutputTests(unittest.TestCase):
    def _convert(self, name, **kwargs):
        kwargs.setdefault("compress", False)
        return convert_annotation(str(FIXTURES / name), _tmpdir(self), **kwargs)

    def test_output_declares_gff3(self):
        result = self._convert("stringtie.gtf")
        pragmas = _read_pragmas(result.output_path)
        self.assertEqual(pragmas[0], "##gff-version 3")
        self.assertTrue(any("ensembl-go-converted" in line for line in pragmas))

    def test_sequence_region_pragmas_come_from_the_fasta(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t10\t200\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t10\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t10\t200\t.\t+\t.\tParent=t1\n"
        )
        result = convert_annotation(
            _write_temp(self, text),
            _tmpdir(self),
            fasta_path=str(FIXTURES / "genome.fa"),
            compress=False,
        )
        pragmas = _read_pragmas(result.output_path)
        self.assertIn("##sequence-region chr1 1 244", pragmas)

    def test_gene_and_transcript_use_ensembl_id_prefixes(self):
        result = self._convert("braker.gtf")
        rows = _read_rows(result.output_path)
        genes = [r for r in rows if r[2] == "gene"]
        transcripts = [r for r in rows if r[2] in ("mRNA", "transcript")]
        self.assertTrue(all(_attrs(r)["ID"].startswith("gene:") for r in genes))
        for row in transcripts:
            self.assertTrue(_attrs(row)["ID"].startswith("transcript:"))
            self.assertTrue(_attrs(row)["Parent"].startswith("gene:"))

    def test_every_gene_has_exactly_one_canonical_transcript(self):
        for name in ALL_FIXTURES:
            result = self._convert(name)
            rows = _read_rows(result.output_path)
            by_gene = {}
            for row in rows:
                if row[2] not in ("mRNA", "transcript"):
                    continue
                attrs = _attrs(row)
                parent = attrs["Parent"]
                tags = attrs.get("tag", "")
                by_gene.setdefault(parent, []).append("Ensembl_canonical" in tags)
            for parent, flags in by_gene.items():
                self.assertEqual(sum(flags), 1, "{0}: {1}".format(name, parent))

    def test_coding_transcripts_are_typed_mrna(self):
        result = self._convert("braker.gtf")
        rows = _read_rows(result.output_path)
        self.assertTrue(any(r[2] == "mRNA" for r in rows))
        self.assertFalse(any(r[2] == "transcript" for r in rows))

    def test_noncoding_transcripts_are_typed_transcript(self):
        result = self._convert("stringtie.gtf")
        rows = _read_rows(result.output_path)
        self.assertTrue(any(r[2] == "transcript" for r in rows))
        self.assertFalse(any(r[2] == "mRNA" for r in rows))

    def test_biotype_is_written_on_genes_and_transcripts(self):
        result = self._convert("stringtie.gtf")
        rows = _read_rows(result.output_path)
        for row in rows:
            if row[2] in ("gene", "mRNA", "transcript"):
                self.assertIn(_attrs(row)["biotype"], {"lncRNA", "sncRNA"})

    def test_utrs_are_emitted_for_coding_transcripts(self):
        result = self._convert("egapx.gff3")
        types = {r[2] for r in _read_rows(result.output_path)}
        self.assertIn("five_prime_UTR", types)
        self.assertIn("three_prime_UTR", types)

    def test_exon_rank_follows_transcription_order(self):
        result = self._convert("augustus.gff3")
        rows = _read_rows(result.output_path)
        # g2 is on the minus strand: rank 1 is the highest-coordinate exon.
        minus_exons = [r for r in rows if r[2] == "exon" and r[6] == "-"]
        by_rank = {int(_attrs(r)["rank"]): int(r[3]) for r in minus_exons}
        self.assertGreater(by_rank[1], by_rank[2])

    def test_cds_phase_is_always_written(self):
        result = self._convert("braker.gtf")
        for row in _read_rows(result.output_path):
            if row[2] == "CDS":
                self.assertIn(row[7], {"0", "1", "2"})

    def test_rows_are_position_sorted_for_tabix(self):
        for name in ALL_FIXTURES:
            result = self._convert(name)
            rows = _read_rows(result.output_path)
            keys = [(r[0], int(r[3])) for r in rows]
            self.assertEqual(keys, sorted(keys), name)

    def test_parents_precede_children(self):
        result = self._convert("egapx.gff3")
        seen = set()
        for row in _read_rows(result.output_path):
            attrs = _attrs(row)
            parent = attrs.get("Parent")
            if parent:
                self.assertIn(parent, seen, "child before parent: {0}".format(row))
            if attrs.get("ID"):
                seen.add(attrs["ID"])

    def test_source_column_identifies_converted_files(self):
        result = self._convert("helixer.gff3")
        self.assertTrue(all(r[1] == "ensembl_go" for r in _read_rows(result.output_path)))

    def test_original_ids_are_preserved_as_alias(self):
        result = self._convert("ensembl.gff3")
        rows = _read_rows(result.output_path)
        gene = next(r for r in rows if r[2] == "gene")
        # `gene:ENSTEST...` in the source becomes the clean id plus an alias.
        self.assertEqual(_attrs(gene)["ID"], "gene:ENSTEST00000000001")
        self.assertEqual(_attrs(gene)["Alias"], "gene:ENSTEST00000000001")


class AttributeEscapingTests(unittest.TestCase):
    def test_reserved_characters_are_encoded(self):
        self.assertEqual(escape_attribute("a;b"), "a%3Bb")
        self.assertEqual(escape_attribute("a=b"), "a%3Db")
        self.assertEqual(escape_attribute("a,b"), "a%2Cb")
        self.assertEqual(escape_attribute("a&b"), "a%26b")
        self.assertEqual(escape_attribute("a\tb"), "a%09b")

    def test_percent_is_escaped_first(self):
        # Escaping ';' before '%' would turn "%3B" into a literal semicolon.
        self.assertEqual(escape_attribute("%3B"), "%253B")

    def test_description_with_separators_survives_a_round_trip(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t10\t200\t.\t+\t.\tID=g1;description=a%3Bb%2Cc;Name=n\n"
            "chr1\tsrc\tmRNA\t10\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t10\t200\t.\t+\t.\tParent=t1\n"
        )
        result = convert_annotation(_write_temp(self, text), _tmpdir(self), compress=False)
        gene = next(r for r in _read_rows(result.output_path) if r[2] == "gene")
        # Exactly two attribute separators means the value's own ';' stayed encoded.
        self.assertEqual(_attrs(gene)["description"], "a%3Bb%2Cc")


class IdentifierModeTests(unittest.TestCase):
    def test_keep_mode_preserves_source_identifiers(self):
        result = convert_annotation(
            str(FIXTURES / "ensembl.gff3"), _tmpdir(self), compress=False
        )
        self.assertEqual(result.id_mode, "keep")
        self.assertEqual(result.id_map_path, "")
        ids = {_attrs(r)["ID"] for r in _read_rows(result.output_path) if r[2] == "gene"}
        self.assertIn("gene:ENSTEST00000000001", ids)

    def test_generate_mode_mints_ensembl_style_ids(self):
        out = _tmpdir(self)
        result = convert_annotation(
            str(FIXTURES / "stringtie.gtf"),
            out,
            id_mode="generate",
            id_prefix="ensxyz",
            compress=False,
        )
        self.assertEqual(result.id_mode, "generate")
        self.assertEqual(result.id_prefix, "ENSXYZ")

        rows = _read_rows(result.output_path)
        gene_ids = [_attrs(r)["ID"] for r in rows if r[2] == "gene"]
        self.assertEqual(
            gene_ids, ["gene:ENSXYZG00000000001", "gene:ENSXYZG00000000002"]
        )
        tx_ids = [
            _attrs(r)["ID"] for r in rows if r[2] in ("mRNA", "transcript")
        ]
        self.assertTrue(all(t.startswith("transcript:ENSXYZT") for t in tx_ids))

    def test_generated_ids_are_ordered_by_position(self):
        result = convert_annotation(
            str(FIXTURES / "stringtie.gtf"),
            _tmpdir(self),
            id_mode="generate",
            id_prefix="ENSXYZ",
            compress=False,
        )
        rows = [r for r in _read_rows(result.output_path) if r[2] == "gene"]
        # chr1 sorts before chr2, so G...1 is the chr1 locus.
        self.assertEqual(rows[0][0], "chr1")
        self.assertEqual(_attrs(rows[0])["ID"], "gene:ENSXYZG00000000001")

    def test_generation_is_deterministic(self):
        first = convert_annotation(
            str(FIXTURES / "egapx.gff3"), _tmpdir(self),
            id_mode="generate", id_prefix="ENSXYZ", compress=False,
        )
        second = convert_annotation(
            str(FIXTURES / "egapx.gff3"), _tmpdir(self),
            id_mode="generate", id_prefix="ENSXYZ", compress=False,
        )
        self.assertEqual(
            Path(first.output_path).read_text().split("\n")[3:],
            Path(second.output_path).read_text().split("\n")[3:],
        )

    def test_shared_exons_share_one_identifier(self):
        result = convert_annotation(
            str(FIXTURES / "egapx.gff3"),
            _tmpdir(self),
            id_mode="generate",
            id_prefix="ENSXYZ",
            compress=False,
        )
        rows = [r for r in _read_rows(result.output_path) if r[2] == "exon"]
        # The two isoforms of LOC100001 share both exon intervals.
        by_interval = {}
        for row in rows:
            by_interval.setdefault((row[0], row[3], row[4]), set()).add(
                _attrs(row)["exon_id"]
            )
        for interval, ids in by_interval.items():
            self.assertEqual(len(ids), 1, interval)

    def test_id_map_is_written_and_complete(self):
        out = _tmpdir(self)
        result = convert_annotation(
            str(FIXTURES / "stringtie.gtf"),
            out,
            id_mode="generate",
            id_prefix="ENSXYZ",
            compress=False,
        )
        self.assertTrue(Path(result.id_map_path).is_file())
        with open(result.id_map_path, encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle, delimiter="\t"))
        self.assertEqual(
            rows[0].keys() & {"new_id", "old_id", "feature_type"},
            {"new_id", "old_id", "feature_type"},
        )
        genes = [r for r in rows if r["feature_type"] == "gene"]
        self.assertEqual({r["old_id"] for r in genes}, {"STRG.1", "STRG.2"})
        self.assertEqual(
            {r["new_id"] for r in genes},
            {"ENSXYZG00000000001", "ENSXYZG00000000002"},
        )

    def test_proteins_are_numbered_for_coding_transcripts_only(self):
        result = convert_annotation(
            str(FIXTURES / "egapx.gff3"),
            _tmpdir(self),
            id_mode="generate",
            id_prefix="ENSXYZ",
            compress=False,
        )
        with open(result.id_map_path, encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle, delimiter="\t"))
        proteins = [r for r in rows if r["feature_type"] == "protein"]
        # Two coding isoforms, one lncRNA.
        self.assertEqual(len(proteins), 2)

    def test_keep_mode_is_refused_when_ids_are_duplicated(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
            "chr2\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr2\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr2\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
        )
        path = _write_temp(self, text)
        with self.assertRaises(IdentifierError):
            convert_annotation(path, _tmpdir(self), compress=False)

    def test_generate_mode_rescues_duplicated_ids(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr1\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr1\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
            "chr2\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr2\tsrc\tmRNA\t100\t200\t.\t+\t.\tID=t1;Parent=g1\n"
            "chr2\tsrc\texon\t100\t200\t.\t+\t.\tParent=t1\n"
        )
        result = convert_annotation(
            _write_temp(self, text),
            _tmpdir(self),
            id_mode="generate",
            id_prefix="ENSXYZ",
            compress=False,
        )
        ids = [_attrs(r)["ID"] for r in _read_rows(result.output_path) if r[2] == "gene"]
        self.assertEqual(len(set(ids)), 2)

    def test_prefix_validation(self):
        self.assertEqual(normalize_prefix("ensxyz"), "ENSXYZ")
        for bad in ("", "AB", "1ABC", "ENS-XYZ", "TOOLONGPREFIXHERE"):
            with self.assertRaises(IdentifierError, msg=bad):
                normalize_prefix(bad)

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(IdentifierError):
            convert_annotation(
                str(FIXTURES / "ensembl.gff3"),
                _tmpdir(self),
                id_mode="invent",
                compress=False,
            )

    def test_audit_flags_duplicates(self):
        text = (
            "##gff-version 3\n"
            "chr1\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
            "chr2\tsrc\tgene\t100\t200\t.\t+\t.\tID=g1\n"
        )
        result = normalize_annotation(_write_temp(self, text))
        audit = audit_identifiers(result.genes)
        self.assertEqual(audit.duplicate_gene_ids, ["g1"])
        self.assertTrue(audit.generation_required)


class CompressionTests(unittest.TestCase):
    def test_compress_produces_bgzip_and_tabix(self):
        result = convert_annotation(
            str(FIXTURES / "ensembl.gff3"), _tmpdir(self), compress=True
        )
        self.assertTrue(result.output_path.endswith(".gff3.gz"))
        self.assertTrue(Path(result.output_path).is_file())
        # The plain intermediate must not be left behind.
        self.assertFalse(Path(result.output_path[:-3]).exists())
        if result.tabix_index_path:
            self.assertTrue(Path(result.tabix_index_path).is_file())

    def test_compressed_output_is_still_readable(self):
        result = convert_annotation(
            str(FIXTURES / "ensembl.gff3"), _tmpdir(self), compress=True
        )
        rows = _read_rows(result.output_path)
        self.assertEqual(len([r for r in rows if r[2] == "gene"]), 3)


class ExistingIndexerRoundTripTests(unittest.TestCase):
    """Converted files must load through the unmodified create_gff_index.

    This is the contract that lets conversion ship without touching the parser
    that Ensembl and RefSeq downloads already rely on.
    """

    @classmethod
    def setUpClass(cls):
        from main import create_gff_index  # noqa: WPS433 - heavy import, once
        cls.create_gff_index = staticmethod(create_gff_index)

    def _round_trip(self, name, **kwargs):
        kwargs.setdefault("compress", False)
        out = _tmpdir(self)
        result = convert_annotation(str(FIXTURES / name), out, **kwargs)
        db_path = str(Path(out) / "index.db")
        type(self).create_gff_index(result.output_path, db_path)
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        return result, conn

    def test_every_fixture_survives_the_round_trip(self):
        for name in ALL_FIXTURES:
            result, conn = self._round_trip(name)
            genes = conn.execute("SELECT COUNT(*) FROM genes").fetchone()[0]
            transcripts = conn.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0]
            self.assertEqual(genes, result.gene_count, name)
            self.assertEqual(transcripts, result.transcript_count, name)

    def test_gtf_input_reaches_the_index(self):
        # The end-to-end fix: a StringTie GTF previously produced an empty index.
        result, conn = self._round_trip("stringtie.gtf")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM genes").fetchone()[0], 2)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0], 3
        )

    def test_exons_reach_the_index_intact(self):
        result, conn = self._round_trip("braker.gtf")
        row = conn.execute(
            "SELECT data FROM transcripts WHERE parent_gene_id = 'g2'"
        ).fetchone()
        payload = json.loads(row["data"])
        # Derived from CDS: two exons, not one spanning the intron.
        self.assertEqual(
            [(e["start"], e["end"]) for e in payload["exons"]],
            [(400, 600), (1000, 1200)],
        )

    def test_biotypes_reach_the_index(self):
        result, conn = self._round_trip("stringtie.gtf")
        biotypes = {
            row["id"]: row["biotype"]
            for row in conn.execute("SELECT id, biotype FROM genes")
        }
        self.assertEqual(biotypes["STRG.1"], "lncRNA")
        self.assertEqual(biotypes["STRG.2"], "sncRNA")

    def test_canonical_flag_reaches_the_index(self):
        result, conn = self._round_trip("egapx.gff3")
        canonical = conn.execute(
            "SELECT id FROM transcripts WHERE is_canonical = 1"
        ).fetchall()
        self.assertEqual(len(canonical), result.gene_count)

    def test_utrs_reach_the_index(self):
        result, conn = self._round_trip("egapx.gff3")
        row = conn.execute(
            "SELECT data FROM transcripts WHERE id = 'XM_00000001.1'"
        ).fetchone()
        payload = json.loads(row["data"])
        kinds = {utr["feature_type"] for utr in payload["utrs"]}
        self.assertEqual(kinds, {"five_prime_UTR", "three_prime_UTR"})

    def test_minted_ids_reach_the_index(self):
        result, conn = self._round_trip(
            "stringtie.gtf", id_mode="generate", id_prefix="ENSXYZ"
        )
        ids = [row["id"] for row in conn.execute("SELECT id FROM genes ORDER BY id")]
        self.assertEqual(ids, ["ENSXYZG00000000001", "ENSXYZG00000000002"])

    def test_ensembl_fixture_keeps_its_own_identifiers(self):
        result, conn = self._round_trip("ensembl.gff3")
        ids = {row["id"] for row in conn.execute("SELECT id FROM genes")}
        self.assertIn("ENSTEST00000000001", ids)


if __name__ == "__main__":
    unittest.main()

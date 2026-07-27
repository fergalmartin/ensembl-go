import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from generate_pairwise_alignment_manifest import (  # noqa: E402
    GenomeRow,
    build_manifest,
    parse_alignment_filename,
    parse_ftp_listing,
    read_compara_tsv,
    write_alignment_rows_tsv,
)


class PairwiseAlignmentManifestTests(unittest.TestCase):
    def test_parse_alignment_filename_with_dotted_assembly(self):
        parsed = parse_alignment_filename(
            "hsap_grch38.v.ggal_bgalgal1.mat.broiler.grcg7b.lastz_net.tar.gz",
            "https://ftp.example/pairwise_alignments/",
        )

        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.method, "LASTZ_NET")
        self.assertEqual(parsed.endpoints[0].species_abbrev, "hsap")
        self.assertEqual(parsed.endpoints[0].assembly_token, "grch38")
        self.assertEqual(parsed.endpoints[1].species_abbrev, "ggal")
        self.assertEqual(parsed.endpoints[1].assembly_token, "bgalgal1.mat.broiler.grcg7b")
        self.assertEqual(
            parsed.url,
            "https://ftp.example/pairwise_alignments/"
            "hsap_grch38.v.ggal_bgalgal1.mat.broiler.grcg7b.lastz_net.tar.gz",
        )

    def test_manifest_joins_ftp_compara_and_catalog_accessions(self):
        listing = """
<html><body>
<a href="hsap_grch38.v.abra_asm259213v1.lastz_net.tar.gz">file</a>
</body></html>
"""
        ftp_files = parse_ftp_listing(listing, "https://ftp.example/pairwise_alignments/")
        compara_rows = [
            GenomeRow(
                method_link_species_set_id="123",
                alignment_type="LASTZ_NET",
                mlss_name="Homo sapiens-Abramis brama LASTZ_NET",
                genome_db_id="1",
                name="homo_sapiens",
                assembly="GRCh38",
                taxon_id="9606",
                display_name="Human",
            ),
            GenomeRow(
                method_link_species_set_id="123",
                alignment_type="LASTZ_NET",
                mlss_name="Homo sapiens-Abramis brama LASTZ_NET",
                genome_db_id="2",
                name="abramis_brama",
                assembly="ASM259213v1",
                taxon_id="38527",
                display_name="Common bream",
            ),
        ]
        catalog = {
            "species": {
                "Homo_sapiens": {
                    "scientific_name": "Homo sapiens",
                    "common_name": "Human",
                    "taxid": 9606,
                    "assemblies": {"GCA_000001405.29": {"name": "GRCh38.p14", "level": "chromosome"}},
                },
                "Abramis_brama": {
                    "scientific_name": "Abramis brama",
                    "common_name": "Common bream",
                    "taxid": 38527,
                    "assemblies": {"GCA_000002592.1": {"name": "ASM259213v1", "level": "scaffold"}},
                },
            }
        }

        manifest = build_manifest(
            ftp_files=ftp_files,
            compara_rows=compara_rows,
            catalog=catalog,
            release=116,
            ftp_url="https://ftp.example/pairwise_alignments/",
            paired_accessions={"GCA_000001405.29": "GCF_000001405.40"},
        )

        self.assertEqual(manifest["metadata"]["match_status_counts"], {"matched": 1})
        alignment = manifest["alignments"][0]
        self.assertEqual(alignment["method_link_species_set_id"], "123")
        accessions = {side["accession"] for side in alignment["sides"]}
        self.assertEqual(accessions, {"GCA_000001405.29", "GCA_000002592.1"})
        human_side = [side for side in alignment["sides"] if side["name"] == "homo_sapiens"][0]
        self.assertEqual(human_side["equivalent_accessions"], ["GCF_000001405.40"])
        self.assertIn("GCA_000001405.29", manifest["by_accession"])
        self.assertIn("GCF_000001405.40", manifest["by_accession"])
        row = manifest["alignment_rows"][0]
        self.assertEqual(row["ftp_filename"], "hsap_grch38.v.abra_asm259213v1.lastz_net.tar.gz")
        self.assertEqual(row["ftp_url"], "https://ftp.example/pairwise_alignments/hsap_grch38.v.abra_asm259213v1.lastz_net.tar.gz")
        self.assertEqual(row["species_1_species_name"], "Homo sapiens")
        self.assertEqual(row["species_1_assembly_name"], "GRCh38")
        self.assertEqual(row["species_1_catalog_assembly_name"], "GRCh38.p14")
        self.assertEqual(row["species_1_gca"], "GCA_000001405.29")
        self.assertEqual(row["species_1_gcf"], "GCF_000001405.40")
        self.assertEqual(row["species_2_species_name"], "Abramis brama")
        self.assertEqual(row["species_2_gca"], "GCA_000002592.1")

        with tempfile.TemporaryDirectory() as tmpdir:
            rows_path = Path(tmpdir) / "pairwise.tsv"
            write_alignment_rows_tsv(rows_path, manifest["alignment_rows"])
            written = rows_path.read_text(encoding="utf-8")
        self.assertIn("species_1_species_name", written.splitlines()[0])
        self.assertIn("Homo sapiens", written)

    def test_read_compara_tsv(self):
        content = "\t".join(
            [
                "method_link_species_set_id",
                "alignment_type",
                "mlss_name",
                "genome_db_id",
                "name",
                "assembly",
                "taxon_id",
            ]
        )
        content += "\n123\tLASTZ_NET\tPair\t1\thomo_sapiens\tGRCh38\t9606\n"
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "compara.tsv"
            path.write_text(content, encoding="utf-8")
            rows = read_compara_tsv(path)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].name, "homo_sapiens")
        self.assertEqual(rows[0].assembly, "GRCh38")

    def test_manifest_can_fill_missing_accession_from_ncbi_assembly_name(self):
        ftp_files = parse_ftp_listing(
            '<a href="aper_nemo_v1.v.drer_grcz11.lastz_net.tar.gz">file</a>',
            "https://ftp.example/pairwise_alignments/",
        )
        compara_rows = [
            GenomeRow(
                method_link_species_set_id="456",
                alignment_type="LASTZ_NET",
                mlss_name="Aper-Drer LastZ",
                genome_db_id="3",
                name="amphiprion_percula",
                assembly="Nemo_v1",
                taxon_id="161767",
                display_name="Orange clownfish",
            ),
            GenomeRow(
                method_link_species_set_id="456",
                alignment_type="LASTZ_NET",
                mlss_name="Aper-Drer LastZ",
                genome_db_id="4",
                name="danio_rerio",
                assembly="GRCz11",
                taxon_id="7955",
                display_name="Zebrafish",
            ),
        ]
        catalog = {
            "species": {
                "Danio_rerio": {
                    "scientific_name": "Danio rerio",
                    "common_name": "Zebrafish",
                    "taxid": 7955,
                    "assemblies": {"GCA_000002035.4": {"name": "GRCz11", "level": "chromosome"}},
                }
            }
        }

        manifest = build_manifest(
            ftp_files=ftp_files,
            compara_rows=compara_rows,
            catalog=catalog,
            release=116,
            ftp_url="https://ftp.example/pairwise_alignments/",
            ncbi_assembly_accessions={
                "nemov1": [
                    {
                        "accession": "GCA_003047355.2",
                        "assembly_name": "Nemo_v1.1",
                        "scientific_name": "Amphiprion percula",
                        "common_name": "orange clownfish",
                        "taxon_id": "161767",
                    }
                ]
            },
        )

        row = manifest["alignment_rows"][0]
        self.assertEqual(row["species_1_species_name"], "Amphiprion percula")
        self.assertEqual(row["species_1_assembly_name"], "Nemo_v1")
        self.assertEqual(row["species_1_catalog_assembly_name"], "Nemo_v1.1")
        self.assertEqual(row["species_1_gca"], "GCA_003047355.2")
        self.assertEqual(row["species_1_catalog_match"], "ncbi_assembly_name")

    def test_ncbi_assembly_name_fill_prefers_gca_when_gca_and_gcf_match(self):
        ftp_files = parse_ftp_listing(
            '<a href="btau_ars-ucd2.0.v.bmut_bosgru_v2.0.lastz_net.tar.gz">file</a>',
            "https://ftp.example/pairwise_alignments/",
        )
        compara_rows = [
            GenomeRow(
                method_link_species_set_id="789",
                alignment_type="LASTZ_NET",
                mlss_name="Bmut-Btau LastZ",
                genome_db_id="526",
                name="bos_taurus",
                assembly="ARS-UCD2.0",
                taxon_id="9913",
                display_name="Cattle",
            ),
            GenomeRow(
                method_link_species_set_id="789",
                alignment_type="LASTZ_NET",
                mlss_name="Bmut-Btau LastZ",
                genome_db_id="335",
                name="bos_mutus",
                assembly="BosGru_v2.0",
                taxon_id="72004",
                display_name="Wild yak",
            ),
        ]
        catalog = {
            "species": {
                "Bos_taurus": {
                    "scientific_name": "Bos taurus",
                    "common_name": "Cattle",
                    "taxid": 9913,
                    "assemblies": {"GCA_002263795.4": {"name": "ARS-UCD2.0", "level": "chromosome"}},
                }
            }
        }

        manifest = build_manifest(
            ftp_files=ftp_files,
            compara_rows=compara_rows,
            catalog=catalog,
            release=116,
            ftp_url="https://ftp.example/pairwise_alignments/",
            paired_accessions={"GCA_000298355.1": "GCF_000298355.1"},
            ncbi_assembly_accessions={
                "bosgruv20": [
                    {
                        "accession": "GCF_000298355.1",
                        "paired_accession": "GCA_000298355.1",
                        "assembly_name": "BosGru_v2.0",
                        "assembly_status": "suppressed",
                        "scientific_name": "Bos mutus",
                        "common_name": "wild yak",
                        "taxon_id": "72004",
                        "source_database": "REFSEQ",
                    },
                    {
                        "accession": "GCA_000298355.1",
                        "paired_accession": "GCF_000298355.1",
                        "assembly_name": "BosGru_v2.0",
                        "assembly_status": "current",
                        "scientific_name": "Bos mutus",
                        "common_name": "wild yak",
                        "taxon_id": "72004",
                        "source_database": "GENBANK",
                    },
                ]
            },
        )

        row = manifest["alignment_rows"][0]
        self.assertEqual(row["species_2_species_name"], "Bos mutus")
        self.assertEqual(row["species_2_assembly_name"], "BosGru_v2.0")
        self.assertEqual(row["species_2_gca"], "GCA_000298355.1")
        self.assertEqual(row["species_2_gcf"], "GCF_000298355.1")
        self.assertEqual(row["species_2_catalog_match"], "ncbi_assembly_name")


if __name__ == "__main__":
    unittest.main()

import gzip
import io
import json
import sys
import tempfile
import unittest
import asyncio
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from assembly_report import (  # noqa: E402
    AssemblyReportRow,
    build_synonym_index,
    extract_ncbi_assembly_dirs_from_listing,
    load_assembly_synonym_rows,
    parse_assembly_report_file,
    resolve_region_name,
    select_ncbi_assembly_dir,
    split_gca_accession,
)
from download_manager import (  # noqa: E402
    ENSEMBL_SPECIES_CATALOG_LEGACY_URL,
    ENSEMBL_SPECIES_CATALOG_NEW_URL,
    DownloadManager,
    DownloadTask,
)


class _FakeResponse:
    def __init__(self, chunks, headers=None, status_code=200):
        self._chunks = chunks
        self.headers = headers or {}
        self.status_code = status_code
        self.ok = status_code < 400

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size=65536):
        del chunk_size
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        del exc_type, exc, tb
        return False


class _FakeHttpErrorResponse(_FakeResponse):
    def __init__(self, status_code=404, url="https://example.invalid/missing", headers=None):
        super().__init__(chunks=[], headers=headers or {}, status_code=status_code)
        self.url = url

    def raise_for_status(self):
        raise requests.HTTPError(f"HTTP {self.status_code}", response=self)


class _FakeJsonResponse:
    def __init__(self, payload, status_code=200, url="https://example.invalid/species.json"):
        self._payload = payload
        self.status_code = status_code
        self.ok = status_code < 400
        self.url = url
        self.headers = {}

    def raise_for_status(self):
        if not self.ok:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def json(self):
        return self._payload


class AssemblyReportParsingTests(unittest.TestCase):
    def test_parse_and_resolve_basic_aliases(self):
        content = """# Example
# Sequence-Name\tSequence-Role\tAssigned-Molecule\tAssigned-Molecule-Location/Type\tGenBank-Accn\tRelationship\tRefSeq-Accn\tAssembly-Unit\tSequence-Length\tUCSC-style-name
1\tassembled-molecule\t1\tChromosome\tCM000663.2\t=\tNC_000001.11\tPrimary Assembly\t248956422\tchr1
MT\tassembled-molecule\tMT\tMitochondrion\tJ01415.2\t=\tNC_012920.1\tPrimary Assembly\t16569\tchrM
GL000001.1\tunlocalized-scaffold\tna\tna\tGL000001.1\t=\tna\tPrimary Assembly\t1000\tna
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            fp = Path(tmpdir) / "assembly_report.txt"
            fp.write_text(content, encoding="utf-8")
            rows = parse_assembly_report_file(str(fp))

        self.assertEqual(len(rows), 3)
        index = build_synonym_index(rows, ["1", "MT"])
        aliases = index.get("alias_to_candidates") or {}
        self.assertIn("nc_000001.11", aliases)
        self.assertIn("chrm", aliases)

        self.assertEqual(resolve_region_name("NC_000001.11", ["1", "MT"], aliases), "1")
        self.assertEqual(resolve_region_name("chr1", ["1", "MT"], aliases), "1")
        self.assertEqual(resolve_region_name("chrM", ["1", "MT"], aliases), "MT")
        self.assertIsNone(resolve_region_name("unknown_chrom", ["1", "MT"], aliases))

    def test_load_synonyms_from_ncbi_sequence_report_json_gz(self):
        payload = {
            "reports": [
                {
                    "sequence_name": "1",
                    "chr_name": "1",
                    "genbank_accession": "CM000663.2",
                    "refseq_accession": "NC_000001.11",
                    "ucsc_style_name": "chr1",
                    "role": "assembled-molecule",
                },
                {
                    "sequence_name": "MT",
                    "chr_name": "MT",
                    "genbank_accession": "J01415.2",
                    "refseq_accession": "NC_012920.1",
                    "ucsc_style_name": "chrM",
                    "role": "assembled-molecule",
                },
            ]
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            fp = Path(tmpdir) / "GCF_000001405.40.sequence_report.json.gz"
            with gzip.open(fp, "wt", encoding="utf-8") as handle:
                json.dump(payload, handle)
            rows = load_assembly_synonym_rows(str(fp))

        self.assertEqual(len(rows), 2)
        index = build_synonym_index(rows, ["1", "MT"])
        aliases = index.get("alias_to_candidates") or {}
        self.assertEqual(resolve_region_name("NC_000001.11", ["1", "MT"], aliases), "1")
        self.assertEqual(resolve_region_name("chrM", ["1", "MT"], aliases), "MT")

    def test_resolver_prefers_assembled_molecule_on_ambiguity(self):
        rows = [
            AssemblyReportRow(
                row_index=0,
                sequence_name="1",
                assigned_molecule="1",
                genbank_accession="CM000001.1",
                refseq_accession="NC_000001.1",
                ucsc_style_name="foo",
                sequence_role="assembled-molecule",
            ),
            AssemblyReportRow(
                row_index=1,
                sequence_name="GL000001.1",
                assigned_molecule="na",
                genbank_accession="GL000001.1",
                refseq_accession="NW_000001.1",
                ucsc_style_name="foo",
                sequence_role="unlocalized-scaffold",
            ),
        ]
        index = build_synonym_index(rows, ["1", "GL000001.1"])
        aliases = index.get("alias_to_candidates") or {}
        self.assertEqual(resolve_region_name("foo", ["1", "GL000001.1"], aliases), "1")
        per_region = index.get("canonical_to_synonyms") or {}
        self.assertIn("foo", per_region.get("1", []))
        self.assertNotIn("foo", per_region.get("GL000001.1", []))


class NcbiDirectorySelectionTests(unittest.TestCase):
    def test_extract_and_select_ncbi_dir(self):
        html = """
<html><body>
<a href="GCA_000001405.28_GRCh38.p13/">GCA_000001405.28_GRCh38.p13/</a>
<a href="GCA_000001405.29_GRCh38.p14/">GCA_000001405.29_GRCh38.p14/</a>
</body></html>
"""
        directories = extract_ncbi_assembly_dirs_from_listing(html)
        stem, version, full = split_gca_accession("GCA_000001405.29")
        chosen = select_ncbi_assembly_dir(directories, stem or "", version, full)
        self.assertEqual(chosen, "GCA_000001405.29_GRCh38.p14")


class DownloadManagerMetadataTests(unittest.TestCase):
    def _write_species_json(self, root: Path) -> Path:
        payload = {
            "species": {
                "Test_species": {
                    "scientific_name": "Test species",
                    "common_name": "Test",
                    "taxid": 1,
                    "species_taxonomy_id": 1,
                    "assemblies": {
                        "GCA_000001405.29": {
                            "name": "TestAsm",
                            "level": "chromosome",
                            "assembly": {
                                "files": {
                                    "genome_sequences": {
                                        "softmasked.fa.gz": "dummy/path/softmasked.fa.gz",
                                        "unmasked.fa.gz": "dummy/path/unmasked.fa.gz",
                                    }
                                }
                            },
                            "genebuild_providers": {},
                        }
                    },
                }
            }
        }
        fp = root / "species.json"
        fp.write_text(json.dumps(payload), encoding="utf-8")
        return fp

    def test_fasta_prefers_softmasked_when_available(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            species_json = self._write_species_json(Path(tmpdir))
            manager = DownloadManager(species_json)
            files = manager.get_download_urls("Test_species", "GCA_000001405.29", file_types=["fasta"])

        fasta_files = [f for f in files if f.type == "fasta"]
        self.assertEqual(len(fasta_files), 1)
        self.assertTrue(fasta_files[0].filename.endswith("softmasked.fa.gz"))

    def test_fasta_falls_back_to_unmasked_when_softmasked_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            payload = {
                "species": {
                    "Test_species": {
                        "scientific_name": "Test species",
                        "common_name": "Test",
                        "taxid": 1,
                        "species_taxonomy_id": 1,
                        "assemblies": {
                            "GCA_000001405.29": {
                                "name": "TestAsm",
                                "level": "chromosome",
                                "assembly": {
                                    "files": {
                                        "genome_sequences": {
                                            "unmasked.fa.gz": "dummy/path/unmasked.fa.gz"
                                        }
                                    }
                                },
                                "genebuild_providers": {},
                            }
                        },
                    }
                }
            }
            species_json = root / "species.json"
            species_json.write_text(json.dumps(payload), encoding="utf-8")
            manager = DownloadManager(species_json)
            files = manager.get_download_urls("Test_species", "GCA_000001405.29", file_types=["fasta"])

        fasta_files = [f for f in files if f.type == "fasta"]
        self.assertEqual(len(fasta_files), 1)
        self.assertTrue(fasta_files[0].filename.endswith("unmasked.fa.gz"))

    def test_fasta_uses_generic_fasta_entry_when_named_keys_absent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            payload = {
                "species": {
                    "Test_species": {
                        "scientific_name": "Test species",
                        "common_name": "Test",
                        "taxid": 1,
                        "species_taxonomy_id": 1,
                        "assemblies": {
                            "GCA_000001405.29": {
                                "name": "TestAsm",
                                "level": "chromosome",
                                "assembly": {
                                    "files": {
                                        "genome_sequences": {
                                            "dna.primary_assembly.fa.gz": "dummy/path/dna.primary_assembly.fa.gz"
                                        }
                                    }
                                },
                                "genebuild_providers": {},
                            }
                        },
                    }
                }
            }
            species_json = root / "species.json"
            species_json.write_text(json.dumps(payload), encoding="utf-8")
            manager = DownloadManager(species_json)
            files = manager.get_download_urls("Test_species", "GCA_000001405.29", file_types=["fasta"])

        fasta_files = [f for f in files if f.type == "fasta"]
        self.assertEqual(len(fasta_files), 1)
        self.assertTrue(fasta_files[0].filename.endswith("dna.primary_assembly.fa.gz"))

    def test_new_ftp_structure_download_urls_support_bgz_and_gcf(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            payload = {
                "species": {
                    "Test_species": {
                        "scientific_name": "Test species",
                        "common_name": "Test",
                        "taxid": 1,
                        "species_taxonomy_id": 1,
                        "assemblies": {
                            "GCA_000005845.2": {
                                "name": "ASM584v2",
                                "level": "chromosome",
                                "assembly": {
                                    "files": {
                                        "genome_sequences": {
                                            "softmasked.fa.bgz": "GCA/000/005/845/2/ensembl/2026_01/genome/softmasked.fa.bgz",
                                            "unmasked.fa.bgz": "GCA/000/005/845/2/ensembl/2026_01/genome/unmasked.fa.bgz",
                                        }
                                    }
                                },
                                "genebuild_providers": {
                                    "ensembl": {
                                        "2026_01": {
                                            "paths": {
                                                "genebuild": {
                                                    "files": {
                                                        "annotations": {
                                                            "genes.gff3.gz": "GCA/000/005/845/2/ensembl/2026_01/geneset/genes.gff3.gz"
                                                        }
                                                    }
                                                },
                                                "homologies": {
                                                    "files": {
                                                        "homology_data": {
                                                            "homology.tsv.gz": "GCA/000/005/845/2/ensembl/2026_01/homology/2026_02_20/homology.tsv.gz"
                                                        }
                                                    }
                                                },
                                            }
                                        }
                                    }
                                },
                            },
                            "GCF_021464435.1": {
                                "name": "RefSeqAsm",
                                "level": "chromosome",
                                "assembly": {
                                    "files": {
                                        "genome_sequences": {
                                            "softmasked.fa.bgz": "GCF/021/464/435/1/refseq/2023_04/genome/softmasked.fa.bgz"
                                        }
                                    }
                                },
                                "genebuild_providers": {},
                            },
                        },
                    }
                }
            }
            species_json = root / "species.new_ftp_structure.json"
            species_json.write_text(json.dumps(payload), encoding="utf-8")
            manager = DownloadManager(species_json)
            gca_files = manager.get_download_urls("Test_species", "GCA_000005845.2", file_types=["fasta", "gff3", "homology"])
            gcf_files = manager.get_download_urls("Test_species", "GCF_021464435.1", file_types=["fasta"])

        by_type = {item.type: item for item in gca_files}
        self.assertEqual(by_type["fasta"].filename, "softmasked.fa.bgz")
        self.assertIn("/GCA/000/005/845/2/ensembl/2026_01/genome/softmasked.fa.bgz", by_type["fasta"].url)
        self.assertEqual(by_type["gff3"].filename, "genes.gff3.gz")
        self.assertEqual(by_type["homology"].filename, "homology.tsv.gz")
        self.assertEqual(gcf_files[0].filename, "softmasked.fa.bgz")
        self.assertIn("/GCF/021/464/435/1/refseq/2023_04/genome/softmasked.fa.bgz", gcf_files[0].url)

    def test_gff3_falls_back_to_bgz_when_gz_is_absent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            payload = {
                "species": {
                    "Test_species": {
                        "scientific_name": "Test species",
                        "common_name": "Test",
                        "taxid": 1,
                        "species_taxonomy_id": 1,
                        "assemblies": {
                            "GCA_000005845.2": {
                                "name": "ASM584v2",
                                "level": "chromosome",
                                "assembly": {"files": {"genome_sequences": {}}},
                                "genebuild_providers": {
                                    "ensembl": {
                                        "2026_01": {
                                            "paths": {
                                                "genebuild": {
                                                    "files": {
                                                        "annotations": {
                                                            "genes.gff3.bgz": "GCA/000/005/845/2/ensembl/2026_01/geneset/genes.gff3.bgz"
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                },
                            }
                        },
                    }
                }
            }
            species_json = root / "species.new_ftp_structure.json"
            species_json.write_text(json.dumps(payload), encoding="utf-8")
            manager = DownloadManager(species_json)
            files = manager.get_download_urls("Test_species", "GCA_000005845.2", file_types=["gff3"])

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].filename, "genes.gff3.bgz")
        self.assertTrue(files[0].url.endswith("/GCA/000/005/845/2/ensembl/2026_01/geneset/genes.gff3.bgz"))

    def test_availability_separates_assembly_files_from_dataset_releases(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            payload = {
                "species": {
                    "Test_species": {
                        "scientific_name": "Test species",
                        "common_name": "Test",
                        "taxid": 1,
                        "species_taxonomy_id": 1,
                        "assemblies": {
                            "GCA_000005845.2": {
                                "name": "ASM584v2",
                                "level": "chromosome",
                                "assembly": {
                                    "files": {
                                        "genome_sequences": {
                                            "softmasked.fa.bgz": "GCA/000/005/845/2/ensembl/2025_12/genome/softmasked.fa.bgz"
                                        }
                                    }
                                },
                                "genebuild_providers": {
                                    "ensembl": {
                                        "2025_12": {
                                            "paths": {
                                                "genebuild": {
                                                    "files": {
                                                        "annotations": {
                                                            "cdna.fa.bgz": "GCA/000/005/845/2/ensembl/2025_12/geneset/cdna.fa.bgz",
                                                            "genes.gff3.gz": "GCA/000/005/845/2/ensembl/2025_12/geneset/genes.gff3.gz",
                                                            "pep.fa.bgz": "GCA/000/005/845/2/ensembl/2025_12/geneset/pep.fa.bgz",
                                                            "xref.tsv.gz": "GCA/000/005/845/2/ensembl/2025_12/geneset/xref.tsv.gz",
                                                        }
                                                    }
                                                },
                                                "homologies": {
                                                    "files": {
                                                        "homology_data": {
                                                            "homology.tsv.gz": "GCA/000/005/845/2/ensembl/2025_12/homology/2026_02_20/homology.tsv.gz"
                                                        }
                                                    }
                                                },
                                            }
                                        },
                                        "2024_10": {
                                            "paths": {
                                                "genebuild": {
                                                    "files": {
                                                        "annotations": {
                                                            "genes.gff3.gz": "GCA/000/005/845/2/ensembl/2024_10/geneset/genes.gff3.gz"
                                                        }
                                                    }
                                                }
                                            }
                                        },
                                    }
                                },
                            }
                        },
                    }
                }
            }
            species_json = root / "species.new_ftp_structure.json"
            species_json.write_text(json.dumps(payload), encoding="utf-8")
            manager = DownloadManager(species_json)
            availability = manager.get_file_availability("Test_species", "GCA_000005845.2")

        self.assertEqual(availability["default_dataset_release_key"], "ensembl/2025_12")
        self.assertEqual(availability["assembly_files"][0]["type"], "fasta")
        latest = availability["dataset_releases"][0]
        self.assertEqual(latest["key"], "ensembl/2025_12")
        self.assertEqual({item["type"] for item in latest["files"]}, {"gff3", "cdna", "protein", "xref", "homology"})
        defaults = {item["type"] for item in latest["files"] if item["selected_by_default"]}
        self.assertTrue({"gff3", "cdna", "protein", "xref", "homology"}.issubset(defaults))

    def test_homology_url_falls_back_to_live_export_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = DownloadManager(self._write_species_json(Path(tmpdir)))
            root = "https://ftp.ebi.ac.uk/pub/ensemblorganisms/GCA/000/001/405/29/ensembl/2025_12/homology/"
            stale_url = f"{root}2026_04_09/homology.tsv.gz"

            def directory_entries(url):
                if url == root:
                    return ["2023_10_18/", "md5sum.txt"]
                if url == f"{root}2023_10_18/":
                    return ["homology.tsv.gz"]
                return []

            with patch.object(manager, "_fetch_ftp_directory_entries", side_effect=directory_entries):
                resolved_url = manager._resolve_live_homology_url(stale_url)

        self.assertEqual(resolved_url, f"{root}2023_10_18/homology.tsv.gz")

    def test_availability_includes_pairwise_alignments_for_both_species(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_dir = root / "cache"
            cache_dir.mkdir()
            payload = {
                "species": {
                    "Homo_sapiens": {
                        "scientific_name": "Homo sapiens",
                        "common_name": "Human",
                        "taxid": 9606,
                        "species_taxonomy_id": 9606,
                        "assemblies": {
                            "GCA_111111111.1": {
                                "name": "GRCh38",
                                "level": "chromosome",
                                "gca": "GCA_111111111.1",
                                "equivalent_accessions": ["GCF_111111111.1"],
                                "assembly": {"files": {"genome_sequences": {}}},
                                "genebuild_providers": {},
                            }
                        },
                    },
                    "Bos_mutus": {
                        "scientific_name": "Bos mutus",
                        "common_name": "Wild yak",
                        "taxid": 72004,
                        "species_taxonomy_id": 72004,
                        "assemblies": {
                            "GCA_000298355.1": {
                                "name": "BosGru_v2.0",
                                "level": "chromosome",
                                "gca": "GCA_000298355.1",
                                "equivalent_accessions": ["GCF_000298355.1"],
                                "assembly": {"files": {"genome_sequences": {}}},
                                "genebuild_providers": {},
                            }
                        },
                    },
                }
            }
            species_json = root / "species.new_ftp_structure.json"
            species_json.write_text(json.dumps(payload), encoding="utf-8")
            manifest = cache_dir / "pairwise_alignments.release-116.tsv"
            manifest.write_text(
                "\t".join([
                    "release",
                    "alignment_id",
                    "method_link_species_set_id",
                    "alignment_type",
                    "ftp_filename",
                    "ftp_url",
                    "species_1_species_name",
                    "species_1_compara_name",
                    "species_1_assembly_name",
                    "species_1_gca",
                    "species_1_gcf",
                    "species_1_primary_accession",
                    "species_1_equivalent_accessions",
                    "species_1_species_key",
                    "species_2_species_name",
                    "species_2_compara_name",
                    "species_2_assembly_name",
                    "species_2_gca",
                    "species_2_gcf",
                    "species_2_primary_accession",
                    "species_2_equivalent_accessions",
                    "species_2_species_key",
                ])
                + "\n"
                + "\t".join([
                    "116",
                    "align123",
                    "1202",
                    "LASTZ_NET",
                    "hsap_grch38.v.bmut_bosgru_v2.0.lastz_net.tar.gz",
                    "https://ftp.ensembl.org/pub/release-116/maf/ensembl-compara/pairwise_alignments/hsap_grch38.v.bmut_bosgru_v2.0.lastz_net.tar.gz",
                    "Homo sapiens",
                    "homo_sapiens",
                    "GRCh38",
                    "GCA_111111111.1",
                    "GCF_111111111.1",
                    "GCA_111111111.1",
                    "GCF_111111111.1",
                    "Homo_sapiens",
                    "Bos mutus",
                    "bos_mutus",
                    "BosGru_v1.0",
                    "",
                    "",
                    "",
                    "",
                    "",
                ])
                + "\n",
                encoding="utf-8",
            )

            manager = DownloadManager(species_json, cache_dir=cache_dir)
            with patch.object(manager, "_get_metadata_file_info", return_value=None):
                human_availability = manager.get_file_availability("Homo_sapiens", "GCA_111111111.1")
                yak_availability = manager.get_file_availability("Bos_mutus", "GCA_000298355.1")

        human_release = next(item for item in human_availability["dataset_releases"] if item["source"] == "ensembl_compara")
        yak_release = next(item for item in yak_availability["dataset_releases"] if item["source"] == "ensembl_compara")
        human_file = human_release["files"][0]
        yak_file = yak_release["files"][0]

        self.assertEqual(human_file["type"], "alignment")
        self.assertEqual(human_file["alignment_type"], "LASTZ_NET")
        self.assertEqual(human_file["other_species_name"], "Bos mutus")
        self.assertEqual(human_file["other_species_gca"], "GCA_000298355.1")
        self.assertEqual(yak_file["other_species_name"], "Homo sapiens")
        self.assertEqual(yak_file["other_species_gca"], "GCA_111111111.1")
        self.assertEqual(yak_file["filename"], human_file["filename"])

    def test_catalog_status_warns_for_legacy_path_layout(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            payload = {
                "species": {
                    "Test_species": {
                        "scientific_name": "Test species",
                        "common_name": "Test",
                        "taxid": 1,
                        "species_taxonomy_id": 1,
                        "assemblies": {
                            "GCA_000005845.2": {
                                "name": "ASM584v2",
                                "level": "chromosome",
                                "assembly": {
                                    "files": {
                                        "genome_sequences": {
                                            "softmasked.fa.gz": "Test_species/GCA_000005845.2/genome/softmasked.fa.gz"
                                        }
                                    }
                                },
                                "genebuild_providers": {},
                            }
                        },
                    }
                }
            }
            species_json = root / "species.json"
            species_json.write_text(json.dumps(payload), encoding="utf-8")
            manager = DownloadManager(species_json)
            status = manager.get_catalog_status()

        self.assertEqual(status["current_catalog_format"], "legacy_or_unknown")
        self.assertTrue(status["catalog_warnings"])

    def test_remote_catalog_prefers_new_structure_url(self):
        payload = {"last_updated": "2026-06-25T00:00:00", "species": {}}
        calls = []

        def fake_get(url, timeout=20):
            del timeout
            calls.append(url)
            return _FakeJsonResponse(payload, url=url)

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            species_json = root / "species.json"
            species_json.write_text(json.dumps({"species": {}}), encoding="utf-8")
            manager = DownloadManager(species_json, cache_dir=root / "cache")
            # A successful refresh goes on to refresh the species-name policy,
            # which POSTs to the NCBI datasets API. Only requests.get is faked
            # here, so leaving it live would make this test hit the network and
            # hang. The policy refresh has its own coverage in
            # test_species_name_policy.py; what matters here is the catalogue URL.
            with patch("download_manager.requests.get", side_effect=fake_get), \
                    patch.object(manager, "refresh_species_name_policy"):
                manager.refresh_catalog(force=True)

        self.assertEqual(calls, [ENSEMBL_SPECIES_CATALOG_NEW_URL])

    def test_remote_catalog_falls_back_to_legacy_only_when_new_is_missing(self):
        payload = {"last_updated": "2026-06-04T00:00:00", "species": {}}
        calls = []

        def fake_get(url, timeout=20):
            del timeout
            calls.append(url)
            if url == ENSEMBL_SPECIES_CATALOG_NEW_URL:
                return _FakeJsonResponse({}, status_code=404, url=url)
            return _FakeJsonResponse(payload, url=url)

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            species_json = root / "species.json"
            species_json.write_text(json.dumps({"species": {}}), encoding="utf-8")
            manager = DownloadManager(species_json, cache_dir=root / "cache")
            with patch("download_manager.requests.get", side_effect=fake_get), \
                    patch.object(manager, "refresh_species_name_policy"):
                status = manager.refresh_catalog(force=True)

        self.assertEqual(calls, [ENSEMBL_SPECIES_CATALOG_NEW_URL, ENSEMBL_SPECIES_CATALOG_LEGACY_URL])
        self.assertEqual(status["current_catalog_url"], ENSEMBL_SPECIES_CATALOG_LEGACY_URL)
        self.assertEqual(status["current_catalog_source"], "remote_url_fallback")

    def test_remote_catalog_explicit_url_override_wins(self):
        payload = {"last_updated": "2026-06-25T00:00:00", "species": {}}
        calls = []
        override_url = "https://example.invalid/custom-species.json"

        def fake_get(url, timeout=20):
            del timeout
            calls.append(url)
            return _FakeJsonResponse(payload, url=url)

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            species_json = root / "species.json"
            species_json.write_text(json.dumps({"species": {}}), encoding="utf-8")
            manager = DownloadManager(species_json, cache_dir=root / "cache", catalog_source_url=override_url)
            with patch("download_manager.requests.get", side_effect=fake_get), \
                    patch.object(manager, "refresh_species_name_policy"):
                status = manager.refresh_catalog(force=True)

        self.assertEqual(calls, [override_url])
        self.assertEqual(status["current_catalog_url"], override_url)

    def test_metadata_discovery_failure_is_non_blocking(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            species_json = self._write_species_json(Path(tmpdir))
            manager = DownloadManager(species_json)
            with patch.object(manager, "_get_metadata_file_info", side_effect=RuntimeError("boom")):
                files = manager.get_download_urls("Test_species", "GCA_000001405.29")

        self.assertTrue(any(f.type == "fasta" for f in files))

    def test_metadata_discovery_is_cached(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            species_json = self._write_species_json(Path(tmpdir))
            manager = DownloadManager(species_json)
            with patch.object(
                manager,
                "_discover_ncbi_assembly_report",
                return_value={"url": "https://example/assembly_report.txt", "filename": "assembly_report.txt"},
            ) as discover:
                first = manager._get_metadata_file_info("GCA_000001405.29")
                second = manager._get_metadata_file_info("GCA_000001405.29")

        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertEqual(discover.call_count, 1)

    def test_build_ncbi_species_summaries_groups_and_prefers_refseq(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            species_json = self._write_species_json(Path(tmpdir))
            manager = DownloadManager(species_json)
            payload = {
                "reports": [
                    {
                        "accession": "GCA_000001405.29",
                        "paired_accession": "GCF_000001405.40",
                        "source_database": "SOURCE_DATABASE_GENBANK",
                        "organism": {
                            "organism_name": "Homo sapiens",
                            "common_name": "human",
                            "tax_id": 9606,
                        },
                        "assembly_info": {
                            "assembly_name": "GRCh38.p14",
                            "assembly_level": "Chromosome",
                        },
                    },
                    {
                        "accession": "GCF_000001405.40",
                        "paired_accession": "GCA_000001405.29",
                        "source_database": "SOURCE_DATABASE_REFSEQ",
                        "organism": {
                            "organism_name": "Homo sapiens",
                            "common_name": "human",
                            "tax_id": 9606,
                        },
                        "assembly_info": {
                            "assembly_name": "GRCh38.p14",
                            "assembly_level": "Chromosome",
                        },
                    },
                ]
            }

            summaries = manager._build_ncbi_species_summaries(payload)

        self.assertEqual(len(summaries), 1)
        summary = summaries[0]
        self.assertEqual(summary.provider, "ncbi")
        self.assertEqual(summary.key, "Homo_sapiens")
        self.assertEqual(summary.group, "Mammals")
        self.assertEqual(summary.sub_group, "Primates")
        self.assertEqual([asm.accession for asm in summary.assemblies], ["GCF_000001405.40", "GCA_000001405.29"])
        self.assertEqual(summary.assemblies[0].source_database, "RefSeq")
        self.assertEqual(summary.assemblies[0].equivalent_accessions, ["GCA_000001405.29"])
        self.assertEqual(summary.assemblies[1].source_database, "GenBank")
        self.assertEqual(summary.assemblies[1].equivalent_accessions, ["GCF_000001405.40"])

    def test_ncbi_download_urls_use_dehydrated_bundle_and_requested_types(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            species_json = self._write_species_json(Path(tmpdir))
            manager = DownloadManager(species_json)
            files = manager.get_download_urls(
                "Mus_musculus",
                "GCA_000001635.9",
                file_types=["gff3"],
                provider="ncbi",
            )

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].type, "gff3")
        query = parse_qs(urlparse(files[0].url).query)
        self.assertEqual(query.get("hydrated"), ["DATA_REPORT_ONLY"])
        self.assertEqual(query.get("include_annotation_type"), ["GENOME_GFF"])

    def test_parse_ncbi_fetch_entries_reads_referenced_file_urls(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            species_json = self._write_species_json(Path(tmpdir))
            manager = DownloadManager(species_json)
            bundle = Path(tmpdir) / "ncbi_dataset.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr(
                    "ncbi_dataset/data/dataset_catalog.json",
                    json.dumps({
                        "assemblies": [
                            {
                                "accession": "GCA_000001405.29",
                                "files": [
                                    {
                                        "filePath": "GCA_000001405.29/genomic.gff",
                                        "fileType": "GFF3",
                                        "uncompressedLengthBytes": "1234",
                                    },
                                    {
                                        "filePath": "GCA_000001405.29/GCA_000001405.29_GRCh38.p14_genomic.fna",
                                        "fileType": "GENOME_FASTA",
                                        "uncompressedLengthBytes": "5678",
                                    },
                                ],
                            }
                        ]
                    }),
                )
                archive.writestr(
                    "ncbi_dataset/fetch.txt",
                    "\n".join([
                        "https://example.invalid/genomic.gff\t0\tdata/GCA_000001405.29/genomic.gff",
                        "https://example.invalid/genomic.fna\t0\tdata/GCA_000001405.29/GCA_000001405.29_GRCh38.p14_genomic.fna",
                    ]),
                )

            entries = manager._parse_ncbi_fetch_entries(bundle)

        self.assertEqual(
            entries,
            [
                {
                    "url": "https://example.invalid/genomic.gff",
                    "path": "data/GCA_000001405.29/genomic.gff",
                    "kind": "gff3",
                    "expected_size": 1234,
                },
                {
                    "url": "https://example.invalid/genomic.fna",
                    "path": "data/GCA_000001405.29/GCA_000001405.29_GRCh38.p14_genomic.fna",
                    "kind": "fasta",
                    "expected_size": 5678,
                },
            ],
        )

    def test_featured_ncbi_species_prefers_paired_refseq_records(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            species_json = self._write_species_json(Path(tmpdir))
            manager = DownloadManager(species_json)
            payload = {
                "reports": [
                    {
                        "accession": "GCF_000001635.27",
                        "paired_accession": "GCA_000001635.9",
                        "source_database": "SOURCE_DATABASE_REFSEQ",
                        "organism": {
                            "organism_name": "Mus musculus",
                            "common_name": "house mouse",
                            "tax_id": 10090,
                        },
                        "assembly_info": {
                            "assembly_name": "GRCm39",
                            "assembly_level": "Chromosome",
                        },
                    }
                ],
                "total_count": 1,
            }
            with patch.object(manager, "_post_ncbi_dataset_report", return_value=payload) as mocked:
                result = manager.list_featured_ncbi_species()

        request_payload = mocked.call_args.args[0]
        self.assertTrue(request_payload["filters"]["exclude_paired_reports"])
        self.assertGreater(len(request_payload["accessions"]), 5)
        self.assertEqual(result["species"][0].assemblies[0].accession, "GCF_000001635.27")


class DownloadValidationTests(unittest.TestCase):
    def _build_manager_with_task(self, tmpdir: Path, destination_name: str) -> tuple:
        species_json = DownloadManagerMetadataTests()._write_species_json(tmpdir)
        manager = DownloadManager(species_json)
        destination = tmpdir / destination_name
        task_id = "task-1"
        manager.tasks[task_id] = DownloadTask(
            id=task_id,
            filename=destination.name,
            url="https://example.invalid/file.txt",
            species_key="Test_species",
            assembly="GCA_000001405.29",
            file_type="metadata",
            status="pending",
            destination=str(destination),
        )
        return manager, task_id, destination

    def test_download_allows_size_difference_when_content_encoded(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager, task_id, destination = self._build_manager_with_task(Path(tmp), "encoded.txt")
            response = _FakeResponse(
                [b"0123456789ABCDEF"],
                headers={"content-length": "10", "content-encoding": "gzip"},
            )
            with patch("download_manager.requests.get", return_value=response):
                asyncio.run(manager.download_file("https://ftp.ebi.ac.uk/pub/ensemblorganisms/test/file.txt", destination, task_id))

            task = manager.tasks[task_id]
            self.assertEqual(task.status, "completed")
            self.assertTrue(destination.exists())
            self.assertEqual(destination.read_bytes(), b"0123456789ABCDEF")

    def test_download_cancelled_before_start_does_not_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager, task_id, destination = self._build_manager_with_task(Path(tmp), "cancelled.txt")
            manager.tasks[task_id].cancel_requested = True

            with patch("download_manager.requests.get") as mocked_get:
                asyncio.run(manager.download_file("https://ftp.ebi.ac.uk/pub/ensemblorganisms/test/file.txt", destination, task_id))

            task = manager.tasks[task_id]
            self.assertEqual(task.status, "canceled")
            self.assertFalse(destination.exists())
            mocked_get.assert_not_called()

    def test_download_still_fails_on_identity_size_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager, task_id, destination = self._build_manager_with_task(Path(tmp), "identity.txt")
            response = _FakeResponse(
                [b"0123456789ABCDEF"],
                headers={"content-length": "10"},
            )
            with patch("download_manager.requests.get", return_value=response):
                asyncio.run(manager.download_file("https://ftp.ebi.ac.uk/pub/ensemblorganisms/test/file.txt", destination, task_id))

            task = manager.tasks[task_id]
            self.assertEqual(task.status, "failed")
            self.assertIn("Download size mismatch", task.error or "")
            self.assertFalse(destination.exists())

    def test_fasta_softmasked_404_falls_back_to_unmasked_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            species_json = DownloadManagerMetadataTests()._write_species_json(Path(tmp))
            manager = DownloadManager(species_json)
            destination = Path(tmp) / "GCA_009914755.4.softmasked.fa.gz"
            task_id = "task-fasta-fallback"
            softmasked_url = "https://ftp.ebi.ac.uk/pub/ensemblorganisms/Homo_sapiens/GCA_009914755.4/genome/softmasked.fa.gz"
            manager.tasks[task_id] = DownloadTask(
                id=task_id,
                filename=destination.name,
                url=softmasked_url,
                species_key="Homo_sapiens",
                assembly="GCA_009914755.4",
                file_type="fasta",
                status="pending",
                destination=str(destination),
            )

            first = _FakeHttpErrorResponse(status_code=404, url=softmasked_url)
            second = _FakeResponse(
                [b"\x1f\x8bFAKE"],
                headers={"content-length": "6"},
                status_code=200,
            )
            with patch("download_manager.requests.get", side_effect=[first, second]):
                asyncio.run(manager.download_file(softmasked_url, destination, task_id))

            task = manager.tasks[task_id]
            self.assertEqual(task.status, "completed")
            self.assertTrue(destination.exists())
            self.assertTrue("unmasked" in (task.url or ""))
            self.assertIn("unmasked FASTA", task.warning or "")
            self.assertEqual(destination.read_bytes(), b"\x1f\x8bFAKE")

    def test_ncbi_dehydrated_bundle_downloads_fetch_h_gff(self):
        with tempfile.TemporaryDirectory() as tmp:
            species_json = DownloadManagerMetadataTests()._write_species_json(Path(tmp))
            manager = DownloadManager(species_json)
            assembly = "GCF_002007445.2"
            destination = Path(tmp) / f"{assembly}.ncbi_dataset_gff3.zip"
            task_id = "task-ncbi-gff"
            ncbi_url = (
                f"https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/{assembly}/download"
                "?include_annotation_type=GENOME_GFF&hydrated=DATA_REPORT_ONLY&filename=ncbi_dataset.zip"
            )
            fetch_url = "https://api.ncbi.nlm.nih.gov/datasets/fetch_h/R2V0UmVtb3RlRGF0YWZpbGU/eNqTyufKzUtOytROKymw0tdPT83Lz00t1k"
            manager.tasks[task_id] = DownloadTask(
                id=task_id,
                filename=destination.name,
                url=ncbi_url,
                species_key="Ailuropoda_melanoleuca",
                assembly=assembly,
                provider="ncbi",
                file_type="gff3",
                status="pending",
                destination=str(destination),
            )

            bundle_io = io.BytesIO()
            with zipfile.ZipFile(bundle_io, "w") as archive:
                archive.writestr(
                    "ncbi_dataset/data/dataset_catalog.json",
                    json.dumps({
                        "assemblies": [
                            {
                                "accession": assembly,
                                "files": [
                                    {
                                        "filePath": f"{assembly}/genomic.gff",
                                        "fileType": "GFF3",
                                        "uncompressedLengthBytes": "16",
                                    }
                                ],
                            }
                        ]
                    }),
                )
                archive.writestr(
                    "ncbi_dataset/fetch.txt",
                    f"{fetch_url}\t0\tdata/{assembly}/genomic.gff\n",
                )
            bundle_bytes = bundle_io.getvalue()
            gff_bytes = b"##gff-version 3\n"

            bundle_response = _FakeResponse(
                [bundle_bytes],
                headers={"content-length": str(len(bundle_bytes))},
                status_code=200,
            )
            gff_response = _FakeResponse(
                [gff_bytes],
                headers={"content-length": str(len(gff_bytes))},
                status_code=200,
            )
            with patch("download_manager.requests.get", side_effect=[bundle_response, gff_response]) as mocked_get:
                with patch.object(manager, "_wait_for_ncbi_api_slot"):
                    asyncio.run(manager.download_file(ncbi_url, destination, task_id))

            task = manager.tasks[task_id]
            hydrated_gff = destination.parent / f"{assembly}.genomic.gff"
            self.assertEqual(task.status, "completed")
            self.assertEqual(mocked_get.call_count, 2)
            self.assertTrue(hydrated_gff.exists())
            self.assertEqual(hydrated_gff.read_bytes(), gff_bytes)
            self.assertFalse(destination.exists())

    def test_ncbi_api_download_retries_429(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager, task_id, destination = self._build_manager_with_task(Path(tmp), "sequence_report.json")
            ncbi_url = (
                "https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/GCF_002263795.3/"
                "sequence_reports?page_size=1000"
            )
            first = _FakeHttpErrorResponse(status_code=429, url=ncbi_url, headers={"Retry-After": "0"})
            second = _FakeResponse([b"{\"reports\":[]}"], headers={"content-length": "14"}, status_code=200)

            with patch("download_manager.requests.get", side_effect=[first, second]) as mocked_get:
                with patch("download_manager.time.sleep") as mocked_sleep:
                    asyncio.run(manager.download_file(ncbi_url, destination, task_id))

            task = manager.tasks[task_id]
            self.assertEqual(task.status, "completed")
            self.assertEqual(mocked_get.call_count, 2)
            mocked_sleep.assert_called()
            self.assertEqual(destination.read_bytes(), b"{\"reports\":[]}")

    def test_ncbi_api_download_waits_for_rate_limit_slot(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager, task_id, destination = self._build_manager_with_task(Path(tmp), "sequence_report.json")
            ncbi_url = (
                "https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/GCF_002263795.3/"
                "sequence_reports?page_size=1000"
            )
            response = _FakeResponse([b"{\"reports\":[]}"], headers={"content-length": "14"}, status_code=200)

            with patch.object(manager, "_wait_for_ncbi_api_slot") as mocked_slot:
                with patch("download_manager.requests.get", return_value=response):
                    asyncio.run(manager.download_file(ncbi_url, destination, task_id))

            self.assertEqual(manager.tasks[task_id].status, "completed")
            mocked_slot.assert_called_once()


if __name__ == "__main__":
    unittest.main()

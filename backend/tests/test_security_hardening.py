import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from main import (  # noqa: E402
    DeleteSingleFileRequest,
    SaveExportRequest,
    _validate_download_url,
    _validate_trackhub_data_url,
    delete_single_local_file,
    save_export_file,
)
from security_utils import (  # noqa: E402
    ensure_http_response_url_allowed,
    validate_backend_bind_host,
    validate_remote_download_url,
)


class BackendSecurityMiddlewareTests(unittest.TestCase):
    def _request(self, path="/api/config", headers=None, method="GET", client_host="127.0.0.1"):
        return SimpleNamespace(
            url=SimpleNamespace(path=path),
            headers=headers or {},
            method=method,
            client=SimpleNamespace(host=client_host),
        )

    async def _call_middleware(self, request):
        async def call_next(_request):
            return SimpleNamespace(status_code=200)

        return await main.enforce_local_origin(request, call_next)

    def test_health_is_public_but_api_requires_token_when_configured(self):
        with patch.object(main, "API_TOKEN", "secret"):
            self.assertEqual(asyncio.run(self._call_middleware(self._request("/api/health"))).status_code, 200)
            self.assertEqual(asyncio.run(self._call_middleware(self._request("/api/config"))).status_code, 401)
            self.assertEqual(
                asyncio.run(
                    self._call_middleware(
                        self._request("/api/config", headers={"x-ensembl-local-token": "wrong"})
                    )
                ).status_code,
                401,
            )
            self.assertEqual(
                asyncio.run(
                    self._call_middleware(
                        self._request("/api/config", headers={"x-ensembl-local-token": "secret"})
                    )
                ).status_code,
                200,
            )

    def test_non_local_origin_is_rejected_before_token(self):
        with patch.object(main, "API_TOKEN", "secret"):
            response = asyncio.run(
                self._call_middleware(
                    self._request(
                        "/api/config",
                        headers={"origin": "https://example.org", "x-ensembl-local-token": "secret"},
                    )
                )
            )
            self.assertEqual(response.status_code, 403)

    def test_non_loopback_bind_requires_explicit_opt_in(self):
        with patch.dict(os.environ, {"ENSEMBL_LOCAL_ALLOW_NON_LOOPBACK": ""}):
            with self.assertRaises(SystemExit):
                validate_backend_bind_host("0.0.0.0")

        with patch.dict(os.environ, {"ENSEMBL_LOCAL_ALLOW_NON_LOOPBACK": "1"}):
            self.assertEqual(validate_backend_bind_host("0.0.0.0"), "0.0.0.0")


class FilesystemHardeningTests(unittest.TestCase):
    def test_delete_single_file_must_stay_inside_managed_assembly_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            outside = root / "outside.txt"
            outside.write_text("do not delete", encoding="utf-8")
            request = DeleteSingleFileRequest(
                file_path=str(outside),
                output_dir=str(root),
                species_key="species_a",
                assembly="ASM1",
            )

            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(delete_single_local_file(request))

            self.assertEqual(ctx.exception.status_code, 400)
            self.assertTrue(outside.exists())

    def test_delete_single_file_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            asm_dir = root / "local_data" / "species_a" / "ASM1"
            asm_dir.mkdir(parents=True)
            outside = root / "outside.txt"
            outside.write_text("do not delete", encoding="utf-8")
            link = asm_dir / "linked.txt"
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks are not available on this filesystem")

            request = DeleteSingleFileRequest(
                file_path=str(link),
                output_dir=str(root),
                species_key="species_a",
                assembly="ASM1",
            )

            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(delete_single_local_file(request))

            self.assertEqual(ctx.exception.status_code, 400)
            self.assertTrue(outside.exists())

    def test_export_filename_must_be_a_leaf(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            request = SaveExportRequest(
                directory=tmpdir,
                filename="../bad.svg",
                format="svg",
                encoding="utf8",
                data="<svg />",
            )
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(save_export_file(request))
            self.assertEqual(ctx.exception.status_code, 400)


class UrlHardeningTests(unittest.TestCase):
    def test_remote_download_url_allows_known_hosts_only(self):
        allowed = "https://ftp.ebi.ac.uk/pub/ensemblorganisms/species/file.fa.gz"
        self.assertEqual(_validate_download_url(allowed), allowed)
        pairwise_alignment = (
            "https://ftp.ensembl.org/pub/release-116/maf/ensembl-compara/"
            "pairwise_alignments/hsap_grch38.v.abra_asm259213v1.lastz_net.tar.gz"
        )
        self.assertEqual(_validate_download_url(pairwise_alignment), pairwise_alignment)
        ncbi_refseq = "https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/001/635/GCF_000001635.27/file.fa.gz"
        self.assertEqual(_validate_download_url(ncbi_refseq), ncbi_refseq)
        ncbi_datasets_fasta = (
            "https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/GCF_002263795.3/download"
            "?include_annotation_type=GENOME_FASTA&hydrated=DATA_REPORT_ONLY&filename=ncbi_dataset.zip"
        )
        self.assertEqual(_validate_download_url(ncbi_datasets_fasta), ncbi_datasets_fasta)
        ncbi_datasets_gff = (
            "https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/GCF_029378745.1/download"
            "?include_annotation_type=GENOME_GFF&hydrated=DATA_REPORT_ONLY&filename=ncbi_dataset.zip"
        )
        self.assertEqual(_validate_download_url(ncbi_datasets_gff), ncbi_datasets_gff)
        ncbi_sequence_report = (
            "https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/GCF_002263795.3/"
            "sequence_reports?page_size=1000"
        )
        self.assertEqual(_validate_download_url(ncbi_sequence_report), ncbi_sequence_report)
        ncbi_fetch_h = (
            "https://api.ncbi.nlm.nih.gov/datasets/fetch_h/"
            "R2V0UmVtb3RlRGF0YWZpbGU/eNqTyufKzUtOytROKymw0tdPT83Lz00t1k"
        )
        self.assertEqual(_validate_download_url(ncbi_fetch_h), ncbi_fetch_h)

        with self.assertRaises(HTTPException):
            _validate_download_url("https://example.org/file.fa.gz")
        with self.assertRaises(HTTPException):
            _validate_download_url("https://ftp.ensembl.org/pub/release-116/README")
        with self.assertRaises(HTTPException):
            _validate_download_url("https://api.ncbi.nlm.nih.gov/datasets/v2/genome/taxon/9913/download")
        with self.assertRaises(HTTPException):
            _validate_download_url("https://api.ncbi.nlm.nih.gov/datasets/fetch_h/../bad")

    def test_remote_download_redirects_are_revalidated(self):
        original = "https://ftp.ebi.ac.uk/pub/ensemblorganisms/species/file.fa.gz"
        with self.assertRaises(HTTPException):
            ensure_http_response_url_allowed(original, "https://127.0.0.1/file.fa.gz", validate_remote_download_url)

    def test_trackhub_rejects_private_hosts_and_credentials(self):
        with self.assertRaises(HTTPException):
            _validate_trackhub_data_url("https://127.0.0.1/track.bw")
        with self.assertRaises(HTTPException):
            _validate_trackhub_data_url("https://user:pass@example.org/track.bw")

        self.assertEqual(
            _validate_trackhub_data_url("http://example.org/track.bw"),
            "https://example.org/track.bw",
        )

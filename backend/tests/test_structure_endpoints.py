"""The structure routes: token handling, caching, and the viewer's asset surface.

The middleware tests here guard a deliberate exception. Every other route on this
backend takes its API token from a header, but the structure viewer is loaded as
an iframe and then fetches its own bundle and model file — none of which can
carry a header — so ``/structure/*`` reads the token from the query string
instead. That exception has to stay confined to that one prefix, which is what
most of these assert.
"""

import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
import protein_structure as ps  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def request(path, *, query=None, headers=None, method="GET", client_host="127.0.0.1"):
    return SimpleNamespace(
        url=SimpleNamespace(path=path),
        query_params=query or {},
        headers=headers or {},
        method=method,
        client=SimpleNamespace(host=client_host),
    )


async def call_middleware(req):
    async def call_next(_request):
        return SimpleNamespace(status_code=200)

    return await main.enforce_local_origin(req, call_next)


class StructureTokenTests(unittest.TestCase):
    def test_viewer_routes_accept_the_token_from_the_query_string(self):
        with patch.object(main, "API_TOKEN", "secret"):
            for path in ("/structure/viewer", "/structure/assets/viewer.js", "/structure/model/O43175"):
                allowed = asyncio.run(call_middleware(request(path, query={"token": "secret"})))
                self.assertEqual(allowed.status_code, 200, path)

                refused = asyncio.run(call_middleware(request(path, query={"token": "wrong"})))
                self.assertEqual(refused.status_code, 401, path)

                missing = asyncio.run(call_middleware(request(path)))
                self.assertEqual(missing.status_code, 401, path)

    def test_the_query_token_does_not_work_anywhere_else(self):
        # The whole point of confining it to one prefix: a link or a referer leak
        # must not turn into a working credential for the rest of the API.
        with patch.object(main, "API_TOKEN", "secret"):
            response = asyncio.run(call_middleware(request("/api/config", query={"token": "secret"})))
            self.assertEqual(response.status_code, 401)

    def test_the_header_token_is_not_accepted_on_the_viewer_prefix(self):
        with patch.object(main, "API_TOKEN", "secret"):
            response = asyncio.run(call_middleware(
                request("/structure/viewer", headers={"x-ensembl-local-token": "secret"})
            ))
            self.assertEqual(response.status_code, 401)

    def test_a_non_local_origin_is_refused_before_the_token_is_examined(self):
        with patch.object(main, "API_TOKEN", "secret"):
            response = asyncio.run(call_middleware(
                request("/structure/viewer", query={"token": "secret"},
                        headers={"origin": "https://example.org"})
            ))
            self.assertEqual(response.status_code, 403)

    def test_no_token_configured_means_no_token_required(self):
        with patch.object(main, "API_TOKEN", ""):
            self.assertEqual(asyncio.run(call_middleware(request("/structure/viewer"))).status_code, 200)

    def test_non_loopback_clients_are_refused_outright(self):
        with self.assertRaises(HTTPException):
            asyncio.run(call_middleware(request("/structure/viewer", client_host="10.0.0.4")))


class ViewerAssetTests(unittest.TestCase):
    def test_the_viewer_page_declares_its_own_policy_and_carries_the_token(self):
        with patch.object(main, "API_TOKEN", "s3cret"):
            response = asyncio.run(main.structure_viewer_page())

        csp = response.headers["content-security-policy"]
        self.assertIn("'unsafe-eval'", csp)
        # Mol* instantiates WebAssembly from a data: URI through fetch.
        self.assertIn("connect-src 'self' data:", csp)
        self.assertEqual(response.headers["cache-control"], "no-store")

        body = response.body.decode()
        self.assertNotIn("__STRUCTURE_QUERY__", body)
        self.assertIn("?token=s3cret", body)

    def test_the_app_and_viewer_policies_stay_different(self):
        # 'unsafe-eval' is granted to the sandboxed viewer alone; the renderer,
        # which holds the Electron bridge, must never gain it.
        app_csp = (Path(__file__).resolve().parents[2] / "frontend" / "index.html").read_text()
        self.assertNotIn("unsafe-eval", app_csp)
        self.assertIn("frame-src http://127.0.0.1:*", app_csp)

    def test_asset_names_may_not_traverse_or_carry_an_unknown_type(self):
        for name in ("../main.py", "vendor/pdbe-molstar.css", "viewer.py", "secrets.json"):
            with self.assertRaises(HTTPException, msg=name):
                asyncio.run(main.structure_viewer_asset(name))

    def test_the_hand_written_viewer_files_are_served(self):
        for name in ("viewer.js", "viewer.css"):
            response = asyncio.run(main.structure_viewer_asset(name))
            self.assertEqual(Path(response.path).name, name)

    def test_a_bad_accession_is_refused_before_any_lookup(self):
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(main.structure_model_file("not-an-accession"))
        self.assertEqual(caught.exception.status_code, 400)


class ModelCacheTests(unittest.TestCase):
    def test_a_cached_model_is_not_downloaded_again(self):
        model = ps.AlphaFoldModel(accession="O43175", version=6, sequence="MA")
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            destination = cache / ps.model_cache_filename("O43175", 6)
            destination.write_text("data_AF\n")

            with patch.object(main, "_structure_cache_dir", return_value=cache):
                with patch.object(main, "get_with_validated_redirects") as fetch:
                    self.assertEqual(main._ensure_model_file(model), destination)
                    fetch.assert_not_called()

    def test_a_download_that_fails_leaves_no_partial_file(self):
        # A truncated mmCIF would be cached and then fail to parse on every load,
        # so the temp file has to go when the transfer does not complete.
        model = ps.AlphaFoldModel(accession="O43175", version=6, sequence="MA")
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)

            class Failing:
                status_code = 200
                def __enter__(self): return self
                def __exit__(self, *_): return False
                def raise_for_status(self): return None
                def iter_content(self, chunk_size=0):
                    yield b"data_AF"
                    raise OSError("connection reset")

            with patch.object(main, "_structure_cache_dir", return_value=cache):
                with patch.object(main, "get_with_validated_redirects", return_value=Failing()):
                    with self.assertRaises(OSError):
                        main._ensure_model_file(model)

            self.assertEqual(sorted(p.name for p in cache.iterdir()), [])

    def test_an_oversized_model_is_refused_and_cleaned_up(self):
        model = ps.AlphaFoldModel(accession="O43175", version=6, sequence="MA")
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)

            class Huge:
                status_code = 200
                def __enter__(self): return self
                def __exit__(self, *_): return False
                def raise_for_status(self): return None
                def iter_content(self, chunk_size=0):
                    while True:
                        yield b"x" * (1024 * 1024)

            with patch.object(main, "_structure_cache_dir", return_value=cache):
                with patch.object(main, "MAX_STRUCTURE_MODEL_BYTES", 4 * 1024 * 1024):
                    with patch.object(main, "get_with_validated_redirects", return_value=Huge()):
                        with self.assertRaises(HTTPException):
                            main._ensure_model_file(model)

            self.assertEqual(sorted(p.name for p in cache.iterdir()), [])


def vcf_record(pos, ref, alts, variant_id=""):
    """The parts of a pysam VariantRecord the projection actually reads."""
    return SimpleNamespace(
        pos=pos,
        ref=ref,
        alts=tuple(alts),
        id=variant_id,
        stop=pos + len(ref) - 1,
        info={},
    )


class VariantProjectionTests(unittest.TestCase):
    """Genomic variant -> codon -> residue.

    The consequence is recomputed from the CDS rather than read out of a CSQ or
    ANN field, which means the reading frame, the strand and the padded CDS
    coordinate space all have to be right or the answer is silently wrong. These
    pin each of those.
    """

    # One coding exon: genomic 100-108 carrying ATG CGA ACC -> M R T.
    SEGMENTS = [{
        "coord_start": 1, "coord_end": 9,
        "genomic_start": 100, "genomic_end": 108, "phase": 0,
    }]
    DNA = "ATGCGAACC"
    MAP = {1: 1, 2: 2, 3: 3}

    def project(self, rec, strand="+", segments=None, dna=None, mapping=None):
        return main._structure_variant_from_record(
            rec, "trk", "chr1", strand, 1,
            segments if segments is not None else self.SEGMENTS,
            0,
            dna if dna is not None else self.DNA,
            mapping if mapping is not None else self.MAP,
        )

    def test_a_forward_strand_snv_lands_on_the_right_residue(self):
        # Genomic 104 is CDS coord 5: the middle base of codon two (CGA -> R).
        variant = self.project(vcf_record(104, "G", ["T"]))
        self.assertEqual(variant.aa_index, 2)
        self.assertEqual(variant.model_residue, 2)
        self.assertEqual((variant.ref_aa, variant.alt_aa), ("R", "L"))
        self.assertEqual(variant.consequence, "missense")
        self.assertEqual(variant.impact, "missense")
        self.assertFalse(variant.ref_mismatch)

    def test_a_synonymous_change_is_recognised(self):
        # CGA -> CGG is still arginine.
        variant = self.project(vcf_record(105, "A", ["G"]))
        self.assertEqual(variant.consequence, "synonymous")
        self.assertEqual(variant.impact, "silent")

    def test_a_new_stop_is_found_by_translating_the_codon(self):
        # ACC -> TCC is Ser; CGA -> TGA is a stop.
        variant = self.project(vcf_record(103, "C", ["T"]))
        self.assertEqual(variant.consequence, "stop_gained")
        self.assertEqual(variant.impact, "truncating")

    def test_a_minus_strand_allele_is_flipped_before_the_codon_is_rebuilt(self):
        # On the minus strand the CDS reads the other way, so genomic 104 is
        # still coord 5 but the VCF's forward-strand C is the CDS's G.
        variant = self.project(vcf_record(104, "C", ["A"]), strand="-")
        self.assertEqual(variant.aa_index, 2)
        self.assertFalse(variant.ref_mismatch)
        self.assertEqual(variant.ref_aa, "R")
        self.assertEqual(variant.alt_aa, "L")

    def test_a_ref_that_disagrees_with_the_genome_is_flagged_not_dropped(self):
        variant = self.project(vcf_record(104, "A", ["T"]))
        self.assertTrue(variant.ref_mismatch)
        self.assertEqual(variant.aa_index, 2)

    def test_an_intronic_record_is_skipped(self):
        segments = [
            {"coord_start": 1, "coord_end": 3, "genomic_start": 100, "genomic_end": 102, "phase": 0},
            {"coord_start": 4, "coord_end": 9, "genomic_start": 200, "genomic_end": 205, "phase": 0},
        ]
        self.assertIsNone(self.project(vcf_record(150, "A", ["T"]), segments=segments))

    def test_a_deletion_padded_from_outside_the_exon_still_maps(self):
        # VCF deletions carry a padding base that can sit in the intron; the
        # first coding base of the span is what the residue is taken from.
        segments = [{
            "coord_start": 1, "coord_end": 9,
            "genomic_start": 101, "genomic_end": 109, "phase": 0,
        }]
        variant = self.project(vcf_record(100, "ACT", ["A"]), segments=segments)
        self.assertIsNotNone(variant)
        self.assertEqual(variant.pos, 100)
        self.assertEqual(variant.aa_index, 1)
        self.assertEqual(variant.consequence, "frameshift")
        self.assertEqual(variant.impact, "truncating")

    def test_a_residue_the_model_does_not_cover_is_skipped(self):
        self.assertIsNone(self.project(vcf_record(104, "G", ["T"]), mapping={1: 1, 3: 3}))

    def test_an_indel_is_classified_without_translating(self):
        variant = self.project(vcf_record(103, "C", ["CTTT"]))
        self.assertEqual(variant.consequence, "inframe_insertion")
        self.assertEqual(variant.ref_aa, "")

    def test_a_codon_running_off_the_read_sequence_is_not_guessed_at(self):
        # A three prime partial CDS: coordinate space claims nine bases, the
        # sequence only has six.
        variant = self.project(vcf_record(107, "A", ["T"]), dna="ATGCGA")
        self.assertEqual(variant.aa_index, 3)
        self.assertEqual(variant.consequence, "protein_altering")
        self.assertEqual(variant.ref_aa, "")


class TranscriptProbeTests(unittest.TestCase):
    """Which transcripts the dropdown is allowed to offer."""

    def setUp(self):
        self.far_future = time.monotonic() + 60

    def test_a_transcript_with_a_model_is_offered(self):
        context = {"status": "ok", "protein": "MRT", "protein_id": "ENSP1"}
        model = ps.AlphaFoldModel(accession="O43175", sequence="MRT", version=6)
        with patch.object(main, "_resolve_structure_accession", return_value=("O43175", "uniprot_api")):
            with patch.object(main, "_alphafold_model", return_value=model):
                option = main._probe_structure_option("reference", "ENST1", context, self.far_future)
        self.assertEqual(option.status, "ok")
        self.assertEqual(option.accession, "O43175")
        self.assertEqual(option.protein_length, 3)
        self.assertTrue(option.identical)

    def test_a_translation_unlike_the_model_is_still_offered(self):
        context = {"status": "ok", "protein": "MRTAA", "protein_id": "ENSP1"}
        model = ps.AlphaFoldModel(accession="O43175", sequence="MRT", version=6)
        with patch.object(main, "_resolve_structure_accession", return_value=("O43175", "xref")):
            with patch.object(main, "_alphafold_model", return_value=model):
                option = main._probe_structure_option("reference", "ENST1", context, self.far_future)
        self.assertEqual(option.status, "ok")
        self.assertFalse(option.identical)

    def test_a_transcript_with_no_accession_is_not_offered(self):
        context = {"status": "ok", "protein": "MRT", "protein_id": "ENSP1"}
        with patch.object(main, "_resolve_structure_accession", return_value=("", "")):
            option = main._probe_structure_option("reference", "ENST1", context, self.far_future)
        self.assertEqual(option.status, "no_accession")

    def test_an_accession_with_no_model_is_not_offered(self):
        context = {"status": "ok", "protein": "MRT", "protein_id": "ENSP1"}
        with patch.object(main, "_resolve_structure_accession", return_value=("O43175", "xref")):
            with patch.object(main, "_alphafold_model", return_value=None):
                option = main._probe_structure_option("reference", "ENST1", context, self.far_future)
        self.assertEqual(option.status, "no_model")

    def test_a_non_coding_transcript_reports_its_own_status(self):
        context = {"status": "no_cds", "message": "No CDS — non-coding transcript"}
        option = main._probe_structure_option("reference", "ENST1", context, self.far_future)
        self.assertEqual(option.status, "no_cds")

    def test_past_the_deadline_nothing_further_is_looked_up(self):
        context = {"status": "ok", "protein": "MRT", "protein_id": "ENSP1"}
        with patch.object(main, "_resolve_structure_accession") as resolve:
            option = main._probe_structure_option("reference", "ENST1", context, time.monotonic() - 1)
        self.assertEqual(option.status, "unknown")
        resolve.assert_not_called()

    def test_an_unreachable_lookup_is_unknown_rather_than_absent(self):
        # The distinction matters: "we could not check" must leave the transcript
        # selectable, where "there is no model" must not.
        context = {"status": "ok", "protein": "MRT", "protein_id": "ENSP1"}
        with patch.object(main, "_resolve_structure_accession", side_effect=OSError("offline")):
            option = main._probe_structure_option("reference", "ENST1", context, self.far_future)
        self.assertEqual(option.status, "unknown")

    def test_too_many_transcripts_falls_back_to_the_canonical(self):
        ids = [f"ENST{index}" for index in range(main.STRUCTURE_PROBE_MAX_TRANSCRIPTS + 1)]
        payload = main.StructureTranscriptsRequest(genome="reference", transcript_ids=ids)
        with patch.object(main, "_structure_transcript_contexts") as contexts:
            result = asyncio.run(main.structure_transcripts(payload))
        self.assertEqual(result.mode, "canonical_only")
        self.assertEqual(result.entries, [])
        contexts.assert_not_called()

    def test_every_lookup_failing_falls_back_to_the_canonical(self):
        contexts = {"ENST1": {"status": "ok", "protein": "MRT", "protein_id": "ENSP1"}}
        payload = main.StructureTranscriptsRequest(genome="reference", transcript_ids=["ENST1"])
        with patch.object(main, "_structure_transcript_contexts", return_value=contexts):
            with patch.object(main, "_resolve_structure_accession", side_effect=OSError("offline")):
                result = asyncio.run(main.structure_transcripts(payload))
        self.assertEqual(result.mode, "canonical_only")
        self.assertEqual([entry.status for entry in result.entries], ["unknown"])


class AlphaFoldMissCachingTests(unittest.TestCase):
    """A 404 from AlphaFold is remembered, briefly.

    The dropdown probe asks about every coding transcript, and a gene can easily
    carry a handful of proteins AlphaFold has never modelled. Without this those
    404s are reissued on every restart, for every visit to the gene.
    """

    def setUp(self):
        main._alphafold_model_cache.clear()
        self._cache = tempfile.TemporaryDirectory()
        self.addCleanup(self._cache.cleanup)
        patcher = patch.object(main, "_structure_cache_dir", return_value=Path(self._cache.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_an_absent_prediction_is_not_refetched(self):
        with patch.object(main, "_annotation_get_json", return_value=None) as fetch:
            self.assertIsNone(main._alphafold_model("A0ACI8TXS9"))
            main._alphafold_model_cache.clear()
            self.assertIsNone(main._alphafold_model("A0ACI8TXS9"))
        fetch.assert_called_once()

    def test_the_marker_is_never_mistaken_for_a_model(self):
        with patch.object(main, "_annotation_get_json", return_value=None):
            main._alphafold_model("A0ACI8TXS9")
        written = json.loads(
            (Path(self._cache.name) / "AF-A0ACI8TXS9-prediction.json").read_text(encoding="utf-8")
        )
        self.assertEqual(written, {main.STRUCTURE_ABSENT_KEY: True})
        self.assertIsNone(ps.parse_alphafold_prediction(written, "A0ACI8TXS9"))

    def test_a_stale_miss_is_looked_up_again(self):
        with patch.object(main, "_annotation_get_json", return_value=None) as fetch:
            main._alphafold_model("A0ACI8TXS9")
            path = Path(self._cache.name) / "AF-A0ACI8TXS9-prediction.json"
            stale = time.time() - main.STRUCTURE_ACCESSION_MISS_TTL_SECONDS - 60
            os.utime(path, (stale, stale))
            main._alphafold_model_cache.clear()
            main._alphafold_model("A0ACI8TXS9")
        self.assertEqual(fetch.call_count, 2)

    def test_a_real_prediction_keeps_the_longer_life(self):
        payload = {
            "modelEntityId": "AF-O43175-F1", "sequence": "MRT",
            "sequenceStart": 1, "sequenceEnd": 3, "latestVersion": 6,
            "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-O43175-F1-model_v6.cif",
        }
        with patch.object(main, "_annotation_get_json", return_value=payload) as fetch:
            main._alphafold_model("O43175")
            path = Path(self._cache.name) / "AF-O43175-prediction.json"
            aged = time.time() - main.STRUCTURE_ACCESSION_MISS_TTL_SECONDS - 60
            os.utime(path, (aged, aged))
            main._alphafold_model_cache.clear()
            model = main._alphafold_model("O43175")
        fetch.assert_called_once()
        self.assertEqual(model.accession, "O43175")


class AccessionResolutionTests(unittest.TestCase):
    def setUp(self):
        main._uniprot_accession_cache.clear()
        main._uniprot_mapping_cache.clear()
        # The remote tier is also cached on disk, so each test gets its own cache
        # directory: otherwise one test's remembered miss becomes the next test's
        # answer, and the suite would write into the user's real cache.
        self._cache = tempfile.TemporaryDirectory()
        self.addCleanup(self._cache.cleanup)
        patcher = patch.object(main, "_structure_cache_dir", return_value=Path(self._cache.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        main._uniprot_accession_disk = None
        self.addCleanup(setattr, main, "_uniprot_accession_disk", None)

    def test_a_typed_accession_wins_over_every_other_source(self):
        with patch.object(main, "_configured_mapping_path") as configured:
            with patch.object(main, "_uniprot_accession_from_api") as remote:
                accession, source = main._resolve_structure_accession("reference", "ENSP1", "o43175")
        self.assertEqual((accession, source), ("O43175", ps.SOURCE_MANUAL))
        configured.assert_not_called()
        remote.assert_not_called()

    def test_an_imported_mapping_file_is_preferred_over_the_remote_lookup(self):
        with tempfile.TemporaryDirectory() as directory:
            mapping = Path(directory) / "map.tsv"
            mapping.write_text("ENSP00000358417\tO43175\n")

            with patch.object(main, "_configured_mapping_path", return_value=mapping):
                with patch.object(main, "_uniprot_accession_from_api") as remote:
                    accession, source = main._resolve_structure_accession(
                        "reference", "ENSP00000358417", ""
                    )

        self.assertEqual((accession, source), ("O43175", ps.SOURCE_CUSTOM_TSV))
        remote.assert_not_called()

    def test_the_remote_lookup_is_the_last_resort_and_is_memoised(self):
        with patch.object(main, "_configured_mapping_path", return_value=None):
            with patch.object(main, "_genome_xref_mapping", return_value=None):
                with patch.object(main, "_uniprot_accession_from_api", return_value="O43175") as remote:
                    first = main._resolve_structure_accession("reference", "ENSP1", "", 533)
                    second = main._resolve_structure_accession("reference", "ENSP1", "", 533)

        self.assertEqual(first, ("O43175", ps.SOURCE_UNIPROT_API))
        self.assertEqual(second, ("O43175", ps.SOURCE_UNIPROT_API))
        remote.assert_called_once_with("ENSP1", 533)

    def test_the_remote_answer_survives_a_restart(self):
        with patch.object(main, "_configured_mapping_path", return_value=None):
            with patch.object(main, "_genome_xref_mapping", return_value=None):
                with patch.object(main, "_uniprot_accession_from_api", return_value="O43175") as remote:
                    main._resolve_structure_accession("reference", "ENSP1", "", 533)
                    # Losing the in-memory caches is what a restart looks like from
                    # here; the panel should still not need the network.
                    main._uniprot_accession_cache.clear()
                    main._uniprot_accession_disk = None
                    again = main._resolve_structure_accession("reference", "ENSP1", "", 533)

        self.assertEqual(again, ("O43175", ps.SOURCE_UNIPROT_API))
        remote.assert_called_once()

    def test_a_remembered_miss_expires_sooner_than_a_hit(self):
        self.assertGreater(
            main.STRUCTURE_ACCESSION_TTL_SECONDS,
            main.STRUCTURE_ACCESSION_MISS_TTL_SECONDS,
        )
        main._accession_disk_store("ENSP1", "")
        cache = main._accession_disk_cache()
        cache["ENSP1"]["ts"] = time.time() - main.STRUCTURE_ACCESSION_MISS_TTL_SECONDS - 60
        self.assertIsNone(main._accession_disk_lookup("ENSP1"))

        main._accession_disk_store("ENSP2", "O43175")
        cache["ENSP2"]["ts"] = time.time() - main.STRUCTURE_ACCESSION_MISS_TTL_SECONDS - 60
        self.assertEqual(main._accession_disk_lookup("ENSP2"), "O43175")

    def test_a_protein_with_no_mapping_reports_no_source(self):
        with patch.object(main, "_configured_mapping_path", return_value=None):
            with patch.object(main, "_genome_xref_mapping", return_value=None):
                with patch.object(main, "_uniprot_accession_from_api", return_value=""):
                    self.assertEqual(
                        main._resolve_structure_accession("reference", "ENSP1", ""), ("", "")
                    )

    def test_a_failed_lookup_is_remembered_so_it_is_not_retried_per_request(self):
        with patch.object(main, "_configured_mapping_path", return_value=None):
            with patch.object(main, "_genome_xref_mapping", return_value=None):
                with patch.object(main, "_uniprot_accession_from_api", return_value="") as remote:
                    main._resolve_structure_accession("reference", "ENSP1", "")
                    main._resolve_structure_accession("reference", "ENSP1", "")
        remote.assert_called_once()


class AlphaFoldMetadataCacheTests(unittest.TestCase):
    def setUp(self):
        main._alphafold_model_cache.clear()

    def test_metadata_is_read_from_disk_rather_than_refetched(self):
        payload = [{"modelEntityId": "AF-O43175-F1", "sequence": "MAFAN", "latestVersion": 6}]
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            (cache / "AF-O43175-prediction.json").write_text(json.dumps(payload))

            with patch.object(main, "_structure_cache_dir", return_value=cache):
                with patch.object(main, "_annotation_get_json") as fetch:
                    model = main._alphafold_model("O43175")

        self.assertEqual(model.sequence, "MAFAN")
        self.assertEqual(model.version, 6)
        fetch.assert_not_called()

    def test_an_accession_with_no_model_is_cached_as_none(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(main, "_structure_cache_dir", return_value=Path(directory)):
                with patch.object(main, "_annotation_get_json", return_value=None) as fetch:
                    self.assertIsNone(main._alphafold_model("O43175"))
                    self.assertIsNone(main._alphafold_model("O43175"))
        fetch.assert_called_once()


if __name__ == "__main__":
    unittest.main()

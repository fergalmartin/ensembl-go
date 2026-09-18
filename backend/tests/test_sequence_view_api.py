import asyncio
import inspect
import json
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException, params  # noqa: E402
from pydantic.fields import PydanticUndefined as Undefined  # noqa: E402

from sequence_view.api import create_router  # noqa: E402


# A chromosome with a two-exon plus-strand gene in it. The sequence is built so
# that the annotation's codons and splice sites really are ATG / TAA and GT / AG,
# because the feature derivation verifies them against the bases and silently
# omits anything that does not read correctly.
def build_sequence() -> str:
    bases = ["N"] * 400
    def put(start, text):          # 1-based inclusive, like everything else here
        for offset, character in enumerate(text):
            bases[start - 1 + offset] = character
    put(1, "acgtacgtac")           # lower case: soft-masked repeat at 1-10
    put(111, "ATG")                # start codon, first base of the CDS
    put(121, "GT")                 # donor, just after exon one
    put(129, "AG")                 # acceptor, just before exon two
    put(138, "TAA")                # stop codon, last three bases of the CDS
    return "".join(bases)


GENOME_SEQUENCE = build_sequence()

TRANSCRIPT_DATA = {
    "exons": [{"start": 101, "end": 120}, {"start": 131, "end": 150}],
    "cds_list": [{"start": 111, "end": 120}, {"start": 131, "end": 140}],
    "utrs": [
        {"start": 101, "end": 110, "feature_type": "five_prime_UTR"},
        {"start": 141, "end": 150, "feature_type": "three_prime_UTR"},
    ],
    "biotype": "protein_coding",
    "tags": ["Ensembl_canonical"],
}

# A second isoform that starts later and codes for nothing, so that some bases
# the first calls coding the second calls exonic non-coding.
SHORT_TRANSCRIPT_DATA = {
    "exons": [{"start": 111, "end": 120}, {"start": 131, "end": 150}],
    "cds_list": [],
    "utrs": [],
    "biotype": "processed_transcript",
    "tags": [],
}


class FakeFasta:
    """Enough of ThreadSafeFasta for these tests, with the same 0-based fetch."""

    references = ["17"]

    def fetch(self, chrom, start, end):
        if chrom != "17":
            raise KeyError(chrom)
        return GENOME_SEQUENCE[start:end]

    def get_reference_length(self, chrom):
        if chrom != "17":
            raise KeyError(chrom)
        return len(GENOME_SEQUENCE)


def add_gene(connection, gene_id, name, start, end, strand="+", biotype="protein_coding"):
    connection.execute(
        "INSERT INTO genes VALUES (?,?,?,?,?,?,?,?)",
        (gene_id, "17", start, end, strand, name, biotype, ""),
    )


def build_db(path: Path, with_short_isoform: bool = False) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE genes (id TEXT PRIMARY KEY, chrom TEXT, start INTEGER, end INTEGER,
                            strand TEXT, name TEXT, biotype TEXT DEFAULT '', description TEXT DEFAULT '');
        CREATE TABLE transcripts (id TEXT PRIMARY KEY, chrom TEXT, start INTEGER, end INTEGER,
                                  strand TEXT, parent_gene_id TEXT, data JSON, is_canonical INTEGER DEFAULT 0);
        """
    )
    connection.execute(
        "INSERT INTO genes VALUES (?,?,?,?,?,?,?,?)",
        ("GENE1", "17", 101, 150, "+", "TEST1", "protein_coding", ""),
    )
    connection.execute(
        "INSERT INTO transcripts VALUES (?,?,?,?,?,?,?,?)",
        ("TX1", "17", 101, 150, "+", "GENE1", json.dumps(TRANSCRIPT_DATA), 1),
    )
    if with_short_isoform:
        connection.execute(
            "INSERT INTO transcripts VALUES (?,?,?,?,?,?,?,?)",
            ("TX2", "17", 111, 150, "+", "GENE1", json.dumps(SHORT_TRANSCRIPT_DATA), 0),
        )
    connection.commit()
    connection.close()


class RouterHarness:
    """The router built over a throwaway database, with main's functions passed in.

    The real derivation functions are imported from main rather than faked: they
    are the part that verifies codons and splice sites against the sequence, and
    testing against a stand-in would prove nothing about what ships.
    """

    def __init__(self, db_path, cache_root, annotation=True):
        import main

        self.db_path = str(db_path) if annotation else ""
        self.fasta = FakeFasta()
        self.router = create_router(
            cache_root=cache_root,
            db_provider=self._db,
            db_optional_provider=lambda genome: self.db_path,
            fasta_provider=lambda genome: self.fasta,
            chrom_resolver=lambda genome, requested, known: requested,
            tx_feature_intervals=main._build_tx_feature_intervals,
            mode_segments=main._build_mode_segments,
            normalize_intervals=main._normalize_interval_list,
            ordered_five_to_three=main._ordered_five_to_three,
        )
        self.routes = {}
        for route in self.router.routes:
            self.routes[(route.path, sorted(route.methods - {"HEAD"})[0])] = route.endpoint

    def _db(self, genome):
        if not self.db_path:
            raise HTTPException(status_code=404, detail="No annotation")
        return self.db_path

    def get(self, path, **kwargs):
        # Called directly rather than over HTTP, so FastAPI is not here to turn
        # a Query(...) default into its value. Fill those in, and leave the
        # endpoints declaring their real constraints.
        endpoint = self.routes[(f"/api/sequence-view{path}", "GET")]
        for name, parameter in inspect.signature(endpoint).parameters.items():
            if name in kwargs:
                continue
            default = parameter.default
            if isinstance(default, params.Param):
                kwargs[name] = None if default.default is Undefined else default.default
        return asyncio.run(endpoint(**kwargs))

    def post(self, path, payload):
        return asyncio.run(self.routes[(f"/api/sequence-view{path}", "POST")](payload))


class SequenceViewApiTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        build_db(self.root / "index.db")
        self.api = RouterHarness(self.root / "index.db", self.root / "cache")

    def tearDown(self):
        self._tmp.cleanup()

    # -- spliced fasta -------------------------------------------------

    def _collect(self, response):
        async def _read():
            out = []
            async for piece in response.body_iterator:
                out.append(piece if isinstance(piece, str) else piece.decode())
            return "".join(out)
        return asyncio.run(_read())

    def test_segments_write_only_the_stretches_asked_for(self):
        # The two exons, with the intron between them left out -- which is what
        # the reader is looking at when the record is collapsed.
        result = self.api.get(
            "/fasta", genome="g", chrom="17", start=101, end=150,
            seg=["101-120", "131-150"],
        )
        text = self._collect(result)
        header, *lines = text.strip().split("\n")
        self.assertIn("spliced:2_segments", header)
        self.assertIn("-10bp", header, "the ten intronic bases it left out")
        self.assertEqual(
            "".join(lines),
            GENOME_SEQUENCE[100:120].upper() + GENOME_SEQUENCE[130:150].upper(),
        )

    def test_a_spliced_record_wraps_across_its_joins(self):
        # One continuous sequence with the dull parts taken out, not a record
        # per segment -- so the sixty-character lines run over the joins.
        result = self.api.get(
            "/fasta", genome="g", chrom="17", start=101, end=150,
            seg=["101-120", "131-150"],
        )
        lines = self._collect(result).strip().split("\n")[1:]
        self.assertEqual(len(lines[0]), 40, "both exons on one line")

    def test_segments_are_clipped_and_merged(self):
        result = self.api.get(
            "/fasta", genome="g", chrom="17", start=101, end=150,
            seg=["1-110", "105-120", "131-999"],
        )
        text = self._collect(result)
        self.assertIn("spliced:2_segments", text.split("\n")[0])
        self.assertEqual(
            "".join(text.strip().split("\n")[1:]),
            GENOME_SEQUENCE[100:120].upper() + GENOME_SEQUENCE[130:150].upper(),
        )

    def test_a_spliced_record_on_the_minus_strand_reads_from_the_far_end(self):
        forward = self._collect(self.api.get(
            "/fasta", genome="g", chrom="17", start=101, end=150, seg=["101-120", "131-150"],
        ))
        reverse = self._collect(self.api.get(
            "/fasta", genome="g", chrom="17", start=101, end=150, strand="-",
            seg=["101-120", "131-150"],
        ))
        bases = "".join(forward.strip().split("\n")[1:])
        complement = str.maketrans("ACGTN", "TGCAN")
        self.assertEqual(
            "".join(reverse.strip().split("\n")[1:]),
            bases.translate(complement)[::-1],
        )

    def test_a_malformed_segment_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/fasta", genome="g", chrom="17", start=101, end=150, seg=["nonsense"])
        self.assertEqual(caught.exception.status_code, 400)

    def test_too_many_segments_are_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get(
                "/fasta", genome="g", chrom="17", start=1, end=400,
                seg=[f"{i * 3 + 1}-{i * 3 + 2}" for i in range(120)],
            )
        self.assertEqual(caught.exception.status_code, 400)

    # -- spans ---------------------------------------------------------

    def test_a_transcript_reports_itself_and_its_exons(self):
        result = self.api.get(
            "/spans", genome="g", chrom="17", start=101, end=150,
            level="transcript", transcript_id="TX1",
        )
        # The transcript's own span is genic, and its exons are exonic. What is
        # between the two is its introns, which is the subtraction the client
        # makes with its own flank and its own floor.
        self.assertEqual(result["genic"], [{"s": 101, "e": 150}])
        self.assertEqual(result["exonic"], [{"s": 101, "e": 120}, {"s": 131, "e": 150}])
        self.assertEqual(result["offers"], ["intergenic", "intron"])
        self.assertEqual(result["annotation"], "ready")

    def test_a_gene_reports_the_union_of_every_isoform_s_exons(self):
        build_db(self.root / "two.db", with_short_isoform=True)
        api = RouterHarness(self.root / "two.db", self.root / "cache2")
        result = api.get(
            "/spans", genome="g", chrom="17", start=101, end=150,
            level="gene", gene_id="GENE1",
        )
        # The short isoform adds nothing outside the canonical one's exons here,
        # so the union is the same two stretches -- but it is a union, not the
        # canonical transcript's answer.
        self.assertEqual(result["exonic"], [{"s": 101, "e": 120}, {"s": 131, "e": 150}])
        self.assertEqual(result["genic"], [{"s": 101, "e": 150}])

    def test_a_quiet_location_offers_both_kinds(self):
        result = self.api.get("/spans", genome="g", chrom="17", start=1, end=400, level="location")
        self.assertEqual(result["genic"], [{"s": 101, "e": 150}])
        self.assertEqual(result["exonic"], [{"s": 101, "e": 120}, {"s": 131, "e": 150}])
        self.assertEqual(result["offers"], ["intergenic", "intron"])
        self.assertEqual(result["gene_count"], 1)

    def test_spans_are_clipped_to_the_window_asked_about(self):
        result = self.api.get(
            "/spans", genome="g", chrom="17", start=110, end=135,
            level="transcript", transcript_id="TX1",
        )
        self.assertEqual(result["genic"], [{"s": 110, "e": 135}])
        self.assertEqual(result["exonic"], [{"s": 110, "e": 120}, {"s": 131, "e": 135}])

    def test_a_genome_without_annotation_has_nothing_dull_to_leave_out(self):
        api = RouterHarness(self.root / "index.db", self.root / "cache3", annotation=False)
        result = api.get("/spans", genome="g", chrom="17", start=1, end=400, level="location")
        self.assertEqual(result["annotation"], "absent")
        self.assertEqual(result["genic"], [])
        self.assertEqual(result["offers"], [])

    def test_an_unknown_level_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/spans", genome="g", chrom="17", start=1, end=400, level="nonsense")
        self.assertEqual(caught.exception.status_code, 400)

    def test_the_same_question_twice_is_answered_from_the_cache(self):
        first = self.api.get(
            "/spans", genome="g", chrom="17", start=101, end=150,
            level="transcript", transcript_id="TX1",
        )
        second = self.api.get(
            "/spans", genome="g", chrom="17", start=101, end=150,
            level="transcript", transcript_id="TX1",
        )
        self.assertEqual(first, second)

    # -- sequence ------------------------------------------------------

    def test_sequence_is_read_1_based_inclusive_of_both_ends(self):
        # The conversion to the 0-based half-open fetch happens once, inside the
        # package. Getting it wrong here would shift every base by one.
        result = self.api.get("/sequence", genome="g", chrom="17", start=111, end=113)
        self.assertEqual(result["sequence"], "ATG")
        self.assertEqual(result["length"], 3)
        self.assertEqual((result["start"], result["end"]), (111, 113))

    def test_a_single_base_reads(self):
        result = self.api.get("/sequence", genome="g", chrom="17", start=111, end=111)
        self.assertEqual(result["sequence"], "A")

    def test_soft_masking_is_kept_as_runs_while_the_sequence_stays_upper_case(self):
        # The assemblies are soft-masked and the browse endpoint upper-cases that
        # away. Keeping it beside the sequence rather than in it means every
        # consumer of the bases is unaffected.
        result = self.api.get("/sequence", genome="g", chrom="17", start=1, end=20, softmask=True)
        self.assertEqual(result["sequence"], result["sequence"].upper())
        self.assertEqual(result["masked"], [{"s": 1, "e": 10}])

    def test_soft_masking_is_not_reported_unless_asked_for(self):
        result = self.api.get("/sequence", genome="g", chrom="17", start=1, end=20)
        self.assertEqual(result["masked"], [])

    def test_a_read_past_the_end_of_the_contig_is_trimmed(self):
        result = self.api.get("/sequence", genome="g", chrom="17", start=390, end=100_000)
        self.assertEqual(result["end"], len(GENOME_SEQUENCE))

    def test_an_oversized_read_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/sequence", genome="g", chrom="17", start=1, end=200_000)
        self.assertEqual(caught.exception.status_code, 400)

    def test_an_unknown_chromosome_is_a_404(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/sequence", genome="g", chrom="ZZ", start=1, end=10)
        self.assertEqual(caught.exception.status_code, 404)

    # -- classes -------------------------------------------------------

    def test_a_transcript_focus_describes_its_codons_and_splice_sites(self):
        result = self.api.get(
            "/classes", genome="g", chrom="17", level="transcript", transcript_id="TX1", flank=0,
        )
        runs = {(r["s"], r["e"]): r["c"] for r in result["runs"]}
        self.assertEqual(runs[(101, 110)], "utr5")
        self.assertEqual(runs[(111, 113)], "start_codon")
        self.assertEqual(runs[(121, 122)], "donor")
        self.assertEqual(runs[(129, 130)], "acceptor")
        self.assertEqual(runs[(138, 140)], "stop_codon")
        self.assertEqual(runs[(141, 150)], "utr3")
        self.assertEqual(result["strand"], "+")

    def test_a_transcript_focus_carries_its_flank(self):
        result = self.api.get(
            "/classes", genome="g", chrom="17", level="transcript", transcript_id="TX1", flank=100,
        )
        self.assertEqual(result["start"], 1)
        self.assertEqual(result["end"], 250)
        # The flank itself is outside the transcript, so it takes no class.
        self.assertEqual(result["runs"][0]["s"], 101)
        self.assertEqual(result["runs"][-1]["e"], 150)

    def test_the_cds_frame_keeps_codons_together_across_the_intron(self):
        result = self.api.get(
            "/classes", genome="g", chrom="17", level="transcript", transcript_id="TX1",
        )
        frame = result["cdsFrame"]
        self.assertEqual(frame, [{"s": 111, "e": 120, "o": 0}, {"s": 131, "e": 140, "o": 10}])

        def parity(coord):
            for segment in frame:
                if segment["s"] <= coord <= segment["e"]:
                    return ((segment["o"] + (coord - segment["s"])) // 3) % 2
            return None

        self.assertEqual(parity(120), parity(131), "one codon spans the junction")

    def test_a_gene_focus_unions_its_isoforms(self):
        build_db(self.root / "both.db", with_short_isoform=True)
        api = RouterHarness(self.root / "both.db", self.root / "cache2")
        result = api.get("/classes", genome="g", chrom="17", level="gene", gene_id="GENE1")
        runs = {(r["s"], r["e"]): r["c"] for r in result["runs"]}
        # Coding in one isoform, exonic non-coding in the other.
        self.assertEqual(runs[(111, 120)], "mixed")
        # Only the long isoform reaches the 5' end, so it is not contested.
        self.assertEqual(runs[(101, 110)], "utr")
        self.assertEqual(result["features"][0]["transcript_count"], 2)

    def test_a_gene_focus_with_one_isoform_has_nothing_mixed(self):
        result = self.api.get("/classes", genome="g", chrom="17", level="gene", gene_id="GENE1")
        self.assertNotIn("mixed", {run["c"] for run in result["runs"]})

    def test_a_location_is_drawn_in_the_same_classes_a_gene_is(self):
        result = self.api.get("/classes", genome="g", chrom="17", level="location", start=1, end=300)
        runs = {(r["s"], r["e"]): r["c"] for r in result["runs"]}
        self.assertEqual(result["detail"], "genes")
        # The gene's own vocabulary, at a location: its UTR, its CDS, its intron.
        self.assertEqual(runs[(101, 110)], "utr")
        self.assertEqual(runs[(111, 120)], "coding")
        self.assertEqual(runs[(121, 130)], "intron")
        self.assertEqual(runs[(1, 100)], "intergenic")
        # The runs cover the window end to end, so no base is undescribed.
        self.assertEqual(result["runs"][0]["s"], 1)
        self.assertEqual(result["runs"][-1]["e"], 300)
        # Which genes those are is /focus/genes' question: it depends on where
        # the reader is looking, and this endpoint is tiled against the region.
        self.assertEqual(result["features"], [])

    def test_a_location_says_where_genes_lie_on_one_another(self):
        path = self.root / "overlap.db"
        build_db(path)
        connection = sqlite3.connect(path)
        # A second gene over the first gene's 3' half, and a third clear of both.
        add_gene(connection, "GENE2", "TEST2", 130, 200)
        connection.execute(
            "INSERT INTO transcripts VALUES (?,?,?,?,?,?,?,?)",
            ("TX9", "17", 130, 200, "-", "GENE2",
             json.dumps({"exons": [{"start": 130, "end": 200}], "cds_list": [], "utrs": [],
                         "biotype": "lncRNA", "tags": []}), 1),
        )
        add_gene(connection, "GENE3", "TEST3", 250, 260)
        connection.commit()
        connection.close()
        api = RouterHarness(path, self.root / "cache-overlap")
        result = api.get("/classes", genome="g", chrom="17", level="location", start=1, end=300)

        self.assertEqual(result["overlaps"], [{"s": 130, "e": 150, "n": 2}])
        self.assertEqual(result["gene_count"], 3)
        runs = {(r["s"], r["e"]): r["c"] for r in result["runs"]}
        # Where they lie on one another the two genes disagree -- one calls
        # 131-140 coding, the other exonic non-coding -- and that is the same
        # disagreement "mixed" already means between isoforms.
        self.assertEqual(runs[(130, 150)], "mixed")
        # An overlap is not a class of its own: past 150 only the second gene
        # covers the sequence, and it keeps that gene's own answer.
        self.assertEqual(runs[(151, 200)], "noncoding")

    # -- one base, in full ---------------------------------------------

    def _overlapping(self, name="base.db"):
        """The two-exon coding gene, with a non-coding gene across its 3' half."""
        path = self.root / name
        build_db(path, with_short_isoform=True)
        connection = sqlite3.connect(path)
        add_gene(connection, "GENE2", "TEST2", 130, 200, strand="-", biotype="lncRNA")
        connection.execute(
            "INSERT INTO transcripts VALUES (?,?,?,?,?,?,?,?)",
            ("TX9", "17", 130, 200, "-", "GENE2",
             json.dumps({"exons": [{"start": 130, "end": 200}], "cds_list": [], "utrs": [],
                         "biotype": "lncRNA", "tags": []}), 1),
        )
        connection.commit()
        connection.close()
        return RouterHarness(path, self.root / f"cache-{name}")

    def test_a_base_says_which_gene_it_is_in_and_what_each_isoform_calls_it(self):
        api = self._overlapping()
        result = api.get("/base", genome="g", chrom="17", coord=115)
        self.assertEqual(result["cls"], "mixed")
        self.assertEqual(len(result["genes"]), 1)
        gene = result["genes"][0]
        self.assertEqual(gene["name"], "TEST1")
        self.assertEqual(gene["cls"], "mixed", "the gene's own answer, not the region's")
        said = {t["id"]: t["cls"] for t in gene["transcripts"]}
        # Which is what "mixed" is made of, and the whole point of the box.
        self.assertEqual(said, {"TX1": "coding", "TX2": "noncoding"})

    def test_a_base_in_two_genes_lists_both(self):
        api = self._overlapping()
        result = api.get("/base", genome="g", chrom="17", coord=135)
        self.assertEqual([g["name"] for g in result["genes"]], ["TEST1", "TEST2"])
        self.assertEqual(result["genes"][1]["cls"], "noncoding")
        self.assertEqual(result["genes"][1]["strand"], "-")

    def test_the_answer_is_the_one_the_view_painted(self):
        # The box explains a colour, so it must never disagree with it. Both come
        # from location_gene_classes; this is what holds them together.
        api = self._overlapping()
        runs = api.get(
            "/classes", genome="g", chrom="17", level="location", start=1, end=300,
        )["runs"]
        for coord in (1, 105, 115, 125, 135, 151, 250):
            drawn = next(r["c"] for r in runs if r["s"] <= coord <= r["e"])
            self.assertEqual(
                api.get("/base", genome="g", chrom="17", coord=coord)["cls"], drawn, coord,
            )

    def test_an_isoform_that_does_not_reach_the_base_is_not_listed(self):
        # The same rule that keeps "mixed" meaningful: a transcript that does not
        # cover a base has no opinion about it. The count of the gene's isoforms
        # is still there, so the box can say two of eleven reach this base.
        api = self._overlapping()
        gene = api.get("/base", genome="g", chrom="17", coord=105)["genes"][0]
        self.assertEqual([t["id"] for t in gene["transcripts"]], ["TX1"])
        self.assertEqual(gene["transcript_count"], 2)

    def test_a_utr_is_reported_as_five_prime_or_three_prime(self):
        api = self._overlapping()
        first = api.get("/base", genome="g", chrom="17", coord=105)["genes"][0]["transcripts"][0]
        self.assertEqual(first["cls"], "utr5")
        last = api.get("/base", genome="g", chrom="17", coord=145)["genes"][0]["transcripts"][0]
        self.assertEqual(last["cls"], "utr3")

    def test_a_base_is_numbered_as_the_drawer_numbers_it(self):
        api = self._overlapping()
        features = api.get("/focus/features", genome="g", transcript_id="TX1")["features"]
        for coord in (105, 125, 135):
            said = next(
                t for t in api.get("/base", genome="g", chrom="17", coord=coord)["genes"][0]["transcripts"]
                if t["id"] == "TX1"
            )
            expected = next(
                f for f in features if f["s"] <= coord <= f["e"]
            )
            self.assertEqual((said["kind"], said["index"]), (expected["kind"], expected["index"]), coord)

    def test_a_base_in_no_gene_is_intergenic_and_lists_nothing(self):
        result = self.api.get("/base", genome="g", chrom="17", coord=300)
        self.assertEqual(result["cls"], "intergenic")
        self.assertEqual(result["genes"], [])
        self.assertEqual(result["base"], "N")

    def test_a_base_carries_its_own_soft_masking(self):
        # Lower case in the FASTA, which the sequence endpoint uppercases away.
        masked = self.api.get("/base", genome="g", chrom="17", coord=3)
        self.assertTrue(masked["masked"])
        self.assertEqual(masked["base"], "G", "reported upper whatever the file says")
        self.assertFalse(self.api.get("/base", genome="g", chrom="17", coord=115)["masked"])

    def test_a_base_past_the_end_of_the_chromosome_is_not_found(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/base", genome="g", chrom="17", coord=99_999)
        self.assertEqual(caught.exception.status_code, 404)

    def test_a_genome_with_no_annotation_still_answers_about_a_base(self):
        api = RouterHarness(self.root / "index.db", self.root / "cache-base-plain", annotation=False)
        result = api.get("/base", genome="g", chrom="17", coord=115)
        self.assertEqual(result["annotation"], "absent")
        self.assertEqual(result["genes"], [])
        self.assertEqual(result["base"], "N")

    def test_the_box_answers_for_the_level_being_read(self):
        # The complaint this fixes: a transcript in focus is the only thing
        # describing its own bases, so "mixed" there was describing two isoforms
        # that were not on screen.
        api = self._overlapping()
        at_location = api.get("/base", genome="g", chrom="17", coord=115)
        self.assertEqual(at_location["cls"], "mixed")

        at_gene = api.get(
            "/base", genome="g", chrom="17", coord=115, level="gene", gene_id="GENE1",
        )
        self.assertEqual(at_gene["cls"], "mixed", "a gene is all of its isoforms at once")

        at_transcript = api.get(
            "/base", genome="g", chrom="17", coord=115,
            level="transcript", transcript_id="TX1",
        )
        self.assertEqual(at_transcript["cls"], "coding", "what this transcript says")
        other = api.get(
            "/base", genome="g", chrom="17", coord=115,
            level="transcript", transcript_id="TX2",
        )
        self.assertEqual(other["cls"], "noncoding", "and what that one says")
        self.assertEqual(other["level"], "transcript")

    def test_the_box_still_lists_everything_whatever_the_level(self):
        # The other isoforms are worth knowing about from anywhere -- they are
        # just not what is being drawn, which is what `focus` says.
        api = self._overlapping()
        result = api.get(
            "/base", genome="g", chrom="17", coord=135,
            level="transcript", gene_id="GENE1", transcript_id="TX1",
        )
        self.assertEqual([g["name"] for g in result["genes"]], ["TEST1", "TEST2"])
        gene = result["genes"][0]
        self.assertTrue(gene["focus"])
        self.assertFalse(result["genes"][1]["focus"])
        reading = {t["id"]: t["focus"] for t in gene["transcripts"]}
        self.assertEqual(reading, {"TX1": True, "TX2": False})

    def test_an_isoform_carries_enough_to_be_read_into(self):
        # So that "switch to this transcript" does not need another request.
        api = self._overlapping()
        gene = api.get(
            "/base", genome="g", chrom="17", coord=115, level="location",
        )["genes"][0]
        first = gene["transcripts"][0]
        self.assertEqual((first["s"], first["e"]), (101, 150))
        self.assertEqual(first["strand"], "+")

    def test_a_gene_focus_says_nothing_about_its_flanking_sequence(self):
        # The gene view draws flanking bases with no class, so the box agrees.
        api = self._overlapping()
        result = api.get(
            "/base", genome="g", chrom="17", coord=250, level="gene", gene_id="GENE1",
        )
        self.assertEqual(result["cls"], "")
        self.assertEqual(result["genes"], [], "and no gene is there anyway")

    # -- hiding --------------------------------------------------------

    def test_a_hidden_gene_casts_no_vote(self):
        # The point of hiding: with the antisense gene silenced, the stretch the
        # two shared stops being "mixed" and reads as what the gene left is.
        api = self._overlapping()
        loud = api.get("/classes", genome="g", chrom="17", level="location", start=1, end=300)
        self.assertIn("mixed", {r["c"] for r in loud["runs"]})

        # The gene's own short isoform disagrees with its long one as well, so
        # both voices have to go for the stretch to read plainly -- which is the
        # honest behaviour: hiding a gene silences that gene, not the argument.
        quiet = api.get(
            "/classes", genome="g", chrom="17", level="location", start=1, end=300,
            hide="GENE2,TX2",
        )
        self.assertNotIn("mixed", {r["c"] for r in quiet["runs"]})
        runs = {(r["s"], r["e"]): r["c"] for r in quiet["runs"]}
        self.assertEqual(runs[(131, 140)], "coding")
        # And the sequence the hidden gene alone covered is no longer in a gene.
        self.assertEqual(runs[(151, 300)], "intergenic")
        self.assertEqual(quiet["hidden"], 2)

    def test_hiding_a_gene_takes_its_overlap_with_it(self):
        api = self._overlapping()
        quiet = api.get(
            "/classes", genome="g", chrom="17", level="location", start=1, end=300,
            hide="GENE2",
        )
        self.assertEqual(quiet["overlaps"], [], "one gene cannot overlap itself")

    def test_a_hidden_isoform_casts_no_vote_either(self):
        # Finer than a gene: the short isoform is what makes 111-120 mixed, so
        # silencing it leaves the gene reading as its remaining isoform.
        api = self._overlapping()
        quiet = api.get(
            "/classes", genome="g", chrom="17", level="gene", gene_id="GENE1", hide="TX2",
        )
        runs = {(r["s"], r["e"]): r["c"] for r in quiet["runs"]}
        self.assertEqual(runs[(111, 120)], "coding")
        self.assertEqual(quiet["hidden"], 1)
        # The gene still has two isoforms; one of them is just not being counted.
        self.assertEqual(quiet["features"][0]["transcript_count"], 2)

    def test_a_gene_with_every_isoform_hidden_is_intronic_over_its_span(self):
        # Which is what the annotation says of a gene with no transcripts at all,
        # and better than a hole: the gene is still there.
        api = self._overlapping()
        quiet = api.get(
            "/classes", genome="g", chrom="17", level="gene", gene_id="GENE1",
            hide="TX1,TX2",
        )
        self.assertEqual({r["c"] for r in quiet["runs"]}, {"intron"})

    def test_hiding_nothing_is_the_same_answer_as_not_hiding(self):
        api = self._overlapping()
        plain = api.get("/classes", genome="g", chrom="17", level="location", start=1, end=300)
        empty = api.get(
            "/classes", genome="g", chrom="17", level="location", start=1, end=300, hide=",,",
        )
        self.assertEqual(plain["runs"], empty["runs"])

    def test_a_hidden_answer_is_cached_apart_from_a_visible_one(self):
        # One cache key per set of hidden things, or the second reader of a tile
        # would get the first reader's answer.
        api = self._overlapping()
        first = api.get("/classes", genome="g", chrom="17", level="location", start=1, end=300)
        api.get("/classes", genome="g", chrom="17", level="location", start=1, end=300, hide="GENE2")
        again = api.get("/classes", genome="g", chrom="17", level="location", start=1, end=300)
        self.assertEqual(first["runs"], again["runs"])

    def test_too_many_hidden_at_once_is_refused(self):
        api = self._overlapping()
        with self.assertRaises(HTTPException) as caught:
            api.get(
                "/classes", genome="g", chrom="17", level="location", start=1, end=300,
                hide=",".join(f"G{i}" for i in range(201)),
            )
        self.assertEqual(caught.exception.status_code, 400)

    def test_the_box_lists_a_hidden_gene_but_does_not_count_it(self):
        # The box is where a reader turns one back on, so it is the one place a
        # hidden feature must not disappear from.
        api = self._overlapping()
        result = api.get("/base", genome="g", chrom="17", coord=135, hide="GENE2,TX2")
        self.assertEqual(result["cls"], "coding", "no longer contested")
        names = {g["name"]: g["hidden"] for g in result["genes"]}
        self.assertEqual(names, {"TEST1": False, "TEST2": True})

    def test_the_box_marks_a_hidden_isoform(self):
        api = self._overlapping()
        gene = api.get("/base", genome="g", chrom="17", coord=115, hide="TX2")["genes"][0]
        said = {t["id"]: (t["cls"], t["hidden"]) for t in gene["transcripts"]}
        self.assertEqual(said, {"TX1": ("coding", False), "TX2": ("noncoding", True)})
        self.assertEqual(gene["cls"], "coding", "the hidden one does not vote")

    def test_the_box_still_agrees_with_the_view_while_things_are_hidden(self):
        api = self._overlapping()
        runs = api.get(
            "/classes", genome="g", chrom="17", level="location", start=1, end=300,
            hide="GENE2",
        )["runs"]
        for coord in (105, 115, 135, 160, 250):
            drawn = next(r["c"] for r in runs if r["s"] <= coord <= r["e"])
            box = api.get("/base", genome="g", chrom="17", coord=coord, hide="GENE2")
            self.assertEqual(box["cls"], drawn, coord)

    def test_a_location_with_too_many_genes_falls_back_and_says_so(self):
        api = self._crowded()
        with patch("sequence_view.api.MAX_LOCATION_DETAIL_GENES", 5):
            result = api.get("/classes", genome="g", chrom="17", level="location", start=1, end=500)
        self.assertEqual(result["detail"], "plain")
        self.assertEqual({run["c"] for run in result["runs"]}, {"genic", "intergenic"})
        # The count is of the tile -- clipped to the chromosome, which is 400
        # bases here -- so the view can say why the colours changed.
        self.assertEqual(result["gene_count"], 22)
        # Overlaps are cheap -- gene spans, not isoforms -- so they survive the
        # fallback. It is the classes that get coarser, not the whole answer.
        self.assertEqual(result["overlaps"], [])

    def test_a_feature_focus_reuses_the_transcript_derivation_on_its_own_window(self):
        result = self.api.get(
            "/classes", genome="g", chrom="17", level="feature",
            transcript_id="TX1", start=131, end=150, flank=10,
        )
        self.assertEqual((result["start"], result["end"]), (121, 160))
        runs = {(r["s"], r["e"]): r["c"] for r in result["runs"]}
        self.assertEqual(runs[(141, 150)], "utr3")
        self.assertEqual(runs[(121, 122)], "donor", "the flank still carries its annotation")

    def test_a_genome_with_no_annotation_reports_that_rather_than_failing(self):
        # A FASTA-only genome still reads sequence. Saying so is a state, not an
        # error, and the view says it instead of looking broken.
        api = RouterHarness(self.root / "index.db", self.root / "cache3", annotation=False)
        result = api.get("/classes", genome="g", chrom="17", level="location", start=1, end=300)
        self.assertEqual(result["annotation"], "absent")
        self.assertEqual(result["runs"], [])

    def test_a_gene_focus_on_a_genome_with_no_annotation_is_a_404(self):
        api = RouterHarness(self.root / "index.db", self.root / "cache4", annotation=False)
        with self.assertRaises(HTTPException) as caught:
            api.get("/classes", genome="g", chrom="17", level="gene", gene_id="GENE1")
        self.assertEqual(caught.exception.status_code, 404)

    def test_an_index_still_building_is_passed_through_as_425(self):
        # The sequence tiles never touch the database, so sequence keeps
        # rendering throughout an index build; only the classes wait. The client
        # retries on this status rather than treating it as a failure, which is
        # why it has to reach it unchanged.
        import main

        def building(genome):
            raise HTTPException(status_code=425, detail="Building")

        router = create_router(
            cache_root=self.root / "cache-building",
            db_provider=building,
            db_optional_provider=building,
            fasta_provider=lambda genome: FakeFasta(),
            chrom_resolver=lambda genome, requested, known: requested,
            tx_feature_intervals=main._build_tx_feature_intervals,
            mode_segments=main._build_mode_segments,
            normalize_intervals=main._normalize_interval_list,
            ordered_five_to_three=main._ordered_five_to_three,
        )
        endpoints = {route.path: route.endpoint for route in router.routes}

        with self.assertRaises(HTTPException) as caught:
            asyncio.run(endpoints["/api/sequence-view/classes"](
                genome="g", chrom="17", level="gene", gene_id="GENE1", start=0, end=0, flank=0,
                transcript_id="",
            ))
        self.assertEqual(caught.exception.status_code, 425)

        # Sequence is unaffected by the build, which is the whole point.
        read = asyncio.run(endpoints["/api/sequence-view/sequence"](
            genome="g", chrom="17", start=111, end=113, softmask=False,
        ))
        self.assertEqual(read["sequence"], "ATG")

    def test_an_unknown_level_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/classes", genome="g", chrom="17", level="galaxy")
        self.assertEqual(caught.exception.status_code, 400)

    def test_a_gene_focus_without_a_gene_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/classes", genome="g", chrom="17", level="gene")
        self.assertEqual(caught.exception.status_code, 400)

    def test_the_answer_is_cached_and_the_second_call_matches_the_first(self):
        first = self.api.get("/classes", genome="g", chrom="17", level="gene", gene_id="GENE1")
        second = self.api.get("/classes", genome="g", chrom="17", level="gene", gene_id="GENE1")
        self.assertEqual(first, second)

    # -- the drawer's lists --------------------------------------------

    def test_the_genes_on_a_region_are_listed_with_their_isoform_counts(self):
        result = self.api.get("/focus/genes", genome="g", chrom="17", start=1, end=400)
        self.assertEqual(result["genes"][0]["id"], "GENE1")
        self.assertEqual(result["genes"][0]["transcript_count"], 1)

    def _crowded(self, name="crowded.db"):
        """A region with more genes than anyone would want listed at once."""
        path = self.root / name
        build_db(path)
        connection = sqlite3.connect(path)
        # Twenty-five genes, ten bases apart, from 200 to 440.
        for i in range(25):
            add_gene(connection, f"G{i}", f"GENE_{i}", 200 + i * 10, 200 + i * 10 + 5)
        connection.commit()
        connection.close()
        return RouterHarness(path, self.root / f"cache-{name}")

    def test_the_count_is_of_the_region_and_the_list_is_of_the_window(self):
        # A region can hold thousands. The number is worth knowing; the list is
        # only worth having if it is about where the reader actually is.
        api = self._crowded()
        result = api.get(
            "/focus/genes", genome="g", chrom="17", start=1, end=500,
            window_start=200, window_end=230,
        )
        self.assertEqual(result["total"], 26, "every gene in the region is counted")
        self.assertEqual(result["in_window"], 4, "four of them are on screen")
        self.assertGreater(len(result["genes"]), result["in_window"])

    def test_a_window_between_genes_still_offers_the_nearest_ones(self):
        # A screenful of sequence is about two kilobases, so the window is
        # usually between genes. An empty list there would be a list that is
        # empty exactly when it is needed.
        api = self._crowded()
        result = api.get(
            "/focus/genes", genome="g", chrom="17", start=1, end=500,
            window_start=460, window_end=480,
        )
        self.assertEqual(result["in_window"], 0)
        self.assertEqual(len(result["genes"]), 10, "topped up to the nearest ten")
        # The nearest are the ones just before the window, not the first in the region.
        self.assertIn("G24", [g["id"] for g in result["genes"]])

    def test_the_nearest_come_from_both_sides_of_the_window(self):
        api = self._crowded()
        result = api.get(
            "/focus/genes", genome="g", chrom="17", start=1, end=500,
            window_start=320, window_end=325,
        )
        ids = [g["id"] for g in result["genes"]]
        self.assertTrue(any(g["e"] < 320 for g in result["genes"]), "some from before")
        self.assertTrue(any(g["s"] > 325 for g in result["genes"]), "and some from after")
        self.assertEqual(len(ids), len(set(ids)), "with no repeats")

    def test_the_list_is_ordered_by_position(self):
        api = self._crowded()
        result = api.get(
            "/focus/genes", genome="g", chrom="17", start=1, end=500,
            window_start=300, window_end=340,
        )
        starts = [g["s"] for g in result["genes"]]
        self.assertEqual(starts, sorted(starts))

    def test_the_nearest_never_reach_outside_the_region(self):
        api = self._crowded()
        result = api.get(
            "/focus/genes", genome="g", chrom="17", start=250, end=300,
            window_start=280, window_end=290,
        )
        for gene in result["genes"]:
            self.assertLessEqual(gene["s"], 300)
            self.assertGreaterEqual(gene["e"], 250)

    def test_a_location_focus_no_longer_caps_its_gene_list(self):
        # The runs describe every gene in the tile however many there are; the
        # list that used to be capped lives in /focus/genes now.
        api = self._crowded()
        result = api.get("/classes", genome="g", chrom="17", level="location", start=1, end=500)
        self.assertEqual(result["features"], [])
        # These genes have no transcripts at all, so each reads as intronic over
        # its own span -- which is what the annotation says about it.
        marked = [r for r in result["runs"] if r["c"] != "intergenic"]
        self.assertGreater(len(marked), 1, "every gene shows in the runs")

    # -- search --------------------------------------------------------

    def test_a_gene_is_found_by_symbol_whatever_the_case(self):
        for query in ("TEST1", "test1", "Test1"):
            answer = self.api.get("/search", genome="g", query=query)
            self.assertTrue(answer["found"], query)
            self.assertEqual(answer["gene"]["id"], "GENE1")
            self.assertIsNone(answer["transcript"])

    def test_a_gene_is_found_by_its_identifier(self):
        answer = self.api.get("/search", genome="g", query="GENE1")
        self.assertTrue(answer["found"])
        self.assertEqual(answer["gene"]["name"], "TEST1")

    def test_a_transcript_identifier_answers_with_its_transcript_too(self):
        # So that searching an isoform lands on that isoform rather than on its
        # gene, which is what someone typing one means.
        answer = self.api.get("/search", genome="g", query="TX1")
        self.assertTrue(answer["found"])
        self.assertEqual(answer["gene"]["id"], "GENE1")
        self.assertEqual(answer["transcript"]["id"], "TX1")

    def test_a_prefix_matches_when_nothing_exact_does(self):
        answer = self.api.get("/search", genome="g", query="TES")
        self.assertTrue(answer["found"])
        self.assertEqual(answer["gene"]["id"], "GENE1")

    def test_an_exact_name_beats_a_prefix_of_a_longer_one(self):
        # "GENE_1" must not be answered with "GENE_11" just because it is there.
        api = self._crowded("exact.db")
        answer = api.get("/search", genome="g", query="GENE_1")
        self.assertEqual(answer["gene"]["name"], "GENE_1")

    def test_nothing_found_says_so_rather_than_failing(self):
        answer = self.api.get("/search", genome="g", query="NOSUCHGENE")
        self.assertFalse(answer["found"])
        self.assertIn("NOSUCHGENE", answer["reason"])

    def test_an_empty_query_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/search", genome="g", query="  ")
        self.assertEqual(caught.exception.status_code, 400)

    def test_searching_a_genome_with_no_annotation_says_why(self):
        api = RouterHarness(self.root / "index.db", self.root / "cache-nosearch", annotation=False)
        answer = api.get("/search", genome="g", query="TEST1")
        self.assertFalse(answer["found"])
        self.assertIn("annotation", answer["reason"].lower())

    def test_a_genes_transcripts_are_listed_canonical_first(self):
        build_db(self.root / "both2.db", with_short_isoform=True)
        api = RouterHarness(self.root / "both2.db", self.root / "cache8")
        result = api.get("/focus/transcripts", genome="g", gene_id="GENE1")
        self.assertEqual([t["id"] for t in result["transcripts"]], ["TX1", "TX2"])
        self.assertTrue(result["transcripts"][0]["is_canonical"])
        self.assertTrue(result["transcripts"][0]["has_cds"])
        self.assertFalse(result["transcripts"][1]["has_cds"])

    def test_exons_and_introns_are_numbered_5_prime_to_3_prime(self):
        result = self.api.get("/focus/features", genome="g", transcript_id="TX1")
        exons = [f for f in result["features"] if f["kind"] == "exon"]
        introns = [f for f in result["features"] if f["kind"] == "intron"]
        self.assertEqual([(e["index"], e["s"], e["e"]) for e in exons], [(1, 101, 120), (2, 131, 150)])
        self.assertEqual([(i["index"], i["s"], i["e"]) for i in introns], [(1, 121, 130)])

    # -- download ------------------------------------------------------

    @staticmethod
    def _read(response):
        """The body of a streamed response, as one string.

        Starlette wraps the endpoint's plain generator in an async one, so this
        has to be driven the same way the server drives it.
        """
        async def collect():
            pieces = []
            async for piece in response.body_iterator:
                pieces.append(piece if isinstance(piece, str) else piece.decode())
            return "".join(pieces)

        return asyncio.run(collect())

    def test_a_fasta_read_round_trips_its_own_header(self):
        text = self._read(self.api.get("/fasta", genome="g", chrom="17", start=111, end=113, label="GRCh38"))
        self.assertEqual(text, ">17:111-113 strand:+ genome:GRCh38\nATG\n")

    def test_a_reverse_strand_read_is_reverse_complemented(self):
        text = self._read(self.api.get("/fasta", genome="g", chrom="17", start=111, end=113, strand="-"))
        self.assertEqual(text.split("\n")[1], "CAT")
        self.assertIn("strand:-", text)

    def test_more_than_the_clipboard_should_hold_is_refused_with_a_way_forward(self):
        # A location focus can be a whole chromosome. Reading that is cheap; it
        # is the clipboard that cannot take it, so the refusal says so and says
        # what to do instead rather than reporting a failure.
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/fasta", genome="g", chrom="17", start=1, end=30_000_000)
        self.assertEqual(caught.exception.status_code, 413)
        self.assertIn("download", caught.exception.detail.lower())

    def test_a_download_has_no_such_limit(self):
        # Streamed, so the size that stops a copy does not stop this.
        response = self.api.get(
            "/fasta", genome="g", chrom="17", start=1, end=30_000_000, download=True,
        )
        self.assertIn("attachment", response.headers["content-disposition"])
        body = self._read(response)
        self.assertTrue(body.startswith(">17:1-"))

    def test_a_streamed_read_wraps_at_sixty_with_only_the_last_line_short(self):
        # The stream reads in pieces; a piece boundary must never land inside a
        # line, or the file would have short lines in the middle of it.
        with patch("sequence_view.api.FASTA_STREAM_BP", 120):
            text = self._read(self.api.get("/fasta", genome="g", chrom="17", start=1, end=250))
        lines = [line for line in text.split("\n")[1:] if line]
        self.assertEqual(len(lines), 5, "250 bases is four full lines and a short one")
        self.assertEqual([len(line) for line in lines], [60, 60, 60, 60, 10])

    def test_a_streamed_reverse_read_is_the_whole_reverse_complement(self):
        # Assembled from pieces taken backwards from the far end, so getting the
        # order or the complement wrong would show up here and nowhere else.
        forward = self._read(self.api.get("/fasta", genome="g", chrom="17", start=1, end=250))
        with patch("sequence_view.api.FASTA_STREAM_BP", 120):
            reverse = self._read(self.api.get("/fasta", genome="g", chrom="17", start=1, end=250, strand="-"))

        def body(text):
            return "".join(text.split("\n")[1:])

        table = str.maketrans("ACGTN", "TGCAN")
        self.assertEqual(body(reverse), body(forward).translate(table)[::-1])
        lines = [line for line in reverse.split("\n")[1:] if line]
        self.assertEqual([len(line) for line in lines], [60, 60, 60, 60, 10])

    def test_a_read_off_the_end_of_the_contig_is_trimmed_not_refused(self):
        text = self._read(self.api.get("/fasta", genome="g", chrom="17", start=390, end=100_000, download=True))
        self.assertIn(f">17:390-{len(GENOME_SEQUENCE)}", text)

    def test_a_backwards_range_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/fasta", genome="g", chrom="17", start=200, end=100)
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()

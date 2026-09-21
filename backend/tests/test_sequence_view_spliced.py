"""The spliced answers: /transcript-sequence and the projection under it.

Two things are worth holding here, and they are the two that a reader would
never catch by eye. A spliced sequence is written 5' to 3', which on the minus
strand means reverse complemented and read from the far end -- and the runs
describing it are in spliced coordinates, which is the one space in this package
that is not genomic.
"""

import asyncio
import inspect
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException, params  # noqa: E402
from pydantic.fields import PydanticUndefined as Undefined  # noqa: E402

from sequence_view.api import create_router  # noqa: E402
from sequence_view.classes import project_to_spliced, spliced_classes  # noqa: E402


def build_sequence() -> str:
    """A chromosome holding one plus-strand and one minus-strand transcript.

    The bases are chosen so that the codons really read ATG and TAA *after*
    orientation, because the feature derivation verifies them against the
    assembly and drops anything that does not -- so a fixture that only looks
    right on the forward strand would silently test a transcript with no frame.
    """
    bases = ["N"] * 400

    def put(start, text):          # 1-based inclusive, like everything else here
        for offset, character in enumerate(text):
            bases[start - 1 + offset] = character

    # -- plus strand: exons 101-120 and 131-150, CDS 111-120 and 131-138.
    # Eighteen bases of CDS, so it is a whole number of codons and the trailing
    # remainder that a partial annotation would leave is not in the way here.
    put(111, "ATG")                # start codon, first base of the CDS
    put(136, "TAA")                # stop codon, last three bases of the CDS

    # -- minus strand: exons 201-220 and 231-250, CDS 212-220 and 232-240.
    # Read 5' to 3' the transcript starts at 250 and runs down, so its start
    # codon is the reverse complement of the three bases at 238-240.
    put(238, "CAT")                # revcomp -> ATG
    put(212, "TTA")                # revcomp of 212-214, read last -> TAA
    return "".join(bases)


GENOME = build_sequence()

PLUS_TX = {
    "exons": [{"start": 101, "end": 120}, {"start": 131, "end": 150}],
    "cds_list": [{"start": 111, "end": 120}, {"start": 131, "end": 138}],
    "utrs": [
        {"start": 101, "end": 110, "feature_type": "five_prime_UTR"},
        {"start": 139, "end": 150, "feature_type": "three_prime_UTR"},
    ],
    "biotype": "protein_coding",
    "tags": [],
}

MINUS_TX = {
    "exons": [{"start": 201, "end": 220}, {"start": 231, "end": 250}],
    "cds_list": [{"start": 212, "end": 220}, {"start": 232, "end": 240}],
    "utrs": [
        {"start": 241, "end": 250, "feature_type": "five_prime_UTR"},
        {"start": 201, "end": 211, "feature_type": "three_prime_UTR"},
    ],
    "biotype": "protein_coding",
    "tags": [],
}

NONCODING_TX = {
    "exons": [{"start": 301, "end": 320}, {"start": 331, "end": 350}],
    "cds_list": [],
    "utrs": [],
    "biotype": "lncRNA",
    "tags": [],
}

COMPLEMENT = str.maketrans("ACGTN", "TGCAN")


def revcomp(text: str) -> str:
    return text.translate(COMPLEMENT)[::-1]


def genomic(start: int, end: int) -> str:
    """1-based inclusive, upper-cased, as everything outside fetch speaks."""
    return GENOME[start - 1:end].upper()


class FakeFasta:
    references = ["17"]

    def fetch(self, chrom, start, end):
        if chrom != "17":
            raise KeyError(chrom)
        return GENOME[start:end]

    def get_reference_length(self, chrom):
        if chrom != "17":
            raise KeyError(chrom)
        return len(GENOME)


def build_db(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE genes (id TEXT PRIMARY KEY, chrom TEXT, start INTEGER, end INTEGER,
                            strand TEXT, name TEXT, biotype TEXT DEFAULT '', description TEXT DEFAULT '');
        CREATE TABLE transcripts (id TEXT PRIMARY KEY, chrom TEXT, start INTEGER, end INTEGER,
                                  strand TEXT, parent_gene_id TEXT, data JSON, is_canonical INTEGER DEFAULT 0);
        """
    )
    rows = [
        ("GENE_P", 101, 150, "+", "protein_coding"),
        ("GENE_M", 201, 250, "-", "protein_coding"),
        ("GENE_N", 301, 350, "+", "lncRNA"),
    ]
    for gene_id, start, end, strand, biotype in rows:
        connection.execute(
            "INSERT INTO genes VALUES (?,?,?,?,?,?,?,?)",
            (gene_id, "17", start, end, strand, gene_id, biotype, ""),
        )
    transcripts = [
        ("TX_P", 101, 150, "+", "GENE_P", PLUS_TX),
        ("TX_M", 201, 250, "-", "GENE_M", MINUS_TX),
        ("TX_N", 301, 350, "+", "GENE_N", NONCODING_TX),
    ]
    for tx_id, start, end, strand, gene_id, data in transcripts:
        connection.execute(
            "INSERT INTO transcripts VALUES (?,?,?,?,?,?,?,?)",
            (tx_id, "17", start, end, strand, gene_id, json.dumps(data), 1),
        )
    connection.commit()
    connection.close()


class Harness:
    def __init__(self, db_path, cache_root):
        import main

        self.db_path = str(db_path)
        self.fasta = FakeFasta()
        self.router = create_router(
            cache_root=cache_root,
            db_provider=lambda genome: self.db_path,
            db_optional_provider=lambda genome: self.db_path,
            fasta_provider=lambda genome: self.fasta,
            chrom_resolver=lambda genome, requested, known: requested,
            tx_feature_intervals=main._build_tx_feature_intervals,
            mode_segments=main._build_mode_segments,
            translate_transcript=main._sequence_view_protein,
            normalize_intervals=main._normalize_interval_list,
            ordered_five_to_three=main._ordered_five_to_three,
        )
        self.routes = {}
        for route in self.router.routes:
            self.routes[(route.path, sorted(route.methods - {"HEAD"})[0])] = route.endpoint

    def get(self, path, **kwargs):
        endpoint = self.routes[(f"/api/sequence-view{path}", "GET")]
        for name, parameter in inspect.signature(endpoint).parameters.items():
            if name in kwargs:
                continue
            default = parameter.default
            if isinstance(default, params.Param):
                kwargs[name] = None if default.default is Undefined else default.default
        return asyncio.run(endpoint(**kwargs))


class ProjectionTest(unittest.TestCase):
    """The arithmetic on its own, where both strands can be stated by hand."""

    PLUS = [
        {"coord_start": 1, "coord_end": 20, "genomic_start": 101, "genomic_end": 120},
        {"coord_start": 21, "coord_end": 40, "genomic_start": 131, "genomic_end": 150},
    ]
    # 5' to 3' on the minus strand is the higher exon first.
    MINUS = [
        {"coord_start": 1, "coord_end": 20, "genomic_start": 231, "genomic_end": 250},
        {"coord_start": 21, "coord_end": 40, "genomic_start": 201, "genomic_end": 220},
    ]

    def test_a_stretch_inside_one_exon_keeps_its_length(self):
        self.assertEqual(project_to_spliced(self.PLUS, "+", 105, 110), [(5, 10)])

    def test_a_stretch_spanning_an_intron_comes_back_in_two_pieces(self):
        # The intron is not in the spliced sequence, so the pieces are adjacent
        # in it even though their genomic coordinates are ten bases apart.
        self.assertEqual(
            project_to_spliced(self.PLUS, "+", 118, 133),
            [(18, 20), (21, 23)],
        )

    def test_an_intron_projects_to_nothing(self):
        # Not an error: an intron is exactly the sequence a spliced transcript
        # has taken out, so having nowhere to land is the right answer.
        self.assertEqual(project_to_spliced(self.PLUS, "+", 121, 130), [])

    def test_the_minus_strand_counts_down_the_genome_and_up_the_sequence(self):
        # Genomic 250 is the transcript's first base, 231 its twentieth.
        self.assertEqual(project_to_spliced(self.MINUS, "-", 250, 250), [(1, 1)])
        self.assertEqual(project_to_spliced(self.MINUS, "-", 231, 231), [(20, 20)])
        self.assertEqual(project_to_spliced(self.MINUS, "-", 246, 250), [(1, 5)])

    def test_ranges_come_back_ascending_in_spliced_space_on_both_strands(self):
        pieces = project_to_spliced(self.MINUS, "-", 218, 233)
        self.assertEqual(pieces, sorted(pieces))
        self.assertEqual(pieces, [(18, 20), (21, 23)])

    def test_splice_sites_do_not_survive_into_the_spliced_description(self):
        # A donor sits in the first two bases of an intron, so it has nowhere to
        # land -- which is what stops the panel drawing a splice site on a
        # sequence that has no splices left in it.
        runs = spliced_classes(
            [{"type": "exon", "start": 101, "end": 120},
             {"type": "exon", "start": 131, "end": 150},
             {"type": "intron", "start": 121, "end": 130},
             {"type": "donor", "start": 121, "end": 122}],
            self.PLUS, "+", 40,
        )
        self.assertEqual({run["c"] for run in runs}, {"noncoding"})
        self.assertEqual(runs, [{"s": 1, "e": 40, "c": "noncoding"}])


class TranscriptSequenceTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        build_db(self.root / "index.db")
        self.api = Harness(self.root / "index.db", self.root / "cache")

    def tearDown(self):
        self._tmp.cleanup()

    # -- the sequence itself ------------------------------------------

    def test_a_transcript_is_its_exons_joined(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P")
        self.assertEqual(answer["status"], "ok")
        self.assertEqual(answer["sequence"], genomic(101, 120) + genomic(131, 150))
        self.assertEqual(answer["length"], 40)

    def test_a_cds_is_its_coding_segments_joined(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P", kind="cds")
        self.assertEqual(answer["sequence"], genomic(111, 120) + genomic(131, 138))
        self.assertTrue(answer["sequence"].startswith("ATG"))
        self.assertTrue(answer["sequence"].endswith("TAA"))

    def test_a_minus_strand_transcript_reads_from_its_own_far_end(self):
        # The whole point: the reader is looking at the transcript, not at the
        # chromosome under it.
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_M")
        self.assertEqual(answer["sequence"], revcomp(genomic(231, 250)) + revcomp(genomic(201, 220)))

    def test_a_minus_strand_cds_begins_at_its_start_codon(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_M", kind="cds")
        self.assertEqual(answer["sequence"], revcomp(genomic(232, 240)) + revcomp(genomic(212, 220)))
        self.assertTrue(answer["sequence"].startswith("ATG"), answer["sequence"])
        self.assertTrue(answer["sequence"].endswith("TAA"), answer["sequence"])
        self.assertTrue(answer["startVerified"])

    # -- the annotation over it ---------------------------------------

    def test_the_runs_are_in_spliced_coordinates(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P")
        # Nothing may reach past the end of the sequence being described, which
        # is the failure a genomic run leaking through would show up as.
        for run in answer["runs"]:
            self.assertGreaterEqual(run["s"], 1)
            self.assertLessEqual(run["e"], answer["length"])
        # 5' UTR is the first ten bases, and the start codon the three after it.
        self.assertEqual(answer["runs"][0], {"s": 1, "e": 10, "c": "utr5"})
        self.assertEqual(answer["runs"][1], {"s": 11, "e": 13, "c": "start_codon"})

    def test_every_base_of_a_spliced_transcript_is_described(self):
        # There are no gaps in a spliced sequence -- every base of it is in an
        # exon by construction -- so a hole in the runs is a projection bug.
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_M")
        covered = 0
        cursor = 0
        for run in answer["runs"]:
            self.assertEqual(run["s"], cursor + 1, f"gap before {run}")
            cursor = run["e"]
            covered += run["e"] - run["s"] + 1
        self.assertEqual(covered, answer["length"])

    def test_no_intron_run_survives(self):
        for transcript in ("TX_P", "TX_M"):
            answer = self.api.get("/transcript-sequence", genome="g", transcript_id=transcript)
            kinds = {run["c"] for run in answer["runs"]}
            self.assertNotIn("intron", kinds)
            self.assertNotIn("donor", kinds)
            self.assertNotIn("acceptor", kinds)

    def test_the_cds_extent_is_reported_in_the_answer_s_own_space(self):
        whole = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P")
        self.assertEqual(whole["cds"], {"s": 11, "e": 28})
        only = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P", kind="cds")
        self.assertEqual(only["cds"], {"s": 1, "e": 18})

    def test_segments_carry_the_exon_a_reader_would_name(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_M")
        self.assertEqual([piece["exon"] for piece in answer["segments"]], [1, 2])
        # Exon 1 of a minus-strand transcript is its higher-coordinate one.
        self.assertEqual(answer["segments"][0]["gs"], 231)
        cds = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_M", kind="cds")
        self.assertEqual([piece["exon"] for piece in cds["segments"]], [1, 2])

    # -- the protein --------------------------------------------------

    def test_the_protein_is_the_application_s_own_translation(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P", kind="protein")
        self.assertEqual(answer["status"], "ok")
        # Eighteen bases of CDS is six codons, and the last of them is the stop --
        # stripped the way Ensembl's own pep file strips it, so five residues.
        self.assertEqual(answer["length"], 5)
        self.assertEqual(answer["sequence"][0], "M")
        self.assertNotIn("*", answer["sequence"])
        self.assertEqual(answer["table"], 1)
        self.assertEqual(answer["molecule"], "nuclear")

    def test_a_minus_strand_protein_reads_the_same_way(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_M", kind="protein")
        self.assertEqual(answer["status"], "ok")
        self.assertEqual(answer["sequence"][0], "M")
        self.assertNotIn("*", answer["sequence"])

    def test_a_protein_s_segments_are_codon_aligned_cds_bases(self):
        # Not residues: one residue is three bases, and they can be in two
        # different exons. Mapping a residue back to the chromosome is what these
        # are for, so they have to be in the space where residue n is at 3n-2.
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P", kind="protein")
        segments = answer["segments"]
        self.assertTrue(segments)
        self.assertEqual(segments[0]["s"], 1, "no leading pad on a complete CDS")
        for piece in segments:
            self.assertEqual(piece["ge"] - piece["gs"] + 1, piece["e"] - piece["s"] + 1)

    def test_a_protein_s_segments_cover_its_residues_and_its_stop(self):
        # Three bases per residue plus the stop codon, which is in the CDS and is
        # not in the protein. Worth stating: the obvious assertion is three bases
        # per residue exactly, and it is wrong by one codon on every complete
        # transcript there is.
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P", kind="protein")
        covered = sum(piece["e"] - piece["s"] + 1 for piece in answer["segments"])
        self.assertEqual(covered, answer["length"] * 3 + 3)

        # Every residue resolves to three bases somewhere in that map.
        for residue in range(1, answer["length"] + 1):
            first = residue * 3 - 2
            last = residue * 3
            covering = [p for p in answer["segments"] if p["s"] <= first and last <= p["e"]]
            straddling = [p for p in answer["segments"] if p["s"] <= last and first <= p["e"]]
            self.assertTrue(covering or len(straddling) > 1, f"residue {residue} maps nowhere")

    def test_a_protein_names_the_exon_each_of_its_codons_sits_in(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_M", kind="protein")
        self.assertEqual([piece["exon"] for piece in answer["segments"]], [1, 2])

    def test_a_transcript_with_no_cds_has_no_protein(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_N", kind="protein")
        self.assertEqual(answer["status"], "no_cds")
        self.assertEqual(answer["sequence"], "")

    def test_the_protein_agrees_with_the_cds_it_came_from(self):
        # The one invariant worth holding across the two answers: whatever the
        # translation rules do at the ends, the residues in the middle have to be
        # the codons of the CDS the reader can see on the other tab.
        from translation import translate_cds_dna

        for transcript in ("TX_P", "TX_M"):
            cds = self.api.get("/transcript-sequence", genome="g", transcript_id=transcript, kind="cds")
            protein = self.api.get("/transcript-sequence", genome="g", transcript_id=transcript, kind="protein")
            self.assertEqual(
                protein["sequence"],
                translate_cds_dna(cds["sequence"], start_phase=cds["phase"]),
                transcript,
            )

    # -- what it refuses ----------------------------------------------

    def test_a_transcript_with_no_cds_says_so_rather_than_erroring(self):
        answer = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_N", kind="cds")
        self.assertEqual(answer["status"], "no_cds")
        self.assertEqual(answer["sequence"], "")
        # Its spliced transcript still reads: having no CDS is not having no
        # sequence.
        whole = self.api.get("/transcript-sequence", genome="g", transcript_id="TX_N")
        self.assertEqual(whole["status"], "ok")
        self.assertEqual(whole["length"], 40)

    def test_an_unknown_kind_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/transcript-sequence", genome="g", transcript_id="TX_P", kind="genomic")
        self.assertEqual(caught.exception.status_code, 400)

    def test_a_missing_transcript_is_a_404(self):
        with self.assertRaises(HTTPException) as caught:
            self.api.get("/transcript-sequence", genome="g", transcript_id="NOPE")
        self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()

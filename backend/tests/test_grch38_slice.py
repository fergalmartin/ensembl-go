"""The chromosome-1 slice the genome browser tutorial runs on.

Two things make this genome different from the demo one, and both are what these tests
are guarding.

**Its coordinates are real.** The FASTA record is chromosome ``1`` padded with ``N`` up to
the window, so REG4 answers at 1:119,794,017 exactly as it does on the Ensembl website.
That is the entire justification for shipping a megabyte of mostly-nothing, and a build
script that quietly re-sliced to a different offset would take it away without breaking
anything visible.

**Its annotation is real Ensembl annotation**, which the tutorial then leans on: PHGDH has
thirty-eight transcripts for the flatten step, four gene classes for the filter step, and
REG4 has a MANE Select transcript for the drawer step. Those counts are load-bearing
enough to be worth pinning.
"""

import asyncio
import gzip
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import demo_genome  # noqa: E402
import main  # noqa: E402

SLICE = demo_genome.SLICE_GENOME
CHROM = "1"
REGION_START = 118_440_000
REGION_END = 120_120_000
REG4_START, REG4_END = 119_794_017, 119_811_580
REG4_GENE_ID = "ENSG00000134193"
REG4_MANE = "ENST00000256585"
TBX15_CANONICAL = "ENST00000369429"


def _annotation_lines():
    path = demo_genome.demo_source_dir(SLICE.genome_id) / "grch38_reg4.gff3.gz"
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return [line.rstrip("\n") for line in handle if not line.startswith("#")]


def _attr(attrs, key):
    for piece in attrs.split(";"):
        if piece.startswith(f"{key}="):
            return piece[len(key) + 1:]
    return ""


class SliceFixtureTests(unittest.TestCase):
    def test_the_bundled_fixture_is_present_and_named_as_the_installer_expects(self):
        source = demo_genome.demo_source_dir(SLICE.genome_id)
        self.assertTrue(source.is_dir(), f"missing bundled slice at {source}")
        for name in SLICE.files:
            self.assertTrue((source / name).is_file(), f"missing {name}")

    def test_the_fixture_stays_small_enough_to_ship(self):
        source = demo_genome.demo_source_dir(SLICE.genome_id)
        total = sum(p.stat().st_size for p in source.iterdir() if p.is_file())
        # Most of this is the N padding that buys the real coordinates. It compresses at
        # roughly a thousand to one, so a budget well under a megabyte still leaves room
        # for a wider window without hiding a mistake that stopped the padding working.
        self.assertLess(total, 1_500 * 1024, "the chromosome-1 slice has grown past a comfortable bundle size")

    def test_the_sequence_sits_at_its_true_chromosome_coordinates(self):
        import pysam

        fasta = demo_genome.demo_source_dir(SLICE.genome_id) / "grch38_reg4.fa.bgz"
        with pysam.FastaFile(str(fasta)) as handle:
            self.assertEqual(list(handle.references), [CHROM])
            self.assertEqual(list(handle.lengths), [REGION_END])
            # Everything before the window is padding, and the window itself is not.
            self.assertEqual(set(handle.fetch(CHROM, 0, 1000)), {"N"})
            self.assertEqual(set(handle.fetch(CHROM, REGION_START - 1001, REGION_START - 1)), {"N"})
            reg4 = handle.fetch(CHROM, REG4_START - 1, REG4_END)
            self.assertEqual(len(reg4), REG4_END - REG4_START + 1)
            self.assertNotIn("N", reg4)
            self.assertEqual(set(reg4) - set("ACGT"), set(), "the slice should be uppercase unmasked bases")

    def test_the_annotation_keeps_its_real_coordinates(self):
        genes = {
            _attr(line.split("\t")[8], "Name"): (int(line.split("\t")[3]), int(line.split("\t")[4]))
            for line in _annotation_lines()
            if _attr(line.split("\t")[8], "ID").startswith("gene:")
        }
        self.assertEqual(genes.get("REG4"), (REG4_START, REG4_END))
        for start, end in genes.values():
            self.assertGreaterEqual(start, REGION_START)
            self.assertLessEqual(end, REGION_END)

    def test_no_feature_is_orphaned_by_the_slicing(self):
        """A child whose parent fell outside the window would index into nothing."""
        seen = set()
        for line in _annotation_lines():
            attrs = line.split("\t")[8]
            parent = _attr(attrs, "Parent")
            if parent:
                self.assertIn(parent, seen, f"{parent} is referenced before it is defined")
            identifier = _attr(attrs, "ID")
            if identifier:
                seen.add(identifier)

    def test_the_genes_the_tutorial_names_are_there(self):
        names = {
            _attr(line.split("\t")[8], "Name")
            for line in _annotation_lines()
            if _attr(line.split("\t")[8], "ID").startswith("gene:")
        }
        for gene in ("REG4", "PHGDH", "HMGCS2", "NOTCH2", "ZNF697", "ADAM30", "TBX15", "WARS2", "HAO2", "HSD3B1"):
            self.assertIn(gene, names)


    def test_the_coding_exon_the_sequence_step_zooms_onto_is_there(self):
        """The 121-base window has to hold a whole coding exon, or the step lands on a
        fragment and the point — a coding exon, entire, letter by letter — is lost."""
        wanted = (118_926_510, 118_926_611)
        pieces = [
            (int(line.split("\t")[3]), int(line.split("\t")[4]))
            for line in _annotation_lines()
            if line.split("\t")[2] == "CDS" and TBX15_CANONICAL in line.split("\t")[8]
        ]
        self.assertIn(wanted, pieces, "TBX15's coding exon has moved")
        self.assertEqual(wanted[1] - wanted[0] + 1, 102)

    def test_tbx15_is_on_the_reverse_strand_and_has_three_transcripts(self):
        """Both are said out loud on the card, and the card is placed above the reverse
        track because of the first of them."""
        genes = {
            _attr(line.split("\t")[8], "Name"): line.split("\t")[6]
            for line in _annotation_lines()
            if _attr(line.split("\t")[8], "ID").startswith("gene:")
        }
        self.assertEqual(genes.get("TBX15"), "-")
        transcripts = [
            line for line in _annotation_lines()
            if _attr(line.split("\t")[8], "Parent") == "gene:ENSG00000092607"
        ]
        self.assertEqual(len(transcripts), 3)


class SliceIndexTests(unittest.TestCase):
    """What the browser actually reads: the SQLite index built from the annotation."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        workspace = demo_genome.tutorial_workspace(cls._tmp.name)
        workspace.mkdir(parents=True, exist_ok=True)
        cls.workspace = str(workspace)
        cls.status = asyncio.new_event_loop().run_until_complete(
            main.post_demo_genome_install(
                main.DemoGenomeInstallRequest(output_dir=cls.workspace, genome_id=SLICE.genome_id)
            )
        )

    @classmethod
    def tearDownClass(cls):
        demo_genome.clear_tutorial_session_genome()
        cls._tmp.cleanup()

    def _rows(self, sql):
        import sqlite3

        _gff, db_path = demo_genome.demo_index_target(self.workspace, SLICE.genome_id)
        with sqlite3.connect(db_path) as conn:
            return conn.execute(sql).fetchall()

    def test_it_installs_and_indexes_in_one_go(self):
        self.assertTrue(self.status["installed"])
        self.assertNotIn("index_error", self.status)

    def test_the_biotypes_survived_the_slicing(self):
        """The indexer reads ``biotype=``, which is Ensembl's spelling and not GENCODE's.

        Slicing a GENCODE GTF instead would index every gene with an empty biotype, and
        the tutorial's gene-class filter step would have nothing to filter.
        """
        classes = dict(self._rows("SELECT biotype, COUNT(*) FROM genes GROUP BY biotype"))
        self.assertEqual(classes.get("protein_coding"), 11)
        self.assertEqual(classes.get("lncRNA"), 27)
        self.assertEqual(self._rows("SELECT COUNT(*) FROM genes WHERE COALESCE(biotype, '') = ''")[0][0], 0)
        # Protein-coding, lncRNA and two flavours of pseudogene: enough that unticking
        # the other three classes visibly empties the track.
        self.assertGreaterEqual(len(classes), 4)

    def test_the_genes_with_many_transcripts_are_still_deep(self):
        counts = dict(
            self._rows(
                "SELECT g.name, COUNT(t.id) FROM genes g JOIN transcripts t "
                "ON t.parent_gene_id = g.id GROUP BY g.id"
            )
        )
        # The flatten/detail steps are only worth watching because of these two.
        self.assertEqual(counts.get("PHGDH"), 38)
        self.assertEqual(counts.get("HMGCS2"), 22)
        self.assertEqual(counts.get("REG4"), 5)
        self.assertEqual(counts.get("HSD3B1"), 5)
        # TBX15 is where the pan-and-zoom step travels to, far enough upstream that
        # getting there reads as a journey — and where the per-gene transcript pill is
        # taught. Three is the number the card says out loud: the pill reads "+2", and two
        # extra rows appear together rather than running off the bottom of the window.
        self.assertEqual(counts.get("TBX15"), 3)

    def test_reg4_is_where_the_tutorial_says_it_is(self):
        row = self._rows(f"SELECT chrom, start, end, strand FROM genes WHERE id = '{REG4_GENE_ID}'")
        self.assertEqual(row, [(CHROM, REG4_START, REG4_END, "-")])

    def test_reg4_has_a_canonical_transcript_for_the_drawer_to_pin(self):
        canonical = self._rows(
            f"SELECT id FROM transcripts WHERE parent_gene_id = '{REG4_GENE_ID}' AND is_canonical = 1"
        )
        self.assertEqual(canonical, [(REG4_MANE,)])

    def test_the_browser_resolves_it_and_answers_at_real_coordinates(self):
        record = {
            "species_key": SLICE.species_key,
            "assembly": SLICE.assembly,
            "provider": SLICE.provider,
            "files": self.status["files"],
        }
        demo_genome.set_tutorial_session_genome(record)
        loop = asyncio.new_event_loop()
        genome = f"{SLICE.provider}::{SLICE.species_key}::{SLICE.assembly}"

        original = main.load_config
        main.load_config = lambda: {"output_dir": self.workspace, "active_species": []}
        try:
            regions = loop.run_until_complete(main.browse_regions(genome=genome))
            region = regions[0].model_dump() if hasattr(regions[0], "model_dump") else dict(regions[0])
            self.assertEqual(region["chrom"], CHROM)
            self.assertEqual(region["end"], REGION_END)
            # Declared so the browser will not let anyone pan out into the padding.
            self.assertEqual(region["browsable_start"], REGION_START)
            self.assertEqual(region["browsable_end"], REGION_END)
            self.assertEqual(region["gene_count"], 58)

            genes = loop.run_until_complete(
                main.browse_genes(genome=genome, chrom=CHROM, start=REG4_START, end=REG4_END)
            )
            names = [(g.model_dump() if hasattr(g, "model_dump") else dict(g))["name"] for g in genes]
            self.assertIn("REG4", names)
        finally:
            main.load_config = original


class BundledGenomeRegistryTests(unittest.TestCase):
    def tearDown(self):
        demo_genome.clear_tutorial_session_genome()

    def test_both_bundled_genomes_are_registered_and_distinct(self):
        keys = {g.species_key for g in demo_genome.BUNDLED_GENOMES.values()}
        self.assertEqual(len(keys), len(demo_genome.BUNDLED_GENOMES))
        # Claiming the real GRCh38 accession would put the slice in the same directory as
        # a genuinely downloaded human genome.
        self.assertNotEqual(SLICE.assembly, "GCA_000001405.29")
        self.assertNotEqual(SLICE.species_key, "homo_sapiens")

    def test_a_tutorial_may_register_either_bundled_genome(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = demo_genome.tutorial_workspace(tmp)
            for genome in demo_genome.BUNDLED_GENOMES.values():
                demo_genome.set_tutorial_session_genome({
                    "species_key": genome.species_key,
                    "files": {"fasta": str(workspace / "local_data" / "x.fa")},
                })
        registered = {record["species_key"] for record in demo_genome.tutorial_session_species()}
        self.assertEqual(registered, {g.species_key for g in demo_genome.BUNDLED_GENOMES.values()})

    def test_it_still_refuses_anything_else(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = demo_genome.tutorial_workspace(tmp)
            with self.assertRaises(ValueError):
                demo_genome.set_tutorial_session_genome({
                    "species_key": "homo_sapiens",
                    "files": {"fasta": str(workspace / "a.fa")},
                })
        self.assertEqual(demo_genome.tutorial_session_species(), [])

    def test_the_workspace_is_remembered_only_while_a_tutorial_runs(self):
        self.assertIsNone(demo_genome.tutorial_session_workspace())
        with tempfile.TemporaryDirectory() as tmp:
            workspace = demo_genome.tutorial_workspace(tmp)
            demo_genome.set_tutorial_session_genome({
                "species_key": SLICE.species_key,
                "files": {"fasta": str(workspace / "local_data" / "x.fa")},
            })
            self.assertEqual(demo_genome.tutorial_session_workspace(), str(workspace))
        demo_genome.clear_tutorial_session_genome()
        self.assertIsNone(demo_genome.tutorial_session_workspace())


class TutorialNotesStayInTheSandboxTests(unittest.TestCase):
    """A note taken during a tutorial must not reach the user's own notes.

    This is not covered by the frontend's configuration override: the notes endpoints
    resolve their store from ``load_config()``, which reads the configuration on disk, so
    before ``main._notes_config`` existed a note written during a tutorial landed in the
    user's real notes file and stayed there after the tutorial was over.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.output_dir = Path(self._tmp.name) / "output"
        (self.output_dir / "local_data").mkdir(parents=True)
        self.workspace = demo_genome.tutorial_workspace(str(self.output_dir))
        (self.workspace / "local_data").mkdir(parents=True)
        self._original_load_config = main.load_config
        main.load_config = lambda: {"output_dir": str(self.output_dir)}
        self.loop = asyncio.new_event_loop()

    def tearDown(self):
        main.load_config = self._original_load_config
        demo_genome.clear_tutorial_session_genome()
        self._tmp.cleanup()

    def _create(self, title):
        return self.loop.run_until_complete(
            main.create_user_note(
                main.UserNoteCreateRequest(
                    target={"kind": "gene", "genome_key": "g", "id": REG4_GENE_ID},
                    title=title,
                    body="…",
                )
            )
        )

    def _titles(self):
        listed = self.loop.run_until_complete(main.list_user_notes())
        notes = listed["notes"] if isinstance(listed, dict) else listed.notes
        return [n["title"] if isinstance(n, dict) else n.title for n in notes]

    def _start_tutorial(self):
        demo_genome.set_tutorial_session_genome({
            "species_key": SLICE.species_key,
            "files": {"fasta": str(self.workspace / "local_data" / "x.fa")},
        })

    def test_a_note_taken_during_a_tutorial_never_reaches_the_users_store(self):
        self._create("mine")
        user_store = self.output_dir / "local_data" / "user_notes.json"
        before = user_store.read_bytes()

        self._start_tutorial()
        self._create("the tutorial's")
        self.assertEqual(user_store.read_bytes(), before, "the tutorial wrote to the user's notes")
        self.assertTrue((self.workspace / "local_data" / "user_notes.json").is_file())

    def test_the_two_stores_do_not_see_each_other(self):
        self._create("mine")
        self._start_tutorial()
        self._create("the tutorial's")
        self.assertEqual(self._titles(), ["the tutorial's"], "the user's notes leaked into the tutorial")

        demo_genome.clear_tutorial_session_genome()
        self.assertEqual(self._titles(), ["mine"], "the tutorial's note outlived the tutorial")


if __name__ == "__main__":
    unittest.main()

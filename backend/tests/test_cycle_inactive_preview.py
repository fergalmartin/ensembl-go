"""Cycle can browse the saved selection pool without activating its genomes."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class CyclePreviewTests(unittest.TestCase):
    def test_inactive_context_resolves_without_mutating_active_selection(self):
        genome = {"species_key": "human", "assembly": "GCA_000001405.29", "files": {"gff3": "/test/human.gff3", "index": "/test/human.db"}}
        config = {"active_species": [], "next_previous_session_genomes": [genome]}
        key = main._active_species_item_key(genome)
        with patch.object(main, "load_config", return_value=config), patch.object(main, "tutorial_session_species", return_value=[]), patch.object(main, "_browse_index_for", return_value="/test/human.db"):
            context = main._resolve_browse_genome_context(key)
        self.assertEqual(context["gff_path"], "/test/human.gff3")
        self.assertEqual(config["active_species"], [])

    def test_live_record_wins_over_saved_snapshot(self):
        live = {"species_key": "human", "assembly": "GCA_000001405.29", "files": {"gff3": "/new.gff"}}
        snapshot = {**live, "files": {"gff3": "/old.gff"}}
        with patch.object(main, "tutorial_session_species", return_value=[]):
            genomes = main._browsable_active_species({"active_species": [live], "next_previous_session_genomes": [snapshot]})
        self.assertEqual(genomes, [live])

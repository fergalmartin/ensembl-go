"""The record format must drive the same datasets as JSON and survive app edits."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv_config import (
    config_to_datasets, has_errors, parse_sv_config,
    serialize_sv_key_value_config,
)

RECORD = """# Required fields
label = First alignment
reference_accession = GCA_000001405.29
target_accession = GCA_018472595.2
chain = chains/alt_a_to_ref_b.bigChain.bb
indexed_side = target

# Optional fields
reference_assembly_name = GRCh38.p14
target_assembly_name = HG00438_pat_hprc_f2
target_mapping = mappings/hg00438.tsv
target_sequence_alias.CM089167.1 = 1
target_track.1.path = tracks/coverage.bw
target_track.1.label = Coverage
target_track.2.path = tracks/intervals.bb
"""


class KeyValueConfigTests(unittest.TestCase):
    def test_multiple_records_resolve_paths_and_metadata(self):
        second = RECORD.replace('First alignment', 'Second alignment').replace(
            'GCA_018472595.2', 'GCA_018506975.2').replace(
            'HG00438_pat_hprc_f2', 'HG00733_mat_hprc_f2')
        config, diagnostics = parse_sv_config(RECORD + '\n---\n' + second, Path('/data'))
        self.assertEqual(diagnostics, [])
        datasets = config_to_datasets(config)
        self.assertEqual(len(datasets), 2)
        self.assertEqual(len(config['genomes']), 3)
        self.assertEqual(datasets[0]['chain_path'], '/data/chains/alt_a_to_ref_b.bigChain.bb')
        self.assertEqual(datasets[0]['tgt_mapping_path'], '/data/mappings/hg00438.tsv')
        self.assertEqual(datasets[0]['target_sequence_aliases'], {'CM089167.1': '1'})
        self.assertEqual([t['type'] for t in datasets[0]['tracks']['target']], ['bigwig', 'bigbed'])

    def test_duplicate_and_unknown_fields_report_exact_lines(self):
        for suffix, message in [('label = Other', 'Duplicate'), ('taget_accession = Wrong', 'Unknown')]:
            text = RECORD + suffix + '\n'
            _, diagnostics = parse_sv_config(text)
            hit = next(item for item in diagnostics if message in item['message'])
            self.assertEqual(hit['line'], len(text.splitlines()))
            self.assertTrue(has_errors(diagnostics))

    def test_semantic_errors_point_to_the_second_record(self):
        text = RECORD + '\n---\n' + RECORD.replace('indexed_side = target', 'indexed_side = wrong')
        _, diagnostics = parse_sv_config(text)
        error = next(item for item in diagnostics if 'indexed_side must be' in item['message'])
        self.assertEqual(error['line'], next(n for n, line in enumerate(text.splitlines(), 1) if line == 'indexed_side = wrong'))
        duplicate = next(item for item in diagnostics if 'already used' in item['message'])
        self.assertEqual(duplicate['line'], [n for n, line in enumerate(text.splitlines(), 1) if line == 'label = First alignment'][1])

    def test_all_required_fields_are_checked(self):
        for key in ('label', 'reference_accession', 'target_accession', 'chain', 'indexed_side'):
            with self.subTest(key=key):
                text = '\n'.join(line for line in RECORD.splitlines() if not line.startswith(key + ' ='))
                _, diagnostics = parse_sv_config(text)
                self.assertTrue(has_errors(diagnostics))
                self.assertTrue(all(d['line'] > 0 for d in diagnostics if d['severity'] == 'error'))

    def test_literal_values_and_optional_blanks(self):
        config, diagnostics = parse_sv_config(RECORD + 'description = a # b = c\\d\nreference_mapping =\n')
        self.assertEqual(diagnostics, [])
        self.assertEqual(config_to_datasets(config)[0]['description'], 'a # b = c\\d')
        self.assertEqual(config_to_datasets(config)[0]['ref_mapping_path'], '')

    def test_incomplete_track_reports_its_source_line(self):
        text = RECORD + 'reference_track.5.label = Missing path\n'
        _, diagnostics = parse_sv_config(text)
        hit = next(item for item in diagnostics if 'needs a path' in item['message'])
        self.assertEqual(hit['line'], len(text.splitlines()))

    def test_conflicting_shared_genome_metadata_is_refused(self):
        second = RECORD.replace('First alignment', 'Second alignment').replace('GRCh38.p14', 'Different name')
        _, diagnostics = parse_sv_config(RECORD + '\n---\n' + second)
        self.assertTrue(any('Conflicting assembly_name' in d['message'] for d in diagnostics))

    def test_round_trip_retains_ids_tracks_aliases_and_mapping_paths(self):
        original, diagnostics = parse_sv_config(RECORD + 'id = original-id\ntarget_aliases = HG00438.1\ndescription = "First\\nSecond"\n', Path('/data'))
        self.assertEqual(diagnostics, [])
        written = serialize_sv_key_value_config(original, Path('/data'))
        self.assertIn('chain = chains/', written)
        reread, diagnostics = parse_sv_config(written, Path('/data'))
        self.assertEqual(diagnostics, [])
        before, after = config_to_datasets(original)[0], config_to_datasets(reread)[0]
        for key in ('id', 'label', 'description', 'chain_path', 'indexed_side', 'tgt_mapping_path', 'tracks', 'target_sequence_aliases', 'tgt_aliases'):
            self.assertEqual(before[key], after[key], key)
        self.assertLess(written.index('indexed_side ='), written.index('# Optional fields'))

    def test_empty_generated_config_is_readable_after_last_alignment_is_removed(self):
        config, _ = parse_sv_config({'genomes': {}, 'pairs': []})
        reread, diagnostics = parse_sv_config(serialize_sv_key_value_config(config))
        self.assertEqual(diagnostics, [])
        self.assertEqual(config_to_datasets(reread), [])

    def test_repo_template_parses_as_two_records(self):
        path = Path(__file__).resolve().parents[2] / 'docs/examples/sv-alignments.template.cfg'
        config, diagnostics = parse_sv_config(path.read_text(), path.parent)
        self.assertEqual(diagnostics, [])
        self.assertEqual(len(config_to_datasets(config)), 2)


if __name__ == '__main__':
    unittest.main()

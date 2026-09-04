"""Editing a tutorial's wording from inside the running app.

An application rewriting its own source is not a thing to be relaxed about, so most of
what is tested here is what the rewriter refuses to do and how little of the file it
touches when it does something.
"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tutorial_authoring  # noqa: E402

SOURCE = """import { THING } from './thing.js'

const SECTION = Object.freeze({
  opening: 'Opening section',
})

export default {
  id: 'demo-tutorial',
  title: 'Demo',
  steps: [
    {
      id: 'first',
      section: SECTION.opening,
      placement: 'center',
      title: 'The first step',
      body: 'A body that runs over '
        + 'two lines.',
    },
    {
      id: 'second',
      section: SECTION.opening,
      anchor: 'somewhere',
      title: 'The second step',
      body: `Interpolated ${THING.name} in the middle.`,
      copy: '1:100-200',
    },
  ],
}
"""


class RewriteTests(unittest.TestCase):
    def test_it_replaces_a_single_line_value(self):
        out, _ = tutorial_authoring.rewrite_step_field(SOURCE, 'first', 'title', 'A better title')
        self.assertIn("title: 'A better title',", out)
        self.assertIn("title: 'The second step',", out, "it edited the wrong step")

    def test_it_replaces_a_value_spread_over_several_lines(self):
        out, _ = tutorial_authoring.rewrite_step_field(SOURCE, 'first', 'body', 'Short now.')
        self.assertIn("body: 'Short now.',", out)
        self.assertNotIn('two lines.', out)
        # The step around it is untouched.
        self.assertIn("placement: 'center',", out)
        self.assertIn("id: 'second',", out)

    def test_a_long_value_is_wrapped_the_way_the_definitions_are(self):
        long_value = ' '.join(['word'] * 60)
        out, _ = tutorial_authoring.rewrite_step_field(SOURCE, 'first', 'body', long_value)
        lines = [line for line in out.splitlines() if 'word' in line]
        self.assertGreater(len(lines), 1, 'a long value should wrap')
        # Nothing creeps past the column the rest of the file stops at.
        self.assertTrue(
            all(len(line) <= tutorial_authoring.WRAP_COLUMN for line in lines),
            f'longest line was {max(len(line) for line in lines)}',
        )
        # The first line carries the field name; every line after it carries the join.
        self.assertTrue(lines[0].strip().startswith("body: '"))
        self.assertTrue(all(line.strip().startswith("+ '") for line in lines[1:]))
        # And the pieces still join back into the sentence they came from.
        self.assertIn('word word', out)

    def test_an_apostrophe_survives_the_round_trip(self):
        out, _ = tutorial_authoring.rewrite_step_field(SOURCE, 'first', 'title', "The gene's name")
        self.assertIn(r"title: 'The gene\'s name',", out)

    def test_it_says_when_an_interpolated_value_has_been_written_out(self):
        _out, dropped = tutorial_authoring.rewrite_step_field(SOURCE, 'second', 'body', 'Plain text now.')
        self.assertTrue(dropped, 'a template literal loses its expressions and must say so')
        _out, kept = tutorial_authoring.rewrite_step_field(SOURCE, 'first', 'body', 'Plain text.')
        self.assertFalse(kept)

    def test_its_own_output_can_be_edited_again(self):
        once, _ = tutorial_authoring.rewrite_step_field(SOURCE, 'first', 'body', 'One.')
        twice, _ = tutorial_authoring.rewrite_step_field(once, 'first', 'body', 'Two.')
        self.assertIn("body: 'Two.',", twice)
        self.assertNotIn("body: 'One.',", twice)

    def test_it_refuses_anything_structural(self):
        for field in ('anchor', 'placement', 'advanceOn', 'ensure', 'id'):
            with self.assertRaises(ValueError, msg=f'{field} should not be editable'):
                tutorial_authoring.rewrite_step_field(SOURCE, 'first', field, 'x')

    def test_it_refuses_an_unknown_step_or_an_empty_value(self):
        with self.assertRaises(ValueError):
            tutorial_authoring.rewrite_step_field(SOURCE, 'nowhere', 'title', 'x')
        with self.assertRaises(ValueError):
            tutorial_authoring.rewrite_step_field(SOURCE, 'first', 'title', '   ')

    def test_it_refuses_a_field_the_step_does_not_have(self):
        with self.assertRaises(ValueError):
            tutorial_authoring.rewrite_step_field(SOURCE, 'first', 'copy', 'x')

    def test_it_changes_nothing_but_the_field(self):
        out, _ = tutorial_authoring.rewrite_step_field(SOURCE, 'second', 'copy', '1:300-400')
        self.assertEqual(out.count("id: '"), SOURCE.count("id: '"))
        self.assertEqual(out.count('{'), SOURCE.count('{'))
        self.assertEqual(out.count('}'), SOURCE.count('}'))
        self.assertIn("import { THING } from './thing.js'", out)
        self.assertIn("copy: '1:300-400',", out)

    def test_a_normalized_card_position_can_be_inserted_and_moved_again(self):
        positioned = tutorial_authoring.rewrite_step_position(SOURCE, 'first', 0.125, 0.8)
        self.assertIn("placement: 'center',\n      cardPosition: { x: 0.125, y: 0.8 },", positioned)
        moved = tutorial_authoring.rewrite_step_position(positioned, 'first', 0.9, 0.05)
        self.assertEqual(moved.count('cardPosition:'), 1)
        self.assertIn('cardPosition: { x: 0.9, y: 0.05 },', moved)

    def test_card_edges_can_be_resized_independently(self):
        widened = tutorial_authoring.rewrite_step_size(SOURCE, 'first', width=440)
        self.assertIn('cardSize: { width: 440 },', widened)
        taller = tutorial_authoring.rewrite_step_size(widened, 'first', height=280)
        self.assertIn('cardSize: { width: 440, height: 280 },', taller)
        widened_again = tutorial_authoring.rewrite_step_size(taller, 'first', width=460)
        self.assertIn('cardSize: { width: 460, height: 280 },', widened_again)

    def test_card_dimensions_must_be_positive_and_finite(self):
        for value in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                tutorial_authoring.rewrite_step_size(SOURCE, 'first', width=value)

    def test_a_position_on_a_step_last_line_can_be_moved_again(self):
        """The card position as a step's final property, which is where a rewrite put it.

        These searches are bounded to one step, and a bounded search offers `$` at the end
        of the truncated text as well as before a newline — so a greedy trailing `\\s*`
        walked past the line ending, ate the next line's indent, and pulled the step's
        closing brace up onto the position line. The step then had no readable closing
        brace and every later save failed with "the saved card position could not be read
        back".
        """
        source = SOURCE.replace(
            "      title: 'The first step',",
            "      title: 'The first step',\n      cardPosition: { x: 0.1, y: 0.2 },",
        )
        # The position is the last property before the step's closing brace.
        source = source.replace(
            "      cardPosition: { x: 0.1, y: 0.2 },\n      body:",
            "      body:",
        ).replace(
            "        + 'two lines.',\n    },",
            "        + 'two lines.',\n      cardPosition: { x: 0.1, y: 0.2 },\n    },",
        )
        self.assertIn("cardPosition: { x: 0.1, y: 0.2 },\n    },", source)

        moved = tutorial_authoring.rewrite_step_position(source, 'first', 0.3, 0.4)
        self.assertIn("cardPosition: { x: 0.3, y: 0.4 },\n    },", moved)
        # And it survives its own read-back, which is what actually failed.
        self.assertEqual(tutorial_authoring._read_step_position(moved, 'first'), (0.3, 0.4))
        # Twice, because the damage only showed on the save after the one that caused it.
        again = tutorial_authoring.rewrite_step_position(moved, 'first', 0.5, 0.6)
        self.assertEqual(tutorial_authoring._read_step_position(again, 'first'), (0.5, 0.6))

    def test_a_size_on_a_step_last_line_can_be_resized_again(self):
        source = SOURCE.replace(
            "        + 'two lines.',\n    },",
            "        + 'two lines.',\n      cardSize: { width: 440 },\n    },",
        )
        resized = tutorial_authoring.rewrite_step_size(source, 'first', width=500)
        self.assertIn("cardSize: { width: 500 },\n    },", resized)
        self.assertEqual(tutorial_authoring._read_step_size(resized, 'first'), {'width': 500})

    def test_a_card_position_is_refused_outside_the_normalized_viewport(self):
        for x, y in ((-0.1, 0.5), (1.1, 0.5), (0.5, float('nan'))):
            with self.assertRaises(ValueError):
                tutorial_authoring.rewrite_step_position(SOURCE, 'first', x, y)


class RealDefinitionTests(unittest.TestCase):
    """Against the definitions that actually ship, since those are what it edits."""

    def test_it_finds_the_file_for_each_registered_tutorial(self):
        for tutorial_id in ('getting-started', 'browser-in-depth'):
            self.assertIsNotNone(
                tutorial_authoring.find_tutorial_file(tutorial_id),
                f'no definition file found for {tutorial_id}',
            )

    def test_every_step_of_the_browser_tutorial_can_be_edited(self):
        """A step whose value the scanner cannot walk would fail only when someone tried."""
        path = tutorial_authoring.find_tutorial_file('browser-in-depth')
        source = path.read_text(encoding='utf-8')
        import re

        for step_id in re.findall(r"id: '([a-z0-9-]+)',", source):
            for field in ('title', 'body'):
                try:
                    tutorial_authoring.rewrite_step_field(source, step_id, field, 'Replacement text.')
                except ValueError as exc:
                    if 'has no' in str(exc):
                        continue  # not every step has every field
                    self.fail(f'{step_id}.{field} could not be rewritten: {exc}')


class ReferencedValueTests(unittest.TestCase):
    """Fields that name a constant instead of spelling their words out.

    `copy: SLICE_WHOLE_REGION` is the case that sent someone round in circles: the scanner
    reported "not a string literal", which is true and useless. Following the reference is
    right when it lands on plain text, and refusing is right when it does not — but either
    way the answer has to say where the words actually are.
    """

    def _files(self, constant_value):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)
        (directory / 'shared.js').write_text(
            f"export const A_REGION = {constant_value}\n", encoding='utf-8'
        )
        (directory / 'demo.js').write_text(
            "import { A_REGION } from './shared.js'\n\n"
            "export default {\n"
            "  id: 'demo-tutorial',\n"
            "  steps: [\n"
            "    {\n"
            "      id: 'first',\n"
            "      title: 'A step',\n"
            "      body: 'Words.',\n"
            "      copy: A_REGION,\n"
            "    },\n"
            "  ],\n"
            "}\n",
            encoding='utf-8',
        )
        original = tutorial_authoring.tutorials_dir
        tutorial_authoring.tutorials_dir = lambda: directory
        self.addCleanup(lambda: setattr(tutorial_authoring, 'tutorials_dir', original))
        return directory

    def test_a_plain_constant_is_followed_and_edited_where_it_lives(self):
        directory = self._files("'1:100-200'")
        result = tutorial_authoring.save_step_field('demo-tutorial', 'first', 'copy', '1:300-400')
        self.assertTrue(result['saved'])
        self.assertEqual(result['followed'], 'A_REGION')
        self.assertTrue(result['file'].endswith('shared.js'))
        self.assertIn("export const A_REGION = '1:300-400'", (directory / 'shared.js').read_text())
        # The step still points at the constant rather than having it pasted in.
        self.assertIn('copy: A_REGION,', (directory / 'demo.js').read_text())

    def test_a_section_heading_is_edited_at_its_shared_local_constant(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'demo.js').write_text(SOURCE, encoding='utf-8')
            original = tutorial_authoring.tutorials_dir
            tutorial_authoring.tutorials_dir = lambda: directory
            try:
                result = tutorial_authoring.save_step_field(
                    'demo-tutorial', 'first', 'section', 'A clearer opening'
                )
                updated = (directory / 'demo.js').read_text(encoding='utf-8')
                self.assertTrue(result['saved'])
                self.assertEqual(result['followed'], 'SECTION.opening')
                self.assertTrue(result['file'].endswith('demo.js'))
                self.assertIn("opening: 'A clearer opening',", updated)
                self.assertEqual(updated.count('section: SECTION.opening,'), 2)

                # A second save through another card follows the same reference again;
                # the first save must not have expanded either step into a literal.
                tutorial_authoring.save_step_field(
                    'demo-tutorial', 'second', 'section', 'Opening and orientation'
                )
                saved_again = (directory / 'demo.js').read_text(encoding='utf-8')
                self.assertIn("opening: 'Opening and orientation',", saved_again)
                self.assertEqual(saved_again.count('section: SECTION.opening,'), 2)
            finally:
                tutorial_authoring.tutorials_dir = original

    def test_a_computed_constant_is_refused_and_says_where_to_go(self):
        self._files('locus(START, END)')
        with self.assertRaises(ValueError) as caught:
            tutorial_authoring.save_step_field('demo-tutorial', 'first', 'copy', '1:300-400')
        message = str(caught.exception)
        self.assertIn('A_REGION', message)
        self.assertIn('locus(START, END)', message, 'the whole expression, not half of it')
        self.assertIn('shared.js', message, 'it has to say which file to open')

    def test_the_real_search_step_reports_the_constant_behind_its_copy_value(self):
        """The one someone actually hit."""
        path = tutorial_authoring.find_tutorial_file('browser-in-depth')
        before = path.read_text(encoding='utf-8')
        with self.assertRaises(ValueError) as caught:
            tutorial_authoring.save_step_field('browser-in-depth', 'search', 'copy', '1:1-2')
        message = str(caught.exception)
        # Not the constant's name — that changes when the step's destination does. What
        # has to hold is that the refusal names a constant and the file to open, rather
        # than the "not a string literal" it used to say.
        self.assertIn('sliceGenome.js', message)
        self.assertRegex(message, r'\b[A-Z][A-Z0-9_]{3,}\b', 'it should name the constant')
        self.assertNotIn('not a string literal', message)
        # And a refusal leaves the file exactly as it found it.
        self.assertEqual(path.read_text(encoding='utf-8'), before)


class SaveTests(unittest.TestCase):
    def test_saving_is_refused_when_there_is_no_source_to_edit(self):
        original = tutorial_authoring.tutorials_dir
        tutorial_authoring.tutorials_dir = lambda: None
        try:
            self.assertFalse(tutorial_authoring.is_available())
            with self.assertRaises(ValueError):
                tutorial_authoring.save_step_field('browser-in-depth', 'welcome', 'title', 'x')
        finally:
            tutorial_authoring.tutorials_dir = original

    def test_saving_writes_the_file_and_leaves_no_temporary_behind(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'demo.js').write_text(SOURCE, encoding='utf-8')
            original = tutorial_authoring.tutorials_dir
            tutorial_authoring.tutorials_dir = lambda: directory
            try:
                result = tutorial_authoring.save_step_field('demo-tutorial', 'first', 'title', 'Edited')
                self.assertTrue(result['saved'])
                self.assertIn("title: 'Edited',", (directory / 'demo.js').read_text(encoding='utf-8'))
                self.assertEqual([p.name for p in directory.iterdir()], ['demo.js'])
            finally:
                tutorial_authoring.tutorials_dir = original

    def test_saving_a_dragged_position_writes_the_step_and_leaves_no_temporary_behind(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'demo.js').write_text(SOURCE, encoding='utf-8')
            original = tutorial_authoring.tutorials_dir
            tutorial_authoring.tutorials_dir = lambda: directory
            try:
                result = tutorial_authoring.save_step_position('demo-tutorial', 'first', 0.2, 0.3)
                self.assertTrue(result['saved'])
                self.assertIn(
                    'cardPosition: { x: 0.2, y: 0.3 },',
                    (directory / 'demo.js').read_text(encoding='utf-8'),
                )
                self.assertEqual([p.name for p in directory.iterdir()], ['demo.js'])
            finally:
                tutorial_authoring.tutorials_dir = original


DOCUMENT = {
    'format': 'ensembl-go-tutorial',
    'schemaVersion': 1,
    'id': 'demo-tutorial',
    'title': 'Demo',
    'steps': [
        {'id': 'first', 'section': 'Opening section', 'title': 'The first step', 'body': 'A body that runs over two lines.'},
        {'id': 'second', 'section': 'Opening section', 'title': 'The second step', 'body': 'Interpolated thing in the middle.', 'copy': '1:100-200'},
    ],
}


class DocumentTests(unittest.TestCase):
    """The words are played from a portable document, so an edit has to reach it.

    Writing only the JavaScript is the bug these cover: the rewrite succeeds, the card
    says it saved, and the reader sees the old sentence because playback never opens that
    file.
    """

    def checkout(self, *, javascript=True, document=True, folder='documents'):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory, True)
        if javascript:
            (directory / 'demo.js').write_text(SOURCE, encoding='utf-8')
        if document:
            (directory / folder).mkdir()
            (directory / folder / 'demo.tutorial.json').write_text(
                json.dumps(DOCUMENT, indent=2), encoding='utf-8'
            )
        original = tutorial_authoring.tutorials_dir
        tutorial_authoring.tutorials_dir = lambda: directory
        self.addCleanup(setattr, tutorial_authoring, 'tutorials_dir', original)
        return directory

    def document_of(self, directory, folder='documents'):
        return json.loads((directory / folder / 'demo.tutorial.json').read_text(encoding='utf-8'))

    def step_of(self, directory, step_id, folder='documents'):
        return next(s for s in self.document_of(directory, folder)['steps'] if s['id'] == step_id)

    def test_a_word_edit_reaches_the_document_as_well_as_the_definition(self):
        directory = self.checkout()
        result = tutorial_authoring.save_step_field('demo-tutorial', 'first', 'title', 'Edited')
        self.assertTrue(result['saved'])
        self.assertIn("title: 'Edited',", (directory / 'demo.js').read_text(encoding='utf-8'))
        self.assertEqual(self.step_of(directory, 'first')['title'], 'Edited')
        self.assertEqual(len(result['documents']), 1)

    def test_a_promoted_document_is_editable_without_a_definition_file(self):
        directory = self.checkout(javascript=False, folder='generated')
        result = tutorial_authoring.save_step_field('demo-tutorial', 'second', 'body', 'Rewritten.')
        self.assertTrue(result['saved'])
        self.assertEqual(self.step_of(directory, 'second', 'generated')['body'], 'Rewritten.')
        self.assertEqual(result['followed'], '')
        self.assertFalse(result['interpolation_dropped'])

    def test_an_interpolated_body_is_written_out_to_both(self):
        directory = self.checkout()
        result = tutorial_authoring.save_step_field('demo-tutorial', 'second', 'body', 'Plain words now.')
        self.assertTrue(result['interpolation_dropped'])
        self.assertEqual(self.step_of(directory, 'second')['body'], 'Plain words now.')

    def test_a_dragged_position_lands_in_both_at_the_same_precision(self):
        directory = self.checkout()
        tutorial_authoring.save_step_position('demo-tutorial', 'first', 0.021739130434, 0.3)
        self.assertIn(
            'cardPosition: { x: 0.0217, y: 0.3 },',
            (directory / 'demo.js').read_text(encoding='utf-8'),
        )
        self.assertEqual(self.step_of(directory, 'first')['cardPosition'], {'x': 0.0217, 'y': 0.3})

    def test_a_resized_edge_lands_in_both_and_keeps_the_edge_it_was_not_given(self):
        directory = self.checkout()
        tutorial_authoring.save_step_size('demo-tutorial', 'first', width=440)
        self.assertEqual(self.step_of(directory, 'first')['cardSize'], {'width': 440})
        tutorial_authoring.save_step_size('demo-tutorial', 'first', height=280)
        self.assertEqual(self.step_of(directory, 'first')['cardSize'], {'width': 440, 'height': 280})

    def test_a_document_only_tutorial_keeps_the_edge_it_was_not_given(self):
        directory = self.checkout(javascript=False)
        tutorial_authoring.save_step_size('demo-tutorial', 'first', width=440)
        tutorial_authoring.save_step_size('demo-tutorial', 'first', height=280)
        self.assertEqual(self.step_of(directory, 'first')['cardSize'], {'width': 440, 'height': 280})

    def test_a_tutorial_with_neither_is_refused(self):
        self.checkout(javascript=False, document=False)
        with self.assertRaises(ValueError):
            tutorial_authoring.save_step_field('demo-tutorial', 'first', 'title', 'Edited')

    def test_a_document_naming_another_tutorial_is_left_alone(self):
        directory = self.checkout()
        other = dict(DOCUMENT, id='other-tutorial')
        (directory / 'documents' / 'other.tutorial.json').write_text(
            json.dumps(other, indent=2), encoding='utf-8'
        )
        tutorial_authoring.save_step_field('demo-tutorial', 'first', 'title', 'Edited')
        untouched = json.loads((directory / 'documents' / 'other.tutorial.json').read_text(encoding='utf-8'))
        self.assertEqual(untouched['steps'][0]['title'], 'The first step')

    def test_writing_leaves_no_temporary_behind(self):
        directory = self.checkout()
        tutorial_authoring.save_step_field('demo-tutorial', 'first', 'title', 'Edited')
        self.assertEqual(
            sorted(p.name for p in (directory / 'documents').iterdir()),
            ['demo.tutorial.json'],
        )


if __name__ == '__main__':
    unittest.main()

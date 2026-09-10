"""Regression for GFF3 projection through the same mapper as the MAFFT view."""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import main


class LayerAnnotationProjectionTests(unittest.TestCase):
    def test_annotation_positions_follow_alignment_strand_not_transcript_strand(self):
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/'features.sqlite')
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE transcripts(id TEXT,chrom TEXT,start INTEGER,end INTEGER)')
                db.execute("INSERT INTO transcripts VALUES ('tx','chr1',101,104)")
            for tx_strand in ('+','-'):
                for row_strand in ('+','-'):
                    with self.subTest(transcript=tx_strand,row=row_strand):
                        tx=main.SimpleTranscript('tx','chr1',101,104,tx_strand,[main.SimpleFeature('exon',101,102,tx_strand)],[],[])
                        with patch.object(main,'_get_browse_db',return_value=path),patch.object(main,'_resolve_db_chrom_name_for_genome',return_value='chr1'),patch.object(main,'find_transcript_in_index',return_value=tx):
                            features=main.alignment_explorer_annotation_features('genome','1',101,104,'AC-GT',row_strand,'tx')
                        exon=next(f for f in features if f['type']=='exon')
                        self.assertEqual((exon['start'],exon['end']),(0,1) if row_strand=='+' else (3,4))
                        self.assertEqual(exon['transcript_id'],'tx')


if __name__=='__main__':unittest.main()

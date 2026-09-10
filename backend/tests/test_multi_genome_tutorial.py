import gzip
import hashlib
import json
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tutorial_packages
import tutorial_datasets

ROOT = Path(__file__).resolve().parents[2]
DOCUMENT = ROOT / 'frontend/src/tutorials/generated/multi-genome-browsing.tutorial.json'


def test_shipped_slices_retain_gene_hierarchies_sequence_and_coordinate_aliases():
    document = json.loads(DOCUMENT.read_text())
    records = []
    for dataset in document['datasets']:
        directory = tutorial_packages.find_bundled_recipe(dataset['recipeId'])
        recipe = json.loads((directory / 'recipe.json').read_text())
        for kind, filename in recipe['files'].items():
            assert hashlib.sha256((directory / filename).read_bytes()).hexdigest() == recipe['sha256'][kind]
        rows = [line.rstrip().split('\t') for line in gzip.open(directory / recipe['files']['gff3'], 'rt') if not line.startswith('#')]
        genes = [row for row in rows if row[2] == 'gene' and 'name=samd11;' in row[8].lower()]
        assert len(genes) == 1
        gene = genes[0]
        gene_id = next(field[3:] for field in gene[8].split(';') if field.startswith('ID='))
        transcripts = [row for row in rows if f'Parent={gene_id};' in row[8] or row[8].endswith(f'Parent={gene_id}')]
        records.append((recipe, gene, len(transcripts), (directory / recipe['files']['metadata']).read_text()))
        chrom, bounds = next(iter(recipe['browsableRange'].items()))
        assert int(gene[3]) >= bounds[0] and int(gene[4]) <= bounds[1]
        assert len({row[0] for row in rows}) == 1
        assert all(bounds[0] <= int(row[3]) <= int(row[4]) <= bounds[1] for row in rows)
    assert [entry[2] for entry in records] == [18, 3, 14, 2]
    assert [entry[1][6] for entry in records] == ['+', '+', '-', '-']
    assert list(records[0][0]['browsableRange'].values()) == list(records[1][0]['browsableRange'].values())
    assert all('NC_000001.11' in entry[3] and 'chr1' in entry[3] for entry in records[:2])


def test_clone_installs_and_exports_bundled_assets_without_author_directory(tmp_path):
    document = json.loads(DOCUMENT.read_text())
    document['id'] = 'multi-genome-copy'
    tutorial_packages.save_draft(tmp_path, document)
    workspace = tmp_path / '.ensembl_go_tutorial'
    for dataset in document['datasets']:
        result = tutorial_datasets.install_recipe(tmp_path, document['id'], dataset['recipeId'], workspace)
        assert result['installed']
    package = tmp_path / 'copy.egtutorial'
    tutorial_packages.export_package(tmp_path, document['id'], package)
    assert package.is_file()
    assert package.stat().st_size > 100000


def test_builder_preserves_ncbi_json_chromosome_aliases(tmp_path):
    fasta = tmp_path / 'source.fa'
    fasta.write_text('>NC_000001.11\n' + 'ACGT' * 100 + '\n')
    import pysam
    pysam.faidx(str(fasta))
    gff = tmp_path / 'source.gff3'
    gff.write_text('##gff-version 3\nNC_000001.11\tRefSeq\tgene\t101\t200\t.\t+\t.\tID=gene-test;Name=TEST\n')
    metadata = tmp_path / 'sequence_report.json'
    metadata.write_text(json.dumps({'reports': [{'sequence_name':'1','chr_name':'1','refseq_accession':'NC_000001.11','genbank_accession':'CM000663.2','ucsc_style_name':'chr1','length':400}]}))
    result = tutorial_datasets.generate_recipe(tmp_path, 'json-aliases', fasta, gff, 'NC_000001.11', 90, 210, source={'metadata_path':str(metadata)})
    text = (Path(result['directory']) / 'assembly_report.txt').read_text()
    assert '\tNC_000001.11\t' in text and '\tchr1\n' in text
    assert 'metadata_path' not in result['recipe']['source']

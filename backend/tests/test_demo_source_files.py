"""The raw demo files the custom-genome tutorial asks the reader to import by hand.

These are laid out as a plain folder rather than installed, because the thing the tutorial
teaches is what someone does with a folder of files they already have. What is pinned here
is the part that is easy to break from a distance: the files exist, they land inside the
tutorial workspace, and nothing outside one can be written to.
"""

import tempfile
from pathlib import Path

import pytest

from demo_genome import (
    DEMO_SOURCE_BUNDLE,
    DEMO_SOURCE_SUBDIR,
    install_demo_source_files,
    tutorial_workspace,
)


@pytest.fixture
def workspace():
    root = tempfile.mkdtemp()
    path = tutorial_workspace(root)
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_the_demo_files_land_in_the_workspace(workspace):
    result = install_demo_source_files(str(workspace))

    assert Path(result["directory"]) == workspace / DEMO_SOURCE_SUBDIR
    assert set(result["files"]) == {key for key, _source, _target in DEMO_SOURCE_BUNDLE}
    for path in result["files"].values():
        assert Path(path).is_file(), path
        assert Path(path).stat().st_size > 0


def test_the_annotation_is_the_gtf_the_analysis_has_something_to_say_about(workspace):
    """A canonical GFF3 gives the Analyse report nothing to report.

    The tutorial's whole middle section is reading that report, so the file it imports is
    the GTF: a dialect to detect, a gene level to rebuild from `gene_id`, and biotypes to
    infer from the coding sequence. If this ever reverts to `demo.gff3`, six cards stop
    describing what is on screen.
    """
    result = install_demo_source_files(str(workspace))
    annotation = Path(result["files"]["annotation"])

    assert annotation.name.endswith(".gtf")
    rows = [line for line in annotation.read_text().splitlines() if line and not line.startswith("#")]
    features = {line.split("\t")[2] for line in rows}
    assert features == {"transcript", "exon", "CDS"}
    assert "gene" not in features, "a gene row would remove the reconstruction the tutorial teaches"
    assert all('gene_id "' in line for line in rows)


def test_the_genome_and_the_annotation_describe_the_same_sequences(workspace):
    """A sequence-name mismatch is the most common reason a custom genome renders nothing,
    and the tutorial says so while pointing at a report that shows none. That claim has to
    stay true."""
    result = install_demo_source_files(str(workspace))
    fasta_names = {
        line[1:].split()[0]
        for line in Path(result["files"]["fasta"]).read_text().splitlines()
        if line.startswith(">")
    }
    annotation_names = {
        line.split("\t")[0]
        for line in Path(result["files"]["annotation"]).read_text().splitlines()
        if line and not line.startswith("#")
    }
    assert annotation_names <= fasta_names
    assert fasta_names == {"welcome1", "welcome2"}


def test_nothing_outside_a_tutorial_workspace_can_be_written_to(workspace):
    root = workspace.parent
    for bad in (str(root), str(root / "elsewhere"), ""):
        with pytest.raises(ValueError):
            install_demo_source_files(bad)


def test_installing_twice_is_the_same_as_installing_once(workspace):
    """Every run starts from the same state, and a reader may restart mid-tutorial."""
    first = install_demo_source_files(str(workspace))
    second = install_demo_source_files(str(workspace))
    assert first == second
    assert sorted(p.name for p in (workspace / DEMO_SOURCE_SUBDIR).iterdir()) == sorted(
        target for _key, _source, target in DEMO_SOURCE_BUNDLE
    )

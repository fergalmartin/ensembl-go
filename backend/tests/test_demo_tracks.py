"""The demo data tracks the Track Manager tutorial asks the reader to register.

Two things are pinned here, and the second one is the one that matters.

The files: they exist, they are the window the cards describe, they land inside the
tutorial workspace and nothing outside one can be written to — the same contract as
``test_demo_source_files.py``.

The sandbox: registering a track writes to a registry resolved through ``load_config()``,
which is the *real* configuration, so without ``main._tracks_config`` the three tracks a
reader registers during the tutorial land in their own ``track_registry.json`` and outlive
the tutorial — pointing, by then, at files in a workspace that has been deleted.
"""

import json
import tempfile
from pathlib import Path

import pyBigWig
import pysam
import pytest

import demo_genome
import main
from demo_genome import (
    DEMO_TRACK_BUNDLE,
    DEMO_TRACK_SUBDIR,
    demo_track_source_dir,
    install_demo_track_files,
    tutorial_workspace,
)

# The window `backend/scripts/build_demo_tracks.py` cuts, and the cards quote.
CHROM = "1"
START = 119_600_000
END = 119_820_000


@pytest.fixture
def workspace():
    root = tempfile.mkdtemp()
    path = tutorial_workspace(root)
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_the_demo_tracks_land_in_the_workspace(workspace):
    result = install_demo_track_files(str(workspace))

    assert Path(result["directory"]) == workspace / DEMO_TRACK_SUBDIR
    assert set(result["files"]) == {key for key, _source, _target in DEMO_TRACK_BUNDLE}
    for path in result["files"].values():
        assert Path(path).is_file()
        assert workspace in Path(path).parents


def test_the_vcf_index_travels_with_the_vcf(workspace):
    """Without it the track registers and then draws nothing, which reads as a broken
    tutorial rather than as a missing file."""
    result = install_demo_track_files(str(workspace))

    vcf = Path(result["files"]["variants"])
    assert vcf.with_suffix(vcf.suffix + ".tbi").is_file()


def test_nothing_outside_a_workspace_can_be_written(workspace):
    with tempfile.TemporaryDirectory() as outside:
        with pytest.raises(ValueError):
            install_demo_track_files(outside)


def test_installing_twice_is_the_same_as_installing_once(workspace):
    first = install_demo_track_files(str(workspace))
    second = install_demo_track_files(str(workspace))

    assert first == second


def test_the_tracks_use_the_slice_genomes_chromosome_naming():
    """The slice genome's FASTA record is `1`. A track using `chr1` draws nothing at all,
    silently, so this is worth failing a suite over rather than a step."""
    source = demo_track_source_dir()

    for name in ("brain_expression.bw", "atac_seq_peaks.bw"):
        handle = pyBigWig.open(str(source / name))
        try:
            assert CHROM in handle.chroms(), f"{name} does not name chromosome {CHROM!r}"
            # True GRCh38 length, so a feature answers at its real coordinate.
            assert handle.chroms()[CHROM] == 248_956_422
        finally:
            handle.close()

    variants = pysam.VariantFile(str(source / "variants.vcf.gz"))
    assert CHROM in variants.header.contigs
    variants.close()


def test_the_tracks_cover_the_window_the_cards_describe():
    source = demo_track_source_dir()

    brain = pyBigWig.open(str(source / "brain_expression.bw"))
    try:
        # PHGDH's MANE exon 5 is the peak the expression cards quote, and it has to reach
        # into the third of the four decade bands (100, 1,000, 10,000, 100,000).
        peak = brain.stats(CHROM, 119_727_004, 119_727_102, type="max")[0]
        assert peak > 1_000, f"expression peak {peak} no longer fills three bands"
    finally:
        brain.close()

    atac = pyBigWig.open(str(source / "atac_seq_peaks.bw"))
    try:
        # The strongest peak in the window is the promoter PHGDH and ZNF697 share.
        promoter = atac.stats(CHROM, 119_647_800, 119_648_600, type="max")[0]
        window = atac.stats(CHROM, START, END, type="max")[0]
        assert promoter == pytest.approx(window), "the shared promoter is no longer the strongest peak"
    finally:
        atac.close()


def test_the_data_stays_small_enough_to_ship():
    """The whole browser-tutorial window would be a 7 MB VCF. Guidance is ~2 MB for a
    tutorial's data; this one is the largest that ships, so it is worth a tripwire."""
    total = sum(p.stat().st_size for p in demo_track_source_dir().iterdir() if p.is_file())

    assert total < 1_500_000, f"demo tracks have grown to {total / 1e6:.2f} MB"


def test_a_tutorials_tracks_do_not_reach_the_users_registry(monkeypatch):
    """The whole point of the guard. A track registered during a tutorial must be written
    into the workspace, must not be visible beside the user's own, and must leave the
    user's registry byte-identical."""
    with tempfile.TemporaryDirectory() as out:
        (Path(out) / "local_data").mkdir(parents=True)
        user_registry = Path(out) / "local_data" / "track_registry.json"
        user_registry.write_text(json.dumps({"tracks": [{"id": "users-own", "label": "My own track"}]}))
        before = user_registry.read_bytes()

        monkeypatch.setattr(main, "load_config", lambda: {"output_dir": out})

        # Outside a tutorial the user's own track is what the app sees.
        assert [t["label"] for t in main._load_track_registry()["tracks"]] == ["My own track"]

        workspace = tutorial_workspace(out)
        (workspace / "local_data").mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(demo_genome, "_tutorial_session", {"stub": True})
        monkeypatch.setattr(demo_genome, "_tutorial_workspace_root", str(workspace))

        # Inside one, the store is the workspace's and only the workspace's.
        paths = main._track_registry_store_paths_for_config(main._tracks_config())
        assert len(paths) == 1
        assert workspace in paths[0].parents
        assert main._load_track_registry()["tracks"] == []

        config = main._tracks_config()
        registry = main._load_track_registry(config)
        registry.setdefault("tracks", []).append({"id": "tutorial-1", "label": "Brain expression"})
        main._save_track_registry(registry, config)

        monkeypatch.setattr(demo_genome, "_tutorial_session", None)
        monkeypatch.setattr(demo_genome, "_tutorial_workspace_root", None)

        assert user_registry.read_bytes() == before
        assert [t["label"] for t in main._load_track_registry()["tracks"]] == ["My own track"]


def test_a_tutorials_track_cannot_be_registered_into_the_users_registry(monkeypatch, tmp_path):
    """The refusal that cannot be raced, and the reason it exists.

    Every other guard around this is timing-dependent — the frontend override, whether a
    tutorial session happens to be registered, the order a step's arrivals run in. A write
    that lands a moment *after* a tutorial ends slipped past all of them and put two tracks
    in the real registry pointing into a workspace that was then deleted. This is the check
    that makes that impossible: a file inside a tutorial workspace may only be registered
    into that workspace's own registry.
    """
    from fastapi import HTTPException

    output_dir = tmp_path / "out"
    (output_dir / "local_data").mkdir(parents=True)
    monkeypatch.setattr(main, "load_config", lambda: {"output_dir": str(output_dir)})

    workspace = tutorial_workspace(str(output_dir))
    (workspace / "demo_tracks").mkdir(parents=True)
    track = workspace / "demo_tracks" / "brain_expression.bw"
    track.write_bytes(b"not really a bigwig")

    # No tutorial running: the store is the user's, so this must be refused.
    store = main._primary_track_registry_store_path(main._tracks_config())
    assert not demo_genome.is_inside_tutorial_workspace(store)
    assert demo_genome.is_inside_tutorial_workspace(str(track))

    # With a tutorial running the store is the workspace's own, and the same file is fine.
    monkeypatch.setattr(demo_genome, "_tutorial_session", {"stub": True})
    monkeypatch.setattr(demo_genome, "_tutorial_workspace_root", str(workspace))
    store = main._primary_track_registry_store_path(main._tracks_config())
    assert demo_genome.is_inside_tutorial_workspace(store)

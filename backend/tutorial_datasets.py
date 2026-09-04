"""Generate and install small portable genome slices for tutorial drafts."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import pysam

import tutorial_packages
from genome_identity import DEMO_PROVIDER, genome_manifest_filename, storage_path_parts


MAX_REAL_SEQUENCE_BP = 5_000_000
FASTA_LINE = 60
ID_RE = re.compile(r"(?:^|;)ID=([^;]+)")
PARENT_RE = re.compile(r"(?:^|;)Parent=([^;]+)")

TURTLES_AND_FRIENDS_FIXTURE_ID = "turtles-and-friends"
TURTLES_AND_FRIENDS = (
    {
        "character": "Leonardo",
        "speciesKey": "tutorial_green_sea_turtle_leonardo",
        "scientificName": "Chelonia mydas",
        "commonName": "Green sea turtle",
        "assemblyName": "Leonardo_v1",
    },
    {
        "character": "Michelangelo",
        "speciesKey": "tutorial_hawksbill_turtle_michelangelo",
        "scientificName": "Eretmochelys imbricata",
        "commonName": "Hawksbill turtle",
        "assemblyName": "Michelangelo_v1",
    },
    {
        "character": "Donatello",
        "speciesKey": "tutorial_leatherback_turtle_donatello",
        "scientificName": "Dermochelys coriacea",
        "commonName": "Leatherback turtle",
        "assemblyName": "Donatello_v1",
    },
    {
        "character": "Raphael",
        "speciesKey": "tutorial_loggerhead_turtle_raphael",
        "scientificName": "Caretta caretta",
        "commonName": "Loggerhead turtle",
        "assemblyName": "Raphael_v1",
    },
    {
        "character": "Splinter",
        "speciesKey": "tutorial_brown_rat_splinter",
        "scientificName": "Rattus norvegicus",
        "commonName": "Brown rat",
        "assemblyName": "Splinter_v1",
    },
    {
        "character": "April",
        "speciesKey": "tutorial_human_april",
        "scientificName": "Homo sapiens",
        "commonName": "Human",
        "assemblyName": "April_v1",
    },
    {
        "character": "Rocksteady",
        "speciesKey": "tutorial_black_rhinoceros_rocksteady",
        "scientificName": "Diceros bicornis",
        "commonName": "Black rhinoceros",
        "assemblyName": "Rocksteady_v1",
    },
    {
        "character": "Bebop",
        "speciesKey": "tutorial_common_warthog_bebop",
        "scientificName": "Phacochoerus africanus",
        "commonName": "Common warthog",
        "assemblyName": "Bebop_v1",
    },
)


def _open_text(path: Path):
    return gzip.open(path, "rt", encoding="utf-8") if path.suffix.lower() in {".gz", ".bgz"} else path.open("r", encoding="utf-8")


def _attribute(pattern: re.Pattern, value: str) -> str:
    match = pattern.search(value)
    return match.group(1) if match else ""


def _annotation_rows(annotation: Path, chrom: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with _open_text(annotation) as handle:
        for line in handle:
            if not line or line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9 or parts[0] != chrom:
                continue
            try:
                start, end = int(parts[3]), int(parts[4])
            except ValueError:
                continue
            rows.append({
                "line": line.rstrip("\n"),
                "type": parts[2].lower(),
                "start": start,
                "end": end,
                "id": _attribute(ID_RE, parts[8]),
                "parents": [value for value in _attribute(PARENT_RE, parts[8]).split(",") if value],
            })
    return rows


def _gene_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    genes = [row for row in rows if row["type"] in {"gene", "pseudogene"}]
    if genes:
        return genes
    # Some GTF-like annotations reaching this path have transcript parents but no explicit
    # gene feature. They are rejected rather than producing an apparently valid empty
    # tutorial genome.
    raise ValueError("The annotation has no gene rows on the selected region.")


def select_annotation(
    rows: List[Dict[str, Any]], start: int, end: int, partial_mode: str,
) -> Tuple[int, int, List[str], List[str]]:
    genes = _gene_rows(rows)
    selected_start, selected_end = start, end
    partial_mode = str(partial_mode or "expand").strip().lower()
    if partial_mode not in {"expand", "omit", "cancel"}:
        raise ValueError("partial_mode must be expand, omit or cancel.")

    for _ in range(12):
        overlapping = [gene for gene in genes if gene["end"] >= selected_start and gene["start"] <= selected_end]
        partial = [gene for gene in overlapping if gene["start"] < selected_start or gene["end"] > selected_end]
        if not partial:
            break
        if partial_mode == "cancel":
            names = [gene["id"] or f"{gene['start']}-{gene['end']}" for gene in partial]
            raise ValueError("The region cuts through genes: " + ", ".join(names[:8]))
        if partial_mode == "omit":
            break
        next_start = min([selected_start] + [gene["start"] for gene in partial])
        next_end = max([selected_end] + [gene["end"] for gene in partial])
        if next_end - next_start + 1 > MAX_REAL_SEQUENCE_BP:
            raise ValueError("Expanding to complete overlapping genes would exceed the 5 Mb tutorial-slice limit.")
        if (next_start, next_end) == (selected_start, selected_end):
            break
        selected_start, selected_end = next_start, next_end

    if selected_end - selected_start + 1 > MAX_REAL_SEQUENCE_BP:
        raise ValueError("Tutorial slices are limited to 5 Mb of real sequence.")
    kept_genes = {
        gene["id"] for gene in genes
        if gene["id"] and gene["start"] >= selected_start and gene["end"] <= selected_end
    }
    # Follow the full parent graph rather than assuming a fixed gene → transcript → exon
    # depth. Custom GFF3 can add polypeptides or other nested features; retaining every
    # descendant of a complete selected gene keeps those relationships intact.
    retained_ids: Set[str] = set(kept_genes)
    changed = True
    while changed:
        changed = False
        for row in rows:
            if row["id"] and row["id"] not in retained_ids and any(parent in retained_ids for parent in row["parents"]):
                retained_ids.add(row["id"])
                changed = True
    kept_lines = [
        row["line"] for row in rows
        if row["id"] in kept_genes or any(parent in retained_ids for parent in row["parents"])
    ]
    if not kept_lines:
        raise ValueError("No complete genes are available in the selected interval.")
    return selected_start, selected_end, kept_lines, sorted(kept_genes)


def _write_fasta(source: Path, chrom: str, start: int, end: int, destination: Path, label: str) -> None:
    with pysam.FastaFile(str(source)) as handle:
        sequence = handle.fetch(chrom, start - 1, end).upper()
    expected = end - start + 1
    if len(sequence) != expected:
        raise ValueError(f"Expected {expected:,} bases but read {len(sequence):,}.")
    with tempfile.TemporaryDirectory() as temporary:
        plain = Path(temporary) / "slice.fa"
        with plain.open("w", encoding="utf-8") as out:
            out.write(f">{chrom} {label}\n")
            padding = start - 1
            block = ("N" * FASTA_LINE + "\n") * 1000
            while padding >= FASTA_LINE * 1000:
                out.write(block)
                padding -= FASTA_LINE * 1000
            while padding >= FASTA_LINE:
                out.write("N" * FASTA_LINE + "\n")
                padding -= FASTA_LINE
            body = ("N" * padding) + sequence
            for index in range(0, len(body), FASTA_LINE):
                out.write(body[index:index + FASTA_LINE] + "\n")
        pysam.tabix_compress(str(plain), str(destination), force=True)
    pysam.faidx(str(destination))


def _write_gff(lines: List[str], chrom: str, end: int, destination: Path) -> None:
    payload = ("\n".join(["##gff-version 3", f"##sequence-region {chrom} 1 {end}"] + lines) + "\n").encode("utf-8")
    with destination.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw, mtime=0) as handle:
            handle.write(payload)


def _write_report(destination: Path, assembly: str, label: str, chrom: str, end: int) -> None:
    destination.write_text(
        f"# Assembly name:  {assembly}\n"
        f"# Organism name:  {label}\n"
        "# Sequence-Name\tSequence-Role\tAssigned-Molecule\tAssigned-Molecule-Location/Type\tGenBank-Accn\tRelationship\tRefSeq-Accn\tAssembly-Unit\tSequence-Length\tUCSC-style-name\n"
        f"{chrom}\tassembled-molecule\t{chrom}\tChromosome\tna\t=\t{chrom}\tPrimary Assembly\t{end}\tchr{chrom}\n",
        encoding="utf-8",
    )


def _synthetic_sequence(identity: str, length: int) -> str:
    """Return a deterministic, plainly synthetic DNA sequence."""
    bases = "ACGT"
    sequence: List[str] = []
    counter = 0
    while len(sequence) < length:
        digest = hashlib.sha256(f"{identity}:{counter}".encode("utf-8")).digest()
        sequence.extend(bases[value & 3] for value in digest)
        counter += 1
    return "".join(sequence[:length])


def _write_synthetic_fasta(destination: Path, chrom: str, sequence: str, label: str) -> None:
    with destination.open("w", encoding="utf-8") as handle:
        handle.write(f">{chrom} {label}; synthetic tutorial sequence\n")
        for index in range(0, len(sequence), FASTA_LINE):
            handle.write(sequence[index:index + FASTA_LINE] + "\n")
    pysam.faidx(str(destination))


def _synthetic_annotation(character: str, chrom: str) -> Tuple[List[str], List[str]]:
    slug = re.sub(r"[^a-z0-9]+", "_", character.lower()).strip("_")
    spans = (
        (2_000, 6_500, "+"),
        (9_500, 14_000, "-"),
        (18_000, 23_500, "+"),
        (27_500, 33_000, "-"),
    )
    names = ("SHELL", "DOJO", "PIZZA", "SEWER")
    rows: List[str] = []
    genes: List[str] = []
    for index, ((start, end, strand), symbol) in enumerate(zip(spans, names), 1):
        gene_id = f"gene:{slug}_{index}"
        transcript_id = f"transcript:{slug}_{index}_001"
        genes.append(gene_id)
        rows.append(
            f"{chrom}\ttutorial\tgene\t{start}\t{end}\t.\t{strand}\t.\t"
            f"ID={gene_id};Name={symbol}{index};biotype=protein_coding;gene_biotype=protein_coding"
        )
        rows.append(
            f"{chrom}\ttutorial\tmRNA\t{start}\t{end}\t.\t{strand}\t.\t"
            f"ID={transcript_id};Parent={gene_id};Name={symbol}{index}-201;biotype=protein_coding;transcript_biotype=protein_coding"
        )
        exon_spans = (
            (start, start + 399),
            (start + 1_700, start + 2_099),
            (end - 400, end),
        )
        for exon_index, (exon_start, exon_end) in enumerate(exon_spans, 1):
            exon_id = f"exon:{slug}_{index}_{exon_index}"
            rows.append(
                f"{chrom}\ttutorial\texon\t{exon_start}\t{exon_end}\t.\t{strand}\t.\t"
                f"ID={exon_id};Parent={transcript_id}"
            )
            rows.append(
                f"{chrom}\ttutorial\tCDS\t{exon_start}\t{exon_end}\t.\t{strand}\t0\t"
                f"ID=cds:{slug}_{index}_{exon_index};Parent={transcript_id}"
            )
    return rows, genes


def generate_fixture_pack(output_dir: Any, tutorial_id: Any, fixture_id: Any) -> Dict[str, Any]:
    """Create a small, portable multi-genome example directly inside a draft."""
    fixture = str(fixture_id or "").strip()
    if fixture != TURTLES_AND_FRIENDS_FIXTURE_ID:
        raise ValueError(f"Unknown tutorial fixture: {fixture or '(empty)'}")

    tutorial_packages.draft_directory(output_dir, tutorial_id)
    datasets: List[Dict[str, Any]] = []
    chrom = "1"
    sequence_length = 36_000
    for character in TURTLES_AND_FRIENDS:
        recipe_id = f"tmnt-{character['character'].lower()}-v1"
        root = tutorial_packages.draft_directory(output_dir, tutorial_id) / "datasets" / recipe_id
        root.mkdir(parents=True, exist_ok=True)
        fasta_name = "genome.fa"
        gff_name = "annotation.gff3.gz"
        report_name = "assembly_report.txt"
        label = f"{character['commonName']} ({character['character']})"
        sequence = _synthetic_sequence(character["speciesKey"], sequence_length)
        _write_synthetic_fasta(root / fasta_name, chrom, sequence, label)
        annotation, genes = _synthetic_annotation(character["character"], chrom)
        _write_gff(annotation, chrom, sequence_length, root / gff_name)
        _write_report(root / report_name, character["assemblyName"], character["scientificName"], chrom, sequence_length)
        files = {
            "fasta": fasta_name,
            "fasta_index": fasta_name + ".fai",
            "gff3": gff_name,
            "metadata": report_name,
        }
        hashes = {kind: hashlib.sha256((root / relative).read_bytes()).hexdigest() for kind, relative in files.items()}
        recipe = {
            "format": "ensembl-go-tutorial-dataset",
            "schemaVersion": 1,
            "id": recipe_id,
            "datasetRef": f"embedded:{recipe_id}@1",
            "fixtureId": fixture,
            "character": character["character"],
            "synthetic": True,
            "speciesKey": character["speciesKey"],
            "assembly": character["assemblyName"],
            "assemblyName": character["assemblyName"],
            "displayName": label,
            "scientificName": character["scientificName"],
            "commonName": character["commonName"],
            "provider": "demo",
            "browsableRange": {chrom: [1, sequence_length]},
            "source": {
                "type": "synthetic-fixture",
                "fixture": fixture,
                "character": character["character"],
                "containsRealSequence": False,
            },
            "genes": genes,
            "files": files,
            "sha256": hashes,
        }
        (root / "recipe.json").write_text(json.dumps(recipe, indent=2) + "\n", encoding="utf-8")
        datasets.append({
            "id": recipe["datasetRef"],
            "recipeId": recipe_id,
            "embedded": True,
            "autoActivate": True,
            "label": label,
            "fixtureId": fixture,
            "source": recipe["source"],
        })

    return {
        "generated": True,
        "fixtureId": fixture,
        "label": "Turtles & friends",
        "datasets": datasets,
        "genomeCount": len(datasets),
    }


def generate_recipe(
    output_dir: Any,
    tutorial_id: Any,
    fasta_path: Any,
    annotation_path: Any,
    chrom: Any,
    start: Any,
    end: Any,
    partial_mode: str = "expand",
    source: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    fasta = Path(str(fasta_path or "").strip()).expanduser().resolve()
    annotation = Path(str(annotation_path or "").strip()).expanduser().resolve()
    if not fasta.is_file() or not annotation.is_file():
        raise ValueError("The selected genome needs readable FASTA and annotation files.")
    region = str(chrom or "").strip()
    start_value, end_value = int(start), int(end)
    if not region or start_value < 1 or end_value < start_value:
        raise ValueError("A valid chromosome and start/end interval is required.")
    rows = _annotation_rows(annotation, region)
    selected_start, selected_end, lines, gene_ids = select_annotation(rows, start_value, end_value, partial_mode)
    with pysam.FastaFile(str(fasta)) as handle:
        selected_sequence = handle.fetch(region, selected_start - 1, selected_end).upper().encode("ascii")
    identity = json.dumps({
        "chrom": region,
        "start": selected_start,
        "end": selected_end,
        "sequenceSha256": hashlib.sha256(selected_sequence).hexdigest(),
        "annotationSha256": hashlib.sha256(("\n".join(lines) + "\n").encode("utf-8")).hexdigest(),
    }, sort_keys=True).encode("utf-8")
    digest = hashlib.sha256(identity).hexdigest()
    recipe_id = f"slice-{digest[:12]}"
    species_key = f"tutorial_{recipe_id.replace('-', '_')}"
    assembly = f"EGT_{digest[:10].upper()}.1"
    label = str((source or {}).get("display_name") or (source or {}).get("scientific_name") or "Tutorial genome slice") + " (tutorial slice)"
    root = tutorial_packages.draft_directory(output_dir, tutorial_id) / "datasets" / recipe_id
    root.mkdir(parents=True, exist_ok=True)
    fasta_name = "slice.fa.bgz"
    gff_name = "slice.gff3.gz"
    report_name = "assembly_report.txt"
    _write_fasta(fasta, region, selected_start, selected_end, root / fasta_name, label)
    _write_gff(lines, region, selected_end, root / gff_name)
    _write_report(root / report_name, assembly, label, region, selected_end)
    files = {
        "fasta": fasta_name,
        "fasta_index": fasta_name + ".fai",
        "fasta_gzi": fasta_name + ".gzi",
        "gff3": gff_name,
        "metadata": report_name,
    }
    hashes = {name: hashlib.sha256((root / relative).read_bytes()).hexdigest() for name, relative in files.items()}
    recipe = {
        "format": "ensembl-go-tutorial-dataset",
        "schemaVersion": 1,
        "id": recipe_id,
        "datasetRef": f"embedded:{recipe_id}@1",
        "speciesKey": species_key,
        "assembly": assembly,
        "assemblyName": f"{region}:{selected_start:,}-{selected_end:,} tutorial slice",
        "displayName": label,
        "scientificName": str((source or {}).get("scientific_name") or label),
        "commonName": str((source or {}).get("common_name") or "Tutorial slice"),
        "browsableRange": {region: [selected_start, selected_end]},
        "source": {**(source or {}), "chrom": region, "start": selected_start, "end": selected_end},
        "genes": gene_ids,
        "files": files,
        "sha256": hashes,
    }
    (root / "recipe.json").write_text(json.dumps(recipe, indent=2) + "\n", encoding="utf-8")
    return {"generated": True, "recipe": recipe, "directory": str(root)}


def install_recipe(output_dir: Any, tutorial_id: Any, recipe_id: Any, workspace: Any) -> Dict[str, Any]:
    recipe_name = str(recipe_id or "").strip()
    if not recipe_name or tutorial_packages._slug(recipe_name) != recipe_name:
        raise ValueError("Tutorial dataset ids must contain lowercase letters, numbers and hyphens only.")
    source = tutorial_packages.draft_directory(output_dir, tutorial_id) / "datasets" / recipe_name
    recipe_path = source / "recipe.json"
    if not recipe_path.is_file() or source.is_symlink():
        raise ValueError(f"Tutorial dataset {recipe_id} is unavailable.")
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    if recipe.get("format") != "ensembl-go-tutorial-dataset":
        raise ValueError("The tutorial dataset recipe is invalid.")
    destination = (
        Path(str(workspace)).expanduser().resolve()
        / "local_data"
        / Path(*storage_path_parts(DEMO_PROVIDER, recipe["speciesKey"], recipe["assembly"]))
    )
    destination.mkdir(parents=True, exist_ok=True)
    installed: Dict[str, str] = {}
    copied_files: Dict[str, str] = {}
    for kind, relative in recipe["files"].items():
        source_file = source / relative
        if hashlib.sha256(source_file.read_bytes()).hexdigest() != recipe["sha256"][kind]:
            raise ValueError(f"Tutorial dataset asset failed its hash check: {relative}")
        target = destination / relative
        shutil.copyfile(source_file, target)
        copied_files[kind] = str(target)
        if kind in {"fasta", "gff3", "metadata"}:
            installed[kind] = str(target)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    file_records = {
        kind: {
            "type": kind,
            "filename": Path(path).name,
            "path": path,
            "url": f"tutorial://{recipe['id']}/{Path(path).name}",
            "downloaded_at": now,
        }
        for kind, path in copied_files.items()
    }
    gff_record = file_records.pop("gff3", None)
    manifest = {
        "manifest_version": 2,
        "provider": DEMO_PROVIDER,
        "source_database": DEMO_PROVIDER,
        "species_key": recipe["speciesKey"],
        "assembly": recipe["assembly"],
        "assembly_name": recipe["assemblyName"],
        "scientific_name": recipe["scientificName"],
        "common_name": recipe["commonName"],
        "display_name": recipe["displayName"],
        "display_name_reason": "demo",
        "equivalent_accessions": [],
        "is_demo": True,
        "tutorial_dataset_id": recipe["id"],
        "browsable_range": recipe["browsableRange"],
        "updated_at": now,
        "assembly_files": file_records,
        "dataset_releases": {
            "demo/current": {
                "key": "demo/current",
                "source": DEMO_PROVIDER,
                "date": "current",
                "label": "Demo",
                "files": {"gff3": gff_record} if gff_record else {},
                "created_at": now,
            }
        } if gff_record else {},
    }
    (destination / genome_manifest_filename(recipe["assembly"])).write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    marker = {"tutorial_dataset_id": recipe["id"], "species_key": recipe["speciesKey"], "assembly": recipe["assembly"]}
    (destination / "tutorial_dataset.json").write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
    record = {
        "species_key": recipe["speciesKey"],
        "assembly": recipe["assembly"],
        "assembly_name": recipe["assemblyName"],
        "display_name": recipe["displayName"],
        "scientific_name": recipe["scientificName"],
        "common_name": recipe["commonName"],
        "provider": DEMO_PROVIDER,
        "source_database": DEMO_PROVIDER,
        "is_demo": True,
        "retired_remote": False,
        "tutorial_dataset_id": recipe["id"],
        "browsable_range": recipe["browsableRange"],
        "dataset_release_key": "demo/current" if gff_record else "",
        "dataset_release_source": DEMO_PROVIDER if gff_record else "",
        "dataset_release_date": "current" if gff_record else "",
        "dataset_release_label": "Demo" if gff_record else "",
        "dataset_release_short_label": "Demo" if gff_record else "",
        "files": installed,
    }
    return {"installed": True, "recipe": recipe, "genome": record, "directory": str(destination)}

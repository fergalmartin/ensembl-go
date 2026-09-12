#!/usr/bin/env python3
"""Generate the GTF the custom-genome tutorial asks the reader to import.

The tutorial teaches the "add your own genome and annotation" path, and the point of the
Analyse button is that it reads a file *before* you trust it. A canonical Ensembl GFF3 —
which is what `demo.gff3` beside this is — gives Analyse nothing to say: no conversion is
needed, the gene model is already complete and the identifiers are already Ensembl-style,
so half the report reads "nothing to report". That teaches the reader where the sections
are but not why anyone would look at them.

So the tutorial imports this instead: the same six genes of the same demo genome, written
the way a real gene-prediction tool writes them.

  * **GTF, not GFF3** — so the dialect is detected and a conversion is required.
  * **No gene rows** — only transcript, exon and CDS, with the gene level implied by the
    `gene_id` attribute, which is what StringTie and BRAKER actually emit. The gene level
    is then reconstructed on import.
  * **Bare identifiers** — `Welcome`, not `gene:Welcome` — the way a tool writes them,
    so the identifier section has an opinion. The names themselves are the demo genome's
    own, because they are what the reader reads off the track at the end of the tutorial.

The sequence is untouched: this is a different *spelling* of `demo.gff3`, over the same
coordinates of the same `demo.fa`, so the genome the reader ends up browsing holds the
same six genes in the same places.

Derived from `demo.gff3` rather than restating the coordinates, so the two cannot drift
apart. Deterministic: same input, same file. Re-run and commit the result.

    python3 backend/scripts/build_demo_gtf.py
"""

from __future__ import annotations

from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "demo_genome"
SOURCE = DATA_DIR / "demo.gff3"
OUT = DATA_DIR / "demo_genes.gtf"

# The source column. Deliberately not the name of a real tool and not "ensembl" either:
# the producer sniffer reads this column, and the tutorial's card says it comes back blank
# because nothing in the file names a tool the app knows. Matching `demo.gff3` keeps the
# two spellings of the same genes saying the same thing about where they came from.
SOURCE_COLUMN = "demo"


def parse_attributes(blob: str) -> dict:
    """GFF3 attributes, which are `key=value` pairs separated by semicolons."""
    attributes = {}
    for part in blob.strip().split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        key, _, value = part.partition("=")
        attributes[key.strip()] = value.strip()
    return attributes


def strip_prefix(identifier: str) -> str:
    """`gene:Welcome` → `Welcome`. Ensembl's GFF3 prefixes identifiers by feature type."""
    return identifier.split(":", 1)[1] if ":" in identifier else identifier


def read_model(path: Path):
    """Collect transcripts and their children out of the demo GFF3.

    Order is preserved as the file has it. The indexer that eventually reads the
    converted output attaches a child to a parent it has already seen, so emitting a
    transcript before its own exons is not optional.
    """
    transcripts = {}
    order = []

    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 9:
            continue
        seqid, _source, feature, start, end, score, strand, phase, blob = fields
        attributes = parse_attributes(blob)

        if feature == "mRNA":
            transcript_id = strip_prefix(attributes.get("ID", ""))
            gene_id = strip_prefix(attributes.get("Parent", ""))
            if not transcript_id or not gene_id:
                continue
            transcripts[transcript_id] = {
                "seqid": seqid,
                "start": int(start),
                "end": int(end),
                "strand": strand,
                "gene_id": gene_id,
                "exons": [],
                "cds": [],
            }
            order.append(transcript_id)
        elif feature in ("exon", "CDS"):
            transcript_id = strip_prefix(attributes.get("Parent", ""))
            record = transcripts.get(transcript_id)
            if record is None:
                continue
            bucket = "exons" if feature == "exon" else "cds"
            record[bucket].append((int(start), int(end), phase))

    return [(key, transcripts[key]) for key in order]


def attribute_blob(gene_id: str, transcript_id: str, extra: str = "") -> str:
    """GTF attributes: quoted values, semicolon-terminated, space-separated."""
    blob = f'gene_id "{gene_id}"; transcript_id "{transcript_id}";'
    return f"{blob} {extra}" if extra else blob


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"{SOURCE} is missing — run build_demo_genome.py first.")

    model = read_model(SOURCE)
    lines = []

    for transcript_id, record in model:
        # A predictor's identifiers: a bare gene id and a numbered transcript under it,
        # with none of Ensembl's `gene:` / `transcript:` prefixing. The gene keeps its own
        # name rather than gaining a tool-shaped prefix — these six spell a sentence, the
        # reader sees them in the browser at the end of the tutorial, and a prefix on each
        # one buries it.
        gene_id = record["gene_id"]
        tool_transcript_id = f"{gene_id}.t1"
        common = (record["seqid"], SOURCE_COLUMN)

        lines.append("\t".join([
            *common, "transcript", str(record["start"]), str(record["end"]),
            ".", record["strand"], ".",
            attribute_blob(gene_id, tool_transcript_id),
        ]))

        # Exons are numbered in transcript order, which on the reverse strand counts down
        # the coordinates. The demo genes are all forward, but deriving it from the strand
        # rather than from the file's order keeps this correct if that ever changes.
        exons = sorted(record["exons"], key=lambda item: item[0], reverse=record["strand"] == "-")
        for number, (start, end, _phase) in enumerate(exons, start=1):
            lines.append("\t".join([
                *common, "exon", str(start), str(end), ".", record["strand"], ".",
                attribute_blob(gene_id, tool_transcript_id, f'exon_number "{number}";'),
            ]))

        # The source phase is carried across rather than recomputed. A 5'-incomplete CDS
        # must not be silently declared complete, and the conversion on import reads this
        # column to decide the reading frame.
        for start, end, phase in sorted(record["cds"], key=lambda item: item[0]):
            lines.append("\t".join([
                *common, "CDS", str(start), str(end), ".", record["strand"],
                phase if phase in {"0", "1", "2"} else "0",
                attribute_blob(gene_id, tool_transcript_id),
            ]))

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")

    genes = {record["gene_id"] for _key, record in model}
    exon_count = sum(len(record["exons"]) for _key, record in model)
    cds_count = sum(len(record["cds"]) for _key, record in model)
    print(f"wrote {OUT}")
    print(
        f"  {len(genes)} genes, {len(model)} transcripts, {exon_count} exons, "
        f"{cds_count} CDS, {len(lines)} rows, no gene rows"
    )


if __name__ == "__main__":
    main()

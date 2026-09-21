"""The sequence view's endpoints.

Built as a router factory taking provider callables, like the alignment
explorer's, so this package never imports ``main``. Every provider is a function
``main`` already has; passing them in keeps genome resolution, index readiness
and the motif-verified feature derivation in one place rather than reimplemented
here, where the second copy would be the one that drifted.

Coordinates in and out are 1-based inclusive on both ends, forward strand. The
single place that is not true is the ``fasta.fetch`` call, which is 0-based
half-open; ``_read_window`` converts, and nothing else in the package does.
"""

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .cache import ClassCache, cache_key, source_fingerprint
from .classes import (
    base_class_in_transcript,
    cds_frame_from_segments,
    gene_overlap_spans,
    gene_union_classes,
    location_classes,
    location_gene_classes,
    project_to_spliced,
    spliced_classes,
    transcript_classes,
)
from .spans import MAX_INTRON_COLLAPSE_GENES, spans_for_level
from .windows import (
    FASTA_LINE_WIDTH,
    FASTA_STREAM_BP,
    MAX_CLIPBOARD_BP,
    MAX_TILE_BP,
    apply_strand_flanks,
    clip_to_chromosome,
    fasta_header,
    soft_mask_runs,
    wrap_sequence,
)

LEVELS = ("location", "gene", "transcript", "feature")

# What version of the `/spans` payload the cache holds. See the key it is part of.
# v2 answers with the genic and exonic spans a region is made of; v1 answered
# with one pre-computed set of stretches to keep.
SPANS_SHAPE = "v2"

# The fewest genes the drawer will offer at a location. The list follows the rows
# on screen, and a screenful of sequence is about two kilobases, so most of the
# time it holds nothing at all -- which would be a list that is empty whenever it
# matters. Below this many in view, the nearest ones either side are added, so
# there is always somewhere to go next.
NEAREST_GENES = 10

# What one window will return even if it somehow holds more. The window is the
# rows on screen, so this is a guard against a malformed request rather than a
# limit anyone should meet.
MAX_WINDOW_GENES = 200

# How many genes in one annotation tile will be read isoform by isoform.
#
# A location is drawn in the same five classes a gene is, which means reading
# every transcript of every gene in the tile -- a few hundred rows of JSON in a
# dense region, cached afterwards, but not free. Past this many the tile falls
# back to genic and intergenic and says so, which is honest: at a gene every two
# kilobases there is nothing legible to draw anyway.
MAX_LOCATION_DETAIL_GENES = 100

# How many features a reader may silence at once. Hiding is for reading a
# crowded locus one gene at a time; past this many it is a query, not a reading
# aid, and the identifiers would be longer than the answer.
MAX_HIDDEN = 200

# How many genes one base will be described by. A coordinate under more than a
# handful of genes is an annotation artefact rather than something to read, and
# the box has to fit on a screen.
MAX_BASE_GENES = 12

# How many stretches one spliced FASTA record may be made of. A transcript has
# tens of exons; a hundred is past anything a reader would ask for and well
# under what a URL will carry.
MAX_FASTA_SEGMENTS = 100

# The longest spliced sequence one transcript read will answer with.
#
# The longest spliced human transcript is TTN's, at about 109 kb, so this is
# roughly twice the worst case anything real will ask for. It is a guard against
# a malformed annotation -- a "transcript" spanning a chromosome -- rather than a
# limit a reader should ever meet, and it is stated in the spliced length rather
# than the genomic span because the spliced length is what is being sent.
MAX_SPLICED_BP = 250_000


class SequenceWindow(BaseModel):
    chrom: str
    start: int
    end: int
    length: int
    sequence: str
    masked: List[Dict[str, int]] = []


class ClassRun(BaseModel):
    s: int
    e: int
    c: str


class CdsFrameSegment(BaseModel):
    s: int
    e: int
    o: int


class FocusFeature(BaseModel):
    id: str
    name: str = ""
    s: int
    e: int
    strand: str = "+"
    biotype: str = ""
    transcript_count: int = 0


class GeneOverlap(BaseModel):
    s: int
    e: int
    n: int


class BaseTranscript(BaseModel):
    id: str
    biotype: str = ""
    canonical: bool = False
    cls: str = ""
    kind: str = ""          # exon | intron
    index: int = 0
    count: int = 0
    hidden: bool = False
    # Enough to read into it from the box, without asking again.
    s: int = 0
    e: int = 0
    strand: str = "+"
    focus: bool = False


class BaseGene(BaseModel):
    id: str
    name: str = ""
    biotype: str = ""
    strand: str = "+"
    s: int
    e: int
    cls: str = ""
    transcripts: List[BaseTranscript] = []
    transcript_count: int = 0
    hidden: bool = False
    focus: bool = False


class BaseResponse(BaseModel):
    chrom: str
    coord: int
    base: str = ""
    masked: bool = False
    annotation: str = "ready"
    # The level `cls` was computed at, echoed back so the box can say what it is
    # describing rather than assuming the view has not moved since.
    level: str = "location"
    # The class the view painted *at the level it is being read at*. At a
    # location that is every gene's answer together; at a gene, that gene's; at a
    # transcript, that transcript's own. The per-gene answers below are the rest
    # of what is known, which is not always what is on screen.
    cls: str = ""
    genes: List[BaseGene] = []
    gene_count: int = 0
    truncated: bool = False


class ClassesResponse(BaseModel):
    genome: str
    chrom: str
    start: int
    end: int
    level: str
    strand: str = "+"
    annotation: str = "ready"
    runs: List[ClassRun] = []
    cdsFrame: List[CdsFrameSegment] = []
    features: List[FocusFeature] = []
    # Location level only: where genes lie on top of one another, and how many
    # of them, drawn as a second channel over the classes rather than instead of
    # them. `detail` says which vocabulary `runs` is written in -- "genes" for
    # the five gene classes, "plain" for genic and intergenic where there were
    # too many genes to read.
    overlaps: List[GeneOverlap] = []
    detail: str = ""
    gene_count: int = 0
    # How many features the answer was computed without, so the view can say so
    # rather than leaving a reader to wonder where a gene went.
    hidden: int = 0


def create_router(
    *,
    cache_root=None,
    db_provider: Callable[..., str],
    db_optional_provider: Callable[..., str],
    fasta_provider: Callable[..., Any],
    chrom_resolver: Callable[..., str],
    tx_feature_intervals: Callable[..., List[Dict[str, Any]]],
    mode_segments: Callable[..., Any],
    translate_transcript: Callable[..., Dict[str, Any]],
    normalize_intervals: Callable[..., List[Dict[str, Any]]],
    ordered_five_to_three: Callable[..., List[Dict[str, Any]]],
) -> APIRouter:
    root = Path(
        cache_root
        or os.environ.get("ENSEMBL_SEQUENCE_VIEW_CACHE")
        or (Path.home() / ".cache" / "ensembl-go" / "sequence-view")
    )
    router = APIRouter(prefix="/api/sequence-view", tags=["Sequence View"])
    classes_cache = ClassCache(root / "classes")

    # ---- shared helpers -------------------------------------------------

    def _resolve_chrom(fasta, genome: str, requested: str):
        """The chromosome as this FASTA names it, and how long it is.

        Assemblies disagree about whether it is "1", "chr1" or "NC_000001.11",
        and a reader arriving from another view carries whichever name that view
        used, so the name is resolved rather than trusted.
        """
        token = str(requested or "").strip()
        if not token:
            raise HTTPException(status_code=400, detail="A chromosome is required")
        references = [str(r or "").strip() for r in list(fasta.references or []) if str(r or "").strip()]
        if token in references:
            return token, int(fasta.get_reference_length(token))
        fallback = chrom_resolver(genome, token, references)
        if fallback and fallback in references:
            return fallback, int(fasta.get_reference_length(fallback))
        raise HTTPException(status_code=404, detail=f"Region not found: {token}")

    def _read_window(fasta, chrom: str, start: int, end: int, softmask: bool) -> Dict[str, Any]:
        """One stretch of sequence, 1-based inclusive in and out.

        The only 0-based half-open coordinates in this package are the two
        arguments to fetch on the next line.
        """
        raw = str(fasta.fetch(chrom, start - 1, end) or "")
        masked = soft_mask_runs(raw, start) if softmask else []
        sequence = raw.upper()
        return {
            "chrom": chrom,
            "start": start,
            "end": start + len(sequence) - 1 if sequence else start,
            "length": len(sequence),
            "sequence": sequence,
            "masked": masked,
        }

    def _connect(db_path: str) -> sqlite3.Connection:
        connection = sqlite3.connect(db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _transcript_row_intervals(row: sqlite3.Row) -> Dict[str, Any]:
        """A transcript row's exons, CDS and UTRs, out of its JSON blob."""
        strand = str(row["strand"] or "+")
        try:
            data = json.loads(row["data"] or "{}")
        except ValueError:
            data = {}
        return {
            "id": str(row["id"]),
            "strand": strand,
            "start": int(row["start"]),
            "end": int(row["end"]),
            "exons": normalize_intervals(data.get("exons", []), "exon", strand),
            "cds_list": normalize_intervals(data.get("cds_list", []), "cds", strand),
            "utrs": normalize_intervals(data.get("utrs", []), "utr", strand),
            "biotype": str(data.get("biotype", "") or ""),
            "tags": list(data.get("tags", []) or []),
            "is_canonical": bool(row["is_canonical"]),
        }

    def _gene_row(connection: sqlite3.Connection, gene_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT id, name, chrom, start, end, strand, biotype FROM genes WHERE id = ?",
            (gene_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Gene not found: {gene_id}")
        return row

    def _transcripts_of(connection: sqlite3.Connection, gene_id: str) -> List[Dict[str, Any]]:
        rows = connection.execute(
            "SELECT id, chrom, start, end, strand, data, is_canonical "
            "FROM transcripts WHERE parent_gene_id = ? ORDER BY is_canonical DESC, start ASC",
            (gene_id,),
        ).fetchall()
        return [_transcript_row_intervals(row) for row in rows]

    def _transcript_by_id(connection: sqlite3.Connection, transcript_id: str) -> Dict[str, Any]:
        row = connection.execute(
            "SELECT id, chrom, start, end, strand, data, is_canonical, parent_gene_id "
            "FROM transcripts WHERE id = ?",
            (transcript_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Transcript not found: {transcript_id}")
        transcript = _transcript_row_intervals(row)
        transcript["gene_id"] = str(row["parent_gene_id"] or "")
        transcript["chrom"] = str(row["chrom"] or "")
        return transcript

    # ---- sequence -------------------------------------------------------

    @router.get("/sequence", response_model=SequenceWindow)
    async def sequence(
        genome: str = "reference",
        chrom: str = "",
        start: int = Query(ge=1),
        end: int = Query(ge=1),
        softmask: bool = False,
    ):
        if end < start:
            raise HTTPException(status_code=400, detail="The end must not come before the start")
        if end - start + 1 > MAX_TILE_BP:
            raise HTTPException(status_code=400, detail=f"At most {MAX_TILE_BP} bases in one read")

        def _query():
            fasta = fasta_provider(genome)
            resolved, length = _resolve_chrom(fasta, genome, chrom)
            window = clip_to_chromosome(start, end, length)
            if not window:
                raise HTTPException(status_code=404, detail=f"Region not found: {chrom}:{start}-{end}")
            return _read_window(fasta, resolved, window[0], window[1], softmask)

        return await run_in_threadpool(_query)

    # ---- classes --------------------------------------------------------

    @router.get("/classes", response_model=ClassesResponse)
    async def classes(
        genome: str = "reference",
        chrom: str = "",
        start: int = Query(default=0, ge=0),
        end: int = Query(default=0, ge=0),
        level: str = "location",
        gene_id: str = "",
        transcript_id: str = "",
        flank: int = Query(default=0, ge=0),
        flank5: Optional[int] = Query(default=None, ge=0),
        flank3: Optional[int] = Query(default=None, ge=0),
        hide: str = "",
    ):
        if level not in LEVELS:
            raise HTTPException(status_code=400, detail=f"Unknown focus level: {level}")
        # The two ends of the flank, each falling back to the one symmetric
        # number that used to be the whole of it. A client that sends neither
        # gets exactly what it got before, which is what keeps `flank`
        # meaningful on its own -- and what lets a caller ask for an asymmetric
        # window without knowing which end is which.
        five = flank if flank5 is None else flank5
        three = flank if flank3 is None else flank3
        # What the reader has silenced. It changes the answer rather than the
        # drawing -- a hidden gene casts no vote, so its neighbour stops being
        # "mixed" where the two overlapped -- which is the point of hiding it.
        hidden = _parse_hidden(hide)

        def _query():
            fasta = fasta_provider(genome)
            resolved, chrom_length = _resolve_chrom(fasta, genome, chrom)

            # A genome carrying only a FASTA has no genes to describe. That is a
            # state to report, not an error: the sequence still reads, and the
            # view says so rather than looking broken.
            db_path = db_optional_provider(genome) if level == "location" else db_provider(genome)
            if level == "location" and not db_path:
                window = clip_to_chromosome(start, end, chrom_length)
                if not window:
                    raise HTTPException(status_code=404, detail="Region not found")
                return {
                    "genome": genome, "chrom": resolved,
                    "start": window[0], "end": window[1],
                    "level": level, "annotation": "absent",
                    "runs": [], "features": [], "cdsFrame": [],
                }

            key = cache_key(
                "classes", genome, resolved, start, end, level, gene_id, transcript_id, five, three,
                # Sorted, so that the same set hidden in a different order is the
                # same cached answer.
                ",".join(sorted(hidden)),
                source_fingerprint(db_path),
            )
            cached = classes_cache.get(key)
            if cached is not None:
                return cached

            connection = _connect(db_path)
            try:
                payload = _build_classes(
                    connection, genome, resolved, chrom_length,
                    start, end, level, gene_id, transcript_id, five, three, fasta, hidden,
                )
            finally:
                connection.close()

            classes_cache.put(key, payload)
            return payload

        return await run_in_threadpool(_query)

    def _build_classes(
        connection, genome, chrom, chrom_length,
        start, end, level, gene_id, transcript_id, five, three, fasta, hidden=frozenset(),
    ) -> Dict[str, Any]:
        if level == "location":
            window = clip_to_chromosome(start, end, chrom_length)
            if not window:
                raise HTTPException(status_code=404, detail="Region not found")
            low, high = window
            rows = connection.execute(
                "SELECT id, name, start, end, strand, biotype FROM genes "
                "WHERE chrom = ? AND end >= ? AND start <= ? ORDER BY start ASC",
                (chrom, low, high),
            ).fetchall()
            genes = [
                {"start": int(row["start"]), "end": int(row["end"]), "id": str(row["id"])}
                for row in rows
                if str(row["id"]) not in hidden
            ]
            # Read isoform by isoform where there are few enough genes to make
            # that worth doing, so that a location is drawn in the same classes a
            # gene is. Over the cap, the plain genic/intergenic answer, with
            # `detail` saying which one this is -- the view tells the reader
            # rather than quietly changing what the colours mean.
            detailed = len(genes) <= MAX_LOCATION_DETAIL_GENES
            if detailed:
                for gene in genes:
                    # An isoform can be silenced on its own as well as a whole
                    # gene, and a gene all of whose isoforms are hidden still
                    # holds its own span -- which reads as intronic, the same as
                    # a gene the annotation gives no transcripts for at all.
                    gene["transcripts"] = _visible(
                        _transcripts_of(connection, gene["id"]), hidden,
                    )
            # No gene list here. Which genes the drawer offers depends on where
            # the reader is looking, which this endpoint is tiled against and so
            # does not know; /focus/genes answers that. These runs cover every
            # gene in the tile whatever their number.
            return {
                "genome": genome, "chrom": chrom, "start": low, "end": high,
                "level": level, "strand": "+", "annotation": "ready",
                "runs": (location_gene_classes(genes, low, high) if detailed
                         else location_classes(genes, low, high)),
                "cdsFrame": [], "features": [],
                "overlaps": gene_overlap_spans(genes, low, high),
                "detail": "genes" if detailed else "plain",
                "gene_count": len(genes),
                "hidden": len(hidden),
            }

        if level == "gene":
            if not gene_id:
                raise HTTPException(status_code=400, detail="A gene focus needs a gene_id")
            gene = _gene_row(connection, gene_id)
            gene_start, gene_end = int(gene["start"]), int(gene["end"])
            window = apply_strand_flanks(
                gene_start, gene_end, five, three, str(gene["strand"] or "+"), chrom_length,
            )
            if not window:
                raise HTTPException(status_code=404, detail="Region not found")
            every = _transcripts_of(connection, gene_id)
            transcripts = _visible(every, hidden)
            return {
                "genome": genome, "chrom": chrom, "start": window[0], "end": window[1],
                "level": level, "strand": str(gene["strand"] or "+"), "annotation": "ready",
                "hidden": len(every) - len(transcripts),
                "runs": gene_union_classes(transcripts, window[0], window[1], gene_start, gene_end),
                "cdsFrame": [],
                "features": [{
                    "id": str(gene["id"]), "name": str(gene["name"] or ""),
                    "s": gene_start, "e": gene_end,
                    "strand": str(gene["strand"] or "+"), "biotype": str(gene["biotype"] or ""),
                    "transcript_count": len(every),
                }],
            }

        # transcript and feature differ only in the window they cover, so they
        # share one derivation rather than two that could drift apart.
        if not transcript_id:
            raise HTTPException(status_code=400, detail=f"A {level} focus needs a transcript_id")
        transcript = _transcript_by_id(connection, transcript_id)
        strand = transcript["strand"]

        if level == "feature":
            if end < start or start < 1:
                raise HTTPException(status_code=400, detail="A feature focus needs its own start and end")
            # An exon or an intron is read in its transcript's direction, so its
            # 5' end is the transcript's 5' end and not the lower coordinate.
            window = apply_strand_flanks(start, end, five, three, strand, chrom_length)
        else:
            window = apply_strand_flanks(
                transcript["start"], transcript["end"], five, three, strand, chrom_length,
            )
        if not window:
            raise HTTPException(status_code=404, detail="Region not found")

        intervals = tx_feature_intervals(
            fasta, chrom, strand,
            transcript["exons"], transcript["cds_list"], transcript["utrs"],
        )
        _, _, segments, status = mode_segments(
            transcript["start"], transcript["end"], strand,
            transcript["exons"], transcript["cds_list"], "cds",
        )
        # A CDS whose start codon could not be verified gets no frame at all. The
        # view then draws it flat rather than striped, which says "the frame is
        # not known" instead of asserting a frame that may be wrong.
        has_start = any(i.get("type") == "start_codon" for i in intervals)
        frame = cds_frame_from_segments(segments) if (status == "ok" and has_start) else []

        return {
            "genome": genome, "chrom": chrom, "start": window[0], "end": window[1],
            "level": level, "strand": strand, "annotation": "ready",
            "runs": transcript_classes(intervals, window[0], window[1]),
            "cdsFrame": frame,
            "features": [],
        }

    # ---- the drawer's child lists ---------------------------------------

    @router.get("/focus/genes")
    async def focus_genes(
        genome: str = "reference",
        chrom: str = "",
        start: int = Query(default=0, ge=0),
        end: int = Query(default=0, ge=0),
        window_start: int = Query(default=0, ge=0),
        window_end: int = Query(default=0, ge=0),
    ):
        """The genes worth offering where the reader is, and how many there are in all.

        A region can hold thousands of genes, and neither number nor list is much
        use on its own: a count says nothing about what is under the cursor, and
        a list of thousands is not a list. So the count is of the whole region and
        the list is of the window -- topped up with the nearest either side when
        the window is between genes, which at a screenful of sequence it usually
        is.
        """
        low, high = min(start, end), max(start, end)
        win_low = min(window_start, window_end) or low
        win_high = max(window_start, window_end) or high

        def _query():
            db_path = db_optional_provider(genome)
            if not db_path:
                return {"annotation": "absent", "total": 0, "in_window": 0, "genes": []}
            connection = _connect(db_path)
            try:
                total = connection.execute(
                    "SELECT COUNT(*) FROM genes WHERE chrom = ? AND end >= ? AND start <= ?",
                    (chrom, low, high),
                ).fetchone()[0]

                in_window = connection.execute(
                    "SELECT g.id, g.name, g.start, g.end, g.strand, g.biotype, "
                    "(SELECT COUNT(*) FROM transcripts t WHERE t.parent_gene_id = g.id) AS n "
                    "FROM genes g WHERE g.chrom = ? AND g.end >= ? AND g.start <= ? "
                    "ORDER BY g.start ASC LIMIT ?",
                    (chrom, win_low, win_high, MAX_WINDOW_GENES),
                ).fetchall()

                rows = list(in_window)
                if len(rows) < NEAREST_GENES:
                    # The nearest either side, inside the region but outside the
                    # window. Two index scans rather than a sort over everything:
                    # genes are indexed on both their start and their end.
                    seen = {str(row["id"]) for row in rows}
                    wanted = NEAREST_GENES - len(rows)
                    before = connection.execute(
                        "SELECT g.id, g.name, g.start, g.end, g.strand, g.biotype, "
                        "(SELECT COUNT(*) FROM transcripts t WHERE t.parent_gene_id = g.id) AS n "
                        "FROM genes g WHERE g.chrom = ? AND g.end < ? AND g.end >= ? "
                        "ORDER BY g.end DESC LIMIT ?",
                        (chrom, win_low, low, wanted),
                    ).fetchall()
                    after = connection.execute(
                        "SELECT g.id, g.name, g.start, g.end, g.strand, g.biotype, "
                        "(SELECT COUNT(*) FROM transcripts t WHERE t.parent_gene_id = g.id) AS n "
                        "FROM genes g WHERE g.chrom = ? AND g.start > ? AND g.start <= ? "
                        "ORDER BY g.start ASC LIMIT ?",
                        (chrom, win_high, high, wanted),
                    ).fetchall()

                    def distance(row):
                        if int(row["end"]) < win_low:
                            return win_low - int(row["end"])
                        if int(row["start"]) > win_high:
                            return int(row["start"]) - win_high
                        return 0

                    for row in sorted(list(before) + list(after), key=distance)[:wanted]:
                        if str(row["id"]) not in seen:
                            seen.add(str(row["id"]))
                            rows.append(row)
            finally:
                connection.close()

            rows.sort(key=lambda row: (int(row["start"]), int(row["end"])))
            return {
                "annotation": "ready",
                "total": int(total),
                "in_window": len(in_window),
                "genes": [
                    {
                        "id": str(row["id"]), "name": str(row["name"] or ""),
                        "s": int(row["start"]), "e": int(row["end"]),
                        "strand": str(row["strand"] or "+"),
                        "biotype": str(row["biotype"] or ""),
                        "transcript_count": int(row["n"] or 0),
                    }
                    for row in rows
                ],
            }

        return await run_in_threadpool(_query)

    @router.get("/focus/transcripts")
    async def focus_transcripts(genome: str = "reference", gene_id: str = ""):
        if not gene_id:
            raise HTTPException(status_code=400, detail="A gene_id is required")

        def _query():
            connection = _connect(db_provider(genome))
            try:
                transcripts = _transcripts_of(connection, gene_id)
            finally:
                connection.close()
            return {
                "gene_id": gene_id,
                "transcripts": [
                    {
                        "id": transcript["id"],
                        "s": transcript["start"], "e": transcript["end"],
                        "strand": transcript["strand"],
                        "biotype": transcript["biotype"],
                        "tags": transcript["tags"],
                        "is_canonical": transcript["is_canonical"],
                        "exon_count": len(transcript["exons"]),
                        "has_cds": bool(transcript["cds_list"]),
                    }
                    for transcript in transcripts
                ],
            }

        return await run_in_threadpool(_query)

    @router.get("/focus/features")
    async def focus_features(genome: str = "reference", transcript_id: str = ""):
        """A transcript's exons and introns, numbered as a reader counts them.

        Numbered 5' to 3', so exon 1 is the first one transcribed rather than the
        leftmost on the screen -- which on the minus strand is the last.
        """
        if not transcript_id:
            raise HTTPException(status_code=400, detail="A transcript_id is required")

        def _query():
            connection = _connect(db_provider(genome))
            try:
                transcript = _transcript_by_id(connection, transcript_id)
            finally:
                connection.close()

            strand = transcript["strand"]
            exons = ordered_five_to_three(transcript["exons"], strand)
            features = [
                {"kind": "exon", "index": number, "s": int(exon["start"]), "e": int(exon["end"])}
                for number, exon in enumerate(exons, start=1)
            ]
            for number in range(len(exons) - 1):
                here, following = exons[number], exons[number + 1]
                # 5' to 3', so on the minus strand the next exon is the one to
                # the left and the intron lies between its end and this one's
                # start.
                if strand == "-":
                    low, high = int(following["end"]) + 1, int(here["start"]) - 1
                else:
                    low, high = int(here["end"]) + 1, int(following["start"]) - 1
                if high >= low:
                    features.append({"kind": "intron", "index": number + 1, "s": low, "e": high})
            return {
                "transcript_id": transcript_id,
                "chrom": transcript["chrom"],
                "strand": strand,
                "features": features,
            }

        return await run_in_threadpool(_query)

    # ---- a transcript's own sequence -------------------------------------

    def _exon_number_at(exons_five_to_three, g_low: int, g_high: int) -> int:
        """Which exon a stretch of genomic sequence belongs to, as a reader counts.

        Numbered 5' to 3' by the same ordering ``/focus/features`` and the base
        box use, so a CDS segment reported as exon 4 here is the exon 4 the
        drawer lists. Nought where it belongs to none, which a CDS segment never
        should -- but a malformed annotation is not worth a 500.
        """
        for number, exon in enumerate(exons_five_to_three, start=1):
            if int(exon["start"]) <= g_low and g_high <= int(exon["end"]):
                return number
        return 0

    @router.get("/transcript-sequence")
    async def transcript_sequence(
        genome: str = "reference",
        transcript_id: str = "",
        kind: str = "transcript",
    ):
        """One transcript's spliced sequence, with the annotation in its own space.

        ``kind`` is ``transcript`` -- the exons joined -- ``cds``, the coding
        segments joined, or ``protein``, what those spell. All three are written
        5' to 3', which on the minus strand means reverse complemented; the
        reader is looking at the transcript, not at the chromosome under it.

        The runs come back in **spliced** coordinates, 1-based inclusive, which
        is the one place in this package coordinates are not genomic. They are
        the same runs ``/classes`` answers with, projected through the segment
        map before they are painted rather than after -- see ``spliced_classes``
        for why that order matters. A protein's positions are residues, and its
        segments map each residue back to the three bases that spell it.

        **The protein is translated here, not in the browser.** The obvious thing
        is to hand the client the CDS and let it translate what it already has --
        and the sequence view does exactly that for the lane it draws over the
        codons. It is the wrong answer for a protein a reader will copy. This
        application has one translation, in ``backend/translation.py``, and it is
        the only one that knows a mitochondrial contig uses a different genetic
        code, that Ensembl renders a non-ATG initiation codon as M, that a
        terminal stop is stripped and an internal one is kept, and that a CDS
        beginning mid-codon starts with an X. A browser-side codon table gets
        every one of those wrong, quietly, and would disagree with the protein
        the Feature Explorer shows for the same transcript.
        """
        wanted = str(kind or "transcript").strip().lower()
        if wanted not in ("transcript", "cds", "protein"):
            raise HTTPException(
                status_code=400, detail="kind must be 'transcript', 'cds' or 'protein'",
            )
        if not transcript_id:
            raise HTTPException(status_code=400, detail="A transcript_id is required")

        def _query():
            connection = _connect(db_provider(genome))
            try:
                transcript = _transcript_by_id(connection, transcript_id)
            finally:
                connection.close()

            chrom = str(transcript["chrom"] or "")
            strand = str(transcript["strand"] or "+")
            fasta = fasta_provider(genome)
            resolved, _chrom_length = _resolve_chrom(fasta, genome, chrom)

            empty = {
                "transcript_id": transcript_id,
                "chrom": chrom,
                "strand": strand,
                "kind": wanted,
                "length": 0,
                "sequence": "",
                "runs": [],
                "segments": [],
                "cds": None,
                "phase": 0,
                "pad": 0,
                "startVerified": False,
                "internalStops": 0,
                "genomic": {"s": int(transcript["start"]), "e": int(transcript["end"])},
            }

            exons_ordered = ordered_five_to_three(transcript["exons"], strand)

            def _named(pieces):
                """Segments as the client reads them, each naming its exon.

                ``s``/``e`` are in whatever space the answer is in -- spliced
                bases for a transcript or a CDS, codon-aligned CDS bases for a
                protein -- and ``gs``/``ge`` are always genomic.
                """
                out = []
                for piece in pieces:
                    g_low = min(int(piece["genomic_start"]), int(piece["genomic_end"]))
                    g_high = max(int(piece["genomic_start"]), int(piece["genomic_end"]))
                    out.append({
                        "s": int(piece["coord_start"]),
                        "e": int(piece["coord_end"]),
                        "gs": g_low,
                        "ge": g_high,
                        "exon": _exon_number_at(exons_ordered, g_low, g_high),
                    })
                return out

            if wanted == "protein":
                if not transcript["cds_list"]:
                    return {**empty, "status": "no_cds"}
                translated = translate_transcript(
                    genome, fasta, resolved, strand, transcript["cds_list"],
                )
                protein = str(translated.get("protein") or "")
                if not protein:
                    return {**empty, "status": "error"}
                intervals = tx_feature_intervals(
                    fasta, resolved, strand,
                    transcript["exons"], transcript["cds_list"], transcript["utrs"],
                )
                return {
                    **empty,
                    "status": "ok",
                    "length": len(protein),
                    "sequence": protein,
                    # The residues carry no annotation of their own; what marks
                    # are worth drawing on them -- the initiator and any internal
                    # stop -- the client works out from the letters, because they
                    # are facts about the protein rather than about the genome.
                    "runs": [],
                    # In codon-aligned CDS bases, not in residues: residue n is at
                    # positions 3n-2..3n, which is what lets one residue be
                    # mapped back to the three bases that spell it -- and they can
                    # be in two different exons.
                    "segments": _named(translated.get("segments") or []),
                    "phase": int(translated.get("phase") or 0),
                    "pad": int(translated.get("pad") or 0),
                    "codingLength": int(translated.get("cds_length") or 0),
                    "droppedTrailing": int(translated.get("dropped_trailing") or 0),
                    "table": int(translated.get("table") or 1),
                    "molecule": str(translated.get("molecule") or "nuclear"),
                    "internalStops": int(translated.get("internal_stops") or 0),
                    "startVerified": any(i.get("type") == "start_codon" for i in intervals),
                }

            _, _, segments, status = mode_segments(
                transcript["start"], transcript["end"], strand,
                transcript["exons"], transcript["cds_list"], wanted,
            )
            if status == "no_cds":
                return {**empty, "status": "no_cds"}
            if status != "ok" or not segments:
                return {**empty, "status": "error"}

            length = int(segments[-1]["coord_end"])
            if length > MAX_SPLICED_BP:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"{length:,} bases is more spliced sequence than this view will read "
                        f"at once (up to {MAX_SPLICED_BP:,})."
                    ),
                )

            # Read segment by segment in reading order. Each piece is oriented as
            # it is read, which is the same rule /fasta's spliced path uses: the
            # reverse complement of a joined sequence is its pieces' reverse
            # complements taken in the opposite order, and the segments are
            # already in that order.
            pieces = []
            for segment in segments:
                g_low = min(int(segment["genomic_start"]), int(segment["genomic_end"]))
                g_high = max(int(segment["genomic_start"]), int(segment["genomic_end"]))
                raw = str(fasta.fetch(resolved, g_low - 1, g_high) or "").upper()
                pieces.append(_reverse_complement(raw) if strand == "-" else raw)
            sequence = "".join(pieces)

            intervals = tx_feature_intervals(
                fasta, resolved, strand,
                transcript["exons"], transcript["cds_list"], transcript["utrs"],
            )
            runs = spliced_classes(intervals, segments, strand, length)

            # Where the coding sequence sits in whatever space this answer is in.
            # For a CDS answer that is the whole of it; for a transcript answer it
            # is what tells the client which stretch to stripe by codon and which
            # part it could translate.
            cds_extent = None
            if transcript["cds_list"]:
                projected = []
                for piece in transcript["cds_list"]:
                    projected.extend(project_to_spliced(
                        segments, strand, int(piece["start"]), int(piece["end"]),
                    ))
                if projected:
                    cds_extent = {
                        "s": min(p[0] for p in projected),
                        "e": max(p[1] for p in projected),
                    }

            # Where translation starts inside the first coding segment. A CDS
            # whose 5' end is missing from the annotation begins mid-codon, so a
            # reader counting codons off the CDS tab has to be told where the
            # first whole one starts.
            phase = 0
            if wanted == "cds":
                raw_phase = segments[0].get("phase")
                if raw_phase in (0, 1, 2):
                    phase = int(raw_phase)

            return {
                **empty,
                "status": "ok",
                "length": length,
                "sequence": sequence,
                "runs": runs,
                "segments": _named(segments),
                "cds": cds_extent,
                "phase": phase,
                # Whether the annotation's own start codon reads ATG on the
                # assembly. The view draws an unverified frame flat rather than
                # striped; the panel says so in words rather than drawing
                # nothing.
                "startVerified": any(i.get("type") == "start_codon" for i in intervals),
            }

        return await run_in_threadpool(_query)

    # ---- one base, in full ----------------------------------------------

    def _numbered_feature(transcript: Dict[str, Any], coord: int) -> Dict[str, Any]:
        """Which exon or intron of a transcript a base falls in, as a reader counts.

        Numbered 5' to 3' by the same function ``/focus/features`` numbers with,
        so the box and the drawer's list of exons agree about which one is exon
        one -- on the minus strand that is the rightmost, and two answers here
        would be two answers about the same thing.
        """
        at = int(coord)
        exons = ordered_five_to_three(transcript.get("exons") or [], transcript["strand"])
        for number, exon in enumerate(exons, start=1):
            if int(exon["start"]) <= at <= int(exon["end"]):
                return {"kind": "exon", "index": number, "count": len(exons)}
        for number in range(len(exons) - 1):
            here, following = exons[number], exons[number + 1]
            if transcript["strand"] == "-":
                low, high = int(following["end"]) + 1, int(here["start"]) - 1
            else:
                low, high = int(here["end"]) + 1, int(following["start"]) - 1
            if low <= at <= high:
                return {"kind": "intron", "index": number + 1, "count": max(0, len(exons) - 1)}
        return {"kind": "", "index": 0, "count": 0}

    def _drawn_class(genes, coord, level, gene_id, transcript_id) -> str:
        """What the view drew at this base, at the level it is being read at.

        By the same functions that drew it, over the same visible features, so
        the box cannot disagree with the colour it is explaining -- which is the
        whole reason it is computed here rather than described in the client.

        Above the transcript there are several voices and the answer can be
        "mixed"; at a transcript there is one, and it is the one on screen.
        """
        if level in ("transcript", "feature"):
            for gene in genes:
                for transcript in gene["transcripts"]:
                    if transcript["id"] == transcript_id:
                        return base_class_in_transcript(transcript, coord) or ""
            return ""
        if level == "gene":
            for gene in genes:
                if gene["id"] != gene_id:
                    continue
                own = gene_union_classes(
                    gene["transcripts"], coord, coord, gene["start"], gene["end"],
                )
                return own[0]["c"] if own else ""
            # The reader is on a gene and this base is outside it -- flanking
            # sequence, which the gene view draws with no class at all.
            return ""
        merged = location_gene_classes(genes, coord, coord)
        return merged[0]["c"] if merged else ""

    @router.get("/base", response_model=BaseResponse)
    async def base_detail(
        genome: str = "reference",
        chrom: str = "",
        coord: int = Query(default=0, ge=1),
        hide: str = "",
        level: str = "location",
        gene_id: str = "",
        transcript_id: str = "",
    ):
        """Everything known about one base.

        The colours can only show one answer per base, and where genes overlap or
        isoforms disagree that answer is "mixed" -- true, and not what the reader
        wanted to know. This is the long form: which genes cover the base, what
        each of them calls it, and which exon or intron of which isoform it is.

        `cls` is what the view drew *at the level it is being read at*: a
        transcript in focus is the only thing describing its own bases, so saying
        "mixed" there because two other isoforms disagree would be describing
        something that is not on screen. The genes and isoforms below are listed
        whatever the level -- that a base is coding in one isoform and untranslated
        in another is worth knowing wherever you are standing -- but which of them
        the view is actually drawing is marked, so the box can offer to read into
        the others rather than pretending they can be switched off here.

        Hidden features are listed but marked, and left out of the class -- the
        box is where a reader turns one back on, so it is the one place they must
        not disappear from.

        Not cached. It is one coordinate, the work is a gene lookup and a handful
        of interval tests, and a cache keyed per base would evict everything else
        in the map for answers nobody asks for twice.
        """
        hidden = _parse_hidden(hide)

        def _query():
            fasta = fasta_provider(genome)
            resolved, chrom_length = _resolve_chrom(fasta, genome, chrom)
            if coord > chrom_length:
                raise HTTPException(status_code=404, detail=f"Region not found: {chrom}:{coord}")

            raw = str(fasta.fetch(resolved, coord - 1, coord) or "")
            payload: Dict[str, Any] = {
                "chrom": resolved, "coord": coord,
                "level": level if level in LEVELS else "location",
                "base": raw.upper(),
                # Soft-masking is case in the FASTA, and this is the one place
                # that reads a single base, so it is read straight off it.
                "masked": bool(raw) and raw.islower(),
                "annotation": "ready", "cls": "", "genes": [], "gene_count": 0,
                "truncated": False,
            }

            db_path = db_optional_provider(genome)
            if not db_path:
                payload["annotation"] = "absent"
                return payload

            connection = _connect(db_path)
            try:
                rows = connection.execute(
                    "SELECT id, name, start, end, strand, biotype FROM genes "
                    "WHERE chrom = ? AND end >= ? AND start <= ? ORDER BY start ASC",
                    (resolved, coord, coord),
                ).fetchall()
                genes = []
                for row in rows[:MAX_BASE_GENES]:
                    genes.append({
                        "id": str(row["id"]),
                        "name": str(row["name"] or ""),
                        "biotype": str(row["biotype"] or ""),
                        "strand": str(row["strand"] or "+"),
                        "start": int(row["start"]),
                        "end": int(row["end"]),
                        "transcripts": _transcripts_of(connection, str(row["id"])),
                    })
            finally:
                connection.close()

            payload["gene_count"] = len(rows)
            payload["truncated"] = len(rows) > len(genes)
            # The class the view drew, by the same function that drew it -- over
            # the same visible features, so the box can never disagree with the
            # colour it is explaining.
            shown = [
                {**gene, "transcripts": _visible(gene["transcripts"], hidden)}
                for gene in genes if gene["id"] not in hidden
            ]
            payload["cls"] = _drawn_class(shown, coord, level, gene_id, transcript_id)

            out = []
            for gene in genes:
                own = gene_union_classes(
                    _visible(gene["transcripts"], hidden),
                    coord, coord, gene["start"], gene["end"],
                )
                isoforms = []
                for transcript in gene["transcripts"]:
                    said = base_class_in_transcript(transcript, coord)
                    if not said:
                        continue
                    where = _numbered_feature(transcript, coord)
                    isoforms.append({
                        "id": transcript["id"],
                        "biotype": transcript["biotype"],
                        "canonical": bool(transcript["is_canonical"]),
                        "cls": said,
                        "hidden": transcript["id"] in hidden,
                        "focus": transcript["id"] == transcript_id,
                        "s": int(transcript["start"]),
                        "e": int(transcript["end"]),
                        "strand": str(transcript["strand"] or "+"),
                        **where,
                    })
                out.append({
                    "id": gene["id"], "name": gene["name"], "biotype": gene["biotype"],
                    "strand": gene["strand"], "s": gene["start"], "e": gene["end"],
                    "cls": own[0]["c"] if own else "",
                    "hidden": gene["id"] in hidden,
                    "focus": gene["id"] == gene_id,
                    "transcripts": isoforms,
                    # Of the gene, not of the list above: the box says "2 of 11
                    # isoforms reach this base", which is the interesting part.
                    "transcript_count": len(gene["transcripts"]),
                })
            payload["genes"] = out
            return payload

        return await run_in_threadpool(_query)

    @router.get("/spans")
    async def spans(
        genome: str = "reference",
        chrom: str = "",
        start: int = Query(default=0, ge=0),
        end: int = Query(default=0, ge=0),
        level: str = "location",
        gene_id: str = "",
        transcript_id: str = "",
    ):
        """Where the genes and their exons are, so the rest can be collapsed.

        Answered separately from ``/classes`` rather than derived from its runs,
        for two reasons. A location focus tiles its classes around the window, so
        it never holds the whole region's shape -- and the shape is exactly what
        a collapsed layout needs before it can place a single row. And the layout
        decides how many rows there are, so it has to arrive whether or not the
        annotation queue is busy.

        What is collapsed, how much of each stretch's ends is kept and how short
        a stretch has to be to be left alone are all the reader's, and all
        applied on the client -- so changing any of them re-lays-out the view
        without asking anything here.
        """
        if level not in LEVELS:
            raise HTTPException(status_code=400, detail=f"Unknown level: {level}")
        low, high = min(start, end), max(start, end)
        if high < low:
            raise HTTPException(status_code=400, detail="An ordered region is required")

        def _query():
            db_path = db_optional_provider(genome) if level == "location" else db_provider(genome)
            if not db_path:
                # A genome with no annotation has nothing dull to leave out, so
                # the honest answer is that everything is worth drawing.
                return {
                    "chrom": chrom, "start": low, "end": high, "level": level,
                    "annotation": "absent", "genic": [], "exonic": [],
                    "offers": [], "gene_count": 0,
                }

            fingerprint = source_fingerprint(db_path)
            # The shape is in the key. This cache outlives a restart, so an
            # answer written by an older version of this endpoint is still on
            # disk after an upgrade -- and one carrying the fields this route
            # used to return would be read as a region that can collapse
            # nothing, silently. Raise this whenever the payload changes.
            key = cache_key("spans", SPANS_SHAPE, fingerprint, chrom, low, high, level, gene_id, transcript_id)
            cached = classes_cache.get(key)
            if cached is not None:
                return cached

            connection = _connect(db_path)
            try:
                gene_count = 0
                genes = None
                transcripts = None
                gene_transcripts = None

                if level in ("transcript", "feature"):
                    transcripts = [_transcript_by_id(connection, transcript_id)]
                elif level == "gene":
                    transcripts = _transcripts_of(connection, gene_id)
                    # The gene's own span, so that the sequence around it reads
                    # as what it is -- outside every gene -- rather than as part
                    # of the gene's introns.
                    gene = _gene_row(connection, gene_id)
                    genes = [{"start": int(gene["start"]), "end": int(gene["end"])}]
                else:
                    genes = connection.execute(
                        "SELECT id, start, end FROM genes "
                        "WHERE chrom = ? AND end >= ? AND start <= ? ORDER BY start ASC",
                        (chrom, low, high),
                    ).fetchall()
                    gene_count = len(genes)
                    if gene_count <= MAX_INTRON_COLLAPSE_GENES:
                        # Few enough to read every isoform, so the introns inside
                        # these genes can be collapsed as well as the sequence
                        # between them.
                        gene_transcripts = []
                        for row in genes:
                            gene_transcripts.extend(_transcripts_of(connection, str(row["id"])))
            finally:
                connection.close()

            answer = spans_for_level(
                level,
                window=(low, high),
                transcripts=transcripts,
                genes=genes,
                gene_transcripts=gene_transcripts,
                gene_count=gene_count,
            )
            payload = {
                "chrom": chrom, "start": low, "end": high, "level": level,
                "annotation": "ready", "gene_count": gene_count,
                **answer,
            }
            classes_cache.put(key, payload)
            return payload

        return await run_in_threadpool(_query)

    @router.get("/search")
    async def search(genome: str = "reference", query: str = "", chrom: str = ""):
        """Find a gene or a transcript by symbol or identifier.

        Answers with everything the view needs to focus the result in one go --
        the gene, and the transcript when the query named one -- so that a search
        does not turn into three more round trips before anything moves.

        Exact matches first, in the order a reader means them: the symbol they
        typed, then an identifier, then a prefix. A substring match is offered
        last and only when nothing better exists, because "MT" should find MT
        rather than the four hundred genes with MT in the middle of their names.
        """
        token = str(query or "").strip()
        if not token:
            raise HTTPException(status_code=400, detail="Type a gene symbol or identifier")

        def _query():
            db_path = db_optional_provider(genome)
            if not db_path:
                return {"found": False, "reason": "This genome has no annotation loaded."}
            connection = _connect(db_path)
            try:
                # A transcript identifier is worth answering with its own focus.
                transcript = connection.execute(
                    "SELECT id, parent_gene_id FROM transcripts WHERE id = ? COLLATE NOCASE",
                    (token,),
                ).fetchone()
                if transcript:
                    gene = _gene_row(connection, str(transcript["parent_gene_id"]))
                    return _search_answer(connection, gene, str(transcript["id"]))

                like = token.replace("%", "").replace("_", "") + "%"
                attempts = (
                    ("SELECT * FROM genes WHERE name = ? COLLATE NOCASE", (token,)),
                    ("SELECT * FROM genes WHERE id = ? COLLATE NOCASE", (token,)),
                    ("SELECT * FROM genes WHERE name LIKE ? COLLATE NOCASE ORDER BY LENGTH(name) LIMIT 1", (like,)),
                    ("SELECT * FROM genes WHERE id LIKE ? COLLATE NOCASE ORDER BY LENGTH(id) LIMIT 1", (like,)),
                )
                for sql, params in attempts:
                    # A region in view breaks a tie between genes of the same
                    # name on different contigs; it never excludes a match.
                    if chrom:
                        here = connection.execute(
                            sql.replace("FROM genes WHERE", "FROM genes WHERE chrom = ? AND", 1),
                            (chrom, *params),
                        ).fetchone()
                        if here:
                            return _search_answer(connection, here, "")
                    row = connection.execute(sql, params).fetchone()
                    if row:
                        return _search_answer(connection, row, "")
                return {"found": False, "reason": f"Nothing here is called \u201c{token}\u201d."}
            finally:
                connection.close()

        return await run_in_threadpool(_query)

    def _search_answer(connection, gene_row, transcript_id):
        gene = {
            "id": str(gene_row["id"]), "name": str(gene_row["name"] or ""),
            "chrom": str(gene_row["chrom"]),
            "s": int(gene_row["start"]), "e": int(gene_row["end"]),
            "strand": str(gene_row["strand"] or "+"),
            "biotype": str(gene_row["biotype"] or ""),
        }
        answer = {"found": True, "gene": gene, "transcript": None}
        if transcript_id:
            row = connection.execute(
                "SELECT id, start, end, strand, data FROM transcripts WHERE id = ?",
                (transcript_id,),
            ).fetchone()
            if row:
                try:
                    data = json.loads(row["data"] or "{}")
                except ValueError:
                    data = {}
                answer["transcript"] = {
                    "id": str(row["id"]), "s": int(row["start"]), "e": int(row["end"]),
                    "strand": str(row["strand"] or "+"),
                    "biotype": str(data.get("biotype", "") or ""),
                }
        return answer

    # ---- download -------------------------------------------------------

    @router.get("/fasta")
    async def fasta_download(
        genome: str = "reference",
        chrom: str = "",
        start: int = Query(ge=1),
        end: int = Query(ge=1),
        strand: str = "+",
        label: str = "",
        download: bool = False,
        seg: List[str] = Query(default_factory=list),
    ):
        """The focused region as plain FASTA, streamed.

        Streamed rather than assembled because the amount asked for is not
        bounded by anything the reader can see: a location focus can be a whole
        chromosome, and holding 249 Mb of sequence, the joined copy of it and the
        wrapped copy of that costs over a gigabyte in this process for one
        request. Reading it is cheap -- a few seconds -- so the only thing that
        made it impossible was keeping it all at once, and nothing here does now.

        Written here rather than assembled in the browser for the same reason,
        plus one more: copying a gene should not depend on which of its sequence
        chunks happen to be cached.

        `seg` is how a collapsed record is copied: repeated `start-end` pairs, in
        genomic coordinates, and only those are written. What the reader is
        looking at is the kept stretches with the introns taken out, so that is
        what copying it gives them -- and the header says so, because a spliced
        sequence does not match its own coordinate range and a reader pasting it
        somewhere else has to be able to tell.
        """
        if end < start:
            raise HTTPException(status_code=400, detail="The end must not come before the start")

        length = end - start + 1
        if not download and length > MAX_CLIPBOARD_BP and not seg:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"{length:,} bases is too much to copy. The clipboard takes up to "
                    f"{MAX_CLIPBOARD_BP:,}; download this region instead."
                ),
            )

        fasta = fasta_provider(genome)
        resolved, chrom_length = _resolve_chrom(fasta, genome, chrom)
        window = clip_to_chromosome(start, end, chrom_length)
        if not window:
            raise HTTPException(status_code=404, detail="Region not found")
        low, high = window
        reverse = strand == "-"

        segments = _parse_segments(seg, low, high)
        if len(segments) > MAX_FASTA_SEGMENTS:
            raise HTTPException(
                status_code=400,
                detail=f"At most {MAX_FASTA_SEGMENTS} segments can be asked for at once",
            )

        def _read(piece_low: int, piece_high: int):
            """One stretch, in reading order, in pieces small enough to hold."""
            if reverse:
                cursor = piece_high
                while cursor >= piece_low:
                    piece_start = max(piece_low, cursor - FASTA_STREAM_BP + 1)
                    raw = str(fasta.fetch(resolved, piece_start - 1, cursor) or "").upper()
                    yield _reverse_complement(raw)
                    cursor = piece_start - 1
            else:
                cursor = piece_low
                while cursor <= piece_high:
                    stop = min(piece_high, cursor + FASTA_STREAM_BP - 1)
                    yield str(fasta.fetch(resolved, cursor - 1, stop) or "").upper()
                    cursor = stop + 1

        def _spliced():
            # Wrapped across the joins rather than per segment: what this
            # describes is one continuous sequence with the dull parts taken
            # out, and a line break at every join would read as a record per
            # exon.
            header = fasta_header(resolved, low, high, strand, str(label or genome))
            hidden = (high - low + 1) - sum(end_ - start_ + 1 for start_, end_ in segments)
            yield f"{header} spliced:{len(segments)}_segments -{hidden}bp\n"
            held = ""
            ordered = sorted(segments, reverse=reverse)
            for piece_low, piece_high in ordered:
                for chunk in _read(piece_low, piece_high):
                    held += chunk
                    if len(held) >= FASTA_STREAM_BP:
                        keep = len(held) - (len(held) % FASTA_LINE_WIDTH)
                        yield wrap_sequence(held[:keep], FASTA_LINE_WIDTH) + "\n"
                        held = held[keep:]
            if held:
                yield wrap_sequence(held, FASTA_LINE_WIDTH) + "\n"

        def _pieces():
            if segments:
                yield from _spliced()
                return
            yield fasta_header(resolved, low, high, strand, str(label or genome)) + "\n"
            if reverse:
                # Read from the far end back, complementing each piece as it
                # goes: the reverse complement of a whole region is the reverse
                # complements of its pieces, taken in the opposite order.
                cursor = high
                while cursor >= low:
                    piece_start = max(low, cursor - FASTA_STREAM_BP + 1)
                    raw = str(fasta.fetch(resolved, piece_start - 1, cursor) or "").upper()
                    yield wrap_sequence(_reverse_complement(raw), FASTA_LINE_WIDTH) + "\n"
                    cursor = piece_start - 1
            else:
                cursor = low
                while cursor <= high:
                    stop = min(high, cursor + FASTA_STREAM_BP - 1)
                    raw = str(fasta.fetch(resolved, cursor - 1, stop) or "").upper()
                    yield wrap_sequence(raw, FASTA_LINE_WIDTH) + "\n"
                    cursor = stop + 1

        headers = {}
        if download:
            name = f"{resolved}_{low}-{high}{'_rev' if reverse else ''}.fa"
            headers["Content-Disposition"] = f'attachment; filename="{name}"'
        return StreamingResponse(_pieces(), media_type="text/plain; charset=utf-8", headers=headers)

    return router


_COMPLEMENT = str.maketrans(
    "ACGTUNRYSWKMBVDHacgtunryswkmbvdh",
    "TGCAANYRSWMKVBHDtgcaanyrswmkvbhd",
)


def _parse_hidden(raw: str) -> frozenset:
    """The identifiers a reader has silenced, as a set.

    Sorted and de-duplicated by the caller's own key, not here -- what matters
    for the cache is that the same set of hidden things produces the same key,
    which `cache_key` gets from the sorted tuple below.
    """
    if not raw:
        return frozenset()
    ids = {token.strip() for token in str(raw).split(",") if token.strip()}
    if len(ids) > MAX_HIDDEN:
        raise HTTPException(
            status_code=400,
            detail=f"At most {MAX_HIDDEN} features can be hidden at once",
        )
    return frozenset(ids)


def _visible(transcripts, hidden):
    return [t for t in transcripts if t["id"] not in hidden]


def _parse_segments(raw: List[str], low: int, high: int) -> List[tuple]:
    """`start-end` pairs, clipped to the window and merged.

    Merged because two stretches that touch are one, and a record whose
    segments overlapped would otherwise write the shared bases twice.
    """
    parsed = []
    for item in raw or []:
        text = str(item or "").strip()
        if not text:
            continue
        piece = text.split("-")
        if len(piece) != 2:
            raise HTTPException(status_code=400, detail=f"Not a segment: {text}")
        try:
            start, end = int(piece[0]), int(piece[1])
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Not a segment: {text}")
        start, end = max(low, min(start, end)), min(high, max(start, end))
        if end >= start:
            parsed.append((start, end))
    parsed.sort()
    merged: List[tuple] = []
    for start, end in parsed:
        if merged and start <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _reverse_complement(sequence: str) -> str:
    return sequence.translate(_COMPLEMENT)[::-1]

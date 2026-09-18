"""Where the genes are in a region, and where their exons are.

The view can collapse the parts a reader is not looking at -- intergenic
sequence between genes, intronic sequence inside them -- into a marker saying
how much was skipped. The two are separate switches, each with its own flank and
its own floor, so what the backend answers is not "what to keep" but the two
span lists every version of that question is derived from:

    intergenic = the region, minus the genes
    intronic   = the genes, minus their exons

Both subtractions are the client's, and so are the flanks, the floors and the
markers. That is deliberate: a reader changing their mind about which kind to
hide, or how much of its edges to keep, is changing nothing about the annotation,
and it re-lays-out the view without a round trip. What needs the annotation --
where the genes and exons are -- is answered once and cached.

Coordinates are 1-based inclusive on both ends, on the forward strand, as
everywhere else in this package.
"""

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# How many genes a region may hold before its introns stop being collapsible.
#
# Collapsing introns at location level means reading every isoform of every gene
# in view out of its JSON blob. For the few dozen genes a screenful of sequence
# sits among that is quick; for the seven thousand on human chromosome 1 it is
# minutes, and nobody reading a whole chromosome is looking at splice sites. Over
# the limit the answer keeps whole genes instead, and says so.
MAX_INTRON_COLLAPSE_GENES = 100


def merge_spans(spans: Iterable[Any]) -> List[Dict[str, int]]:
    """Ordered, non-overlapping, with touching spans joined.

    Adjacent spans are joined as well as overlapping ones: two stretches that
    touch have no gap between them to collapse, so leaving them apart would
    invent one and put a marker over nothing.
    """
    clean: List[Tuple[int, int]] = []
    for item in spans or []:
        if item is None:
            continue
        if isinstance(item, dict):
            raw_start = item.get("s", item.get("start"))
            raw_end = item.get("e", item.get("end"))
        else:
            raw_start, raw_end = item[0], item[1]
        try:
            start = int(raw_start)
            end = int(raw_end)
        except (TypeError, ValueError):
            continue
        clean.append((min(start, end), max(start, end)))

    clean.sort()
    out: List[Dict[str, int]] = []
    for start, end in clean:
        if out and start <= out[-1]["e"] + 1:
            out[-1]["e"] = max(out[-1]["e"], end)
        else:
            out.append({"s": start, "e": end})
    return out


def clip_spans(spans: Iterable[Dict[str, int]], low: int, high: int) -> List[Dict[str, int]]:
    """Only the parts inside the window, in order."""
    out: List[Dict[str, int]] = []
    for span in spans or []:
        start = max(int(low), int(span["s"]))
        end = min(int(high), int(span["e"]))
        if end >= start:
            out.append({"s": start, "e": end})
    return out


def exon_spans(transcript: Dict[str, Any]) -> List[Dict[str, int]]:
    """One transcript's exons, merged."""
    return merge_spans(
        {"s": exon.get("start"), "e": exon.get("end")}
        for exon in (transcript or {}).get("exons", []) or []
    )


def exon_union(transcripts: Sequence[Dict[str, Any]]) -> List[Dict[str, int]]:
    """Every exon of every isoform, merged.

    A base exonic in any isoform is kept, because a base that is intron in one
    transcript and exon in another is exactly the kind a reader collapsing
    introns still wants to see -- the same rule the gene-level `mixed` class
    follows.
    """
    pooled: List[Dict[str, int]] = []
    for transcript in transcripts or []:
        pooled.extend(exon_spans(transcript))
    return merge_spans(pooled)


def gene_spans(rows: Iterable[Any]) -> List[Dict[str, int]]:
    """Whole features, merged -- so the gaps between them are what lies outside.

    Takes anything subscriptable by ``start`` and ``end``: a gene row from the
    database, or a transcript already read out of one. At a location these are
    the genes and the gaps are intergenic; at a gene or a transcript it is the
    one thing in focus and the gaps are its flanks.
    """
    return merge_spans({"s": row["start"], "e": row["end"]} for row in rows or [])


def spans_for_level(
    level: str,
    *,
    window: Tuple[int, int],
    transcripts: Optional[Sequence[Dict[str, Any]]] = None,
    genes: Optional[Sequence[Any]] = None,
    gene_transcripts: Optional[Sequence[Dict[str, Any]]] = None,
    gene_count: int = 0,
) -> Dict[str, Any]:
    """The genic and exonic stretches of a window, and what they allow.

    ``offers`` names the kinds of collapse this answer can support. Both, at
    almost every level; intergenic only at a location with too many genes for
    reading every isoform of every one of them to be quick, where ``exonic``
    comes back as None rather than as an empty list and ``limited`` says why. The two mean opposite
    things -- nothing is exonic here, against nobody asked -- and an empty list
    would make every base of every gene look collapsible as an intron.

    A location's genic spans are its genes. A gene's is the gene itself and a
    transcript's is the transcript, so that at those levels the flanking
    sequence around the thing in focus is the region's intergenic part, which is
    what it is.
    """
    low, high = min(window), max(window)

    if level in ("transcript", "feature"):
        pooled: List[Dict[str, int]] = []
        for transcript in transcripts or []:
            pooled.extend(exon_spans(transcript))
        return {
            "genic": clip_spans(gene_spans(transcripts or []), low, high),
            "exonic": clip_spans(merge_spans(pooled), low, high),
            "offers": ["intergenic", "intron"],
        }

    if level == "gene":
        return {
            "genic": clip_spans(gene_spans(genes or []), low, high),
            "exonic": clip_spans(exon_union(transcripts or []), low, high),
            "offers": ["intergenic", "intron"],
        }

    # Location. Whole genes always; their exons too when there are few enough
    # genes for reading every isoform to be quick.
    if gene_transcripts is not None and gene_count <= MAX_INTRON_COLLAPSE_GENES:
        return {
            "genic": clip_spans(gene_spans(genes or []), low, high),
            "exonic": clip_spans(exon_union(gene_transcripts), low, high),
            "offers": ["intergenic", "intron"],
        }
    return {
        "genic": clip_spans(gene_spans(genes or []), low, high),
        "exonic": None,
        "offers": ["intergenic"],
        # Why, positively. The client used to work this out from the absence of
        # "intron" in `offers`, which meant anything it failed to understand
        # about an answer came out as "too many genes here" -- a sentence with a
        # number in it that a reader cannot argue with and that was not true.
        "limited": "gene_count",
    }

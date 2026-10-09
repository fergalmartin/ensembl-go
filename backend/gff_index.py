"""The SQLite index of a genome's GFF3 annotation, and the single background
worker that builds them.

Builds are serialised per database (in-process locks plus an fcntl sidecar lock
across processes) and globally through a one-slot semaphore; a finished build is
swapped into place atomically. `_is_existing_index_usable` is the lock-free fast
path every browse request takes first.
"""

import json
import logging
import os
import queue
import re
import sqlite3
import subprocess
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import unquote

try:
    import fcntl  # Unix/macOS cross-process file locking
except ImportError:  # pragma: no cover - unavailable on Windows
    fcntl = None

import file_io
from annotation import CooperativeYielder
from genome_identity import annotation_name_stem, parse_local_data_relative_parts
from stats_utils import now_iso

logger = logging.getLogger(__name__)


@dataclass
# ============ Lightweight GFF3 Parser ============


class SimpleFeature:
    """Generic genomic feature."""
    feature_type: str  # exon, CDS, five_prime_UTR, three_prime_UTR
    start: int
    end: int
    strand: str
    phase: Optional[int] = None


@dataclass
class SimpleTranscript:
    feature_id: str
    seq_region: str
    start: int
    end: int
    strand: str
    exons: List[SimpleFeature]
    cds_list: List[SimpleFeature]
    utrs: List[SimpleFeature]
    biotype: str = ""


def find_transcript_fast(gff_path: str, transcript_id: str) -> Optional[SimpleTranscript]:
    """Use grep to quickly find a transcript in a GFF3 file."""
    
    # Normalize ID for searching
    search_id = transcript_id.replace("transcript:", "").replace("mapped_transcript:", "")
    
    file_io.log_progress(f"  Searching for {search_id} in {Path(gff_path).name}...")

    # Use grep to find matching lines. The ID is a literal, so -F matches it as a
    # fixed string rather than a regex, and "--" keeps an ID that starts with "-"
    # from being parsed as a grep option.
    try:
        result = subprocess.run(
            ["grep", "-F", "--", search_id, gff_path],
            capture_output=True, text=True, timeout=30
        )
    except subprocess.TimeoutExpired:
        file_io.log_progress(f"  ✗ Grep timeout")
        return None
    
    if result.returncode != 0 or not result.stdout.strip():
        file_io.log_progress(f"  ✗ Not found")
        return None
    
    lines = result.stdout.strip().split('\n')
    
    # Parse the lines
    transcript_line = None
    exon_lines = []
    cds_lines = []
    utr_lines = []
    
    # Feature types that represent transcripts
    transcript_types = {'lnc_RNA', 'mRNA', 'transcript', 'ncRNA', 'rRNA', 'snRNA', 
                        'snoRNA', 'miRNA', 'misc_RNA', 'pseudogenic_transcript',
                        'processed_transcript', 'unconfirmed_transcript'}
    
    for line in lines:
        if line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) < 9:
            continue
        
        feature_type = parts[2]
        attrs = parts[8]
        
        # Check if this is our transcript - check multiple ways
        if feature_type in transcript_types:
            # Method 1: Check ID attribute
            id_match = re.search(r'ID=([^;]+)', attrs)
            if id_match:
                line_id = id_match.group(1).replace("transcript:", "").replace("mapped_transcript:", "")
                if line_id == search_id:
                    transcript_line = parts
                    continue
            
            # Method 2: Check transcript_id attribute (used in mapped files)
            tx_id_match = re.search(r'transcript_id=([^;]+)', attrs)
            if tx_id_match:
                tx_id = tx_id_match.group(1)
                if tx_id == search_id:
                    transcript_line = parts
                    continue
        
        # Check Parent for child features (exon, CDS, UTR)
        parent_match = re.search(r'Parent=([^;]+)', attrs)
        if parent_match:
            parent_id = parent_match.group(1).replace("mapped_transcript:", "").replace("transcript:", "")
            if parent_id == search_id:
                if feature_type == 'exon':
                    exon_lines.append(parts)
                elif feature_type == 'CDS':
                    cds_lines.append(parts)
                elif feature_type in ('five_prime_UTR', 'three_prime_UTR'):
                    utr_lines.append((feature_type, parts))
    
    if not transcript_line:
        file_io.log_progress(f"  ✗ Transcript line not found")
        return None
    
    # Build transcript object
    chrom = transcript_line[0]
    start = int(transcript_line[3])
    end = int(transcript_line[4])
    strand = transcript_line[6]
    
    # Parse biotype from attributes
    biotype = ""
    biotype_match = re.search(r'biotype=([^;]+)', transcript_line[8])
    if biotype_match:
        biotype = biotype_match.group(1)
    
    # Build exons
    exons = []
    for exon_parts in exon_lines:
        exons.append(SimpleFeature(
            feature_type="exon",
            start=int(exon_parts[3]),
            end=int(exon_parts[4]),
            strand=exon_parts[6]
        ))
    exons.sort(key=lambda e: e.start)
    
    # Build CDS
    cds_list = []
    for cds_parts in cds_lines:
        phase_raw = str(cds_parts[7]).strip() if len(cds_parts) > 7 else "."
        phase_value: Optional[int] = None
        if phase_raw in {"0", "1", "2"}:
            phase_value = int(phase_raw)
        cds_list.append(SimpleFeature(
            feature_type="CDS",
            start=int(cds_parts[3]),
            end=int(cds_parts[4]),
            strand=cds_parts[6],
            phase=phase_value,
        ))
    cds_list.sort(key=lambda c: c.start)
    
    # Build UTRs
    utrs = []
    for utr_type, utr_parts in utr_lines:
        utrs.append(SimpleFeature(
            feature_type=utr_type,
            start=int(utr_parts[3]),
            end=int(utr_parts[4]),
            strand=utr_parts[6]
        ))
    
    file_io.log_progress(f"  ✓ Found: {chrom}:{start}-{end} ({strand}) with {len(exons)} exons, {len(cds_list)} CDS, {len(utrs)} UTRs")
    
    return SimpleTranscript(
        feature_id=search_id,
        seq_region=chrom,
        start=start,
        end=end,
        strand=strand,
        exons=exons,
        cds_list=cds_list,
        utrs=utrs,
        biotype=biotype
    )


def find_transcript_in_index(db_path: str, transcript_id: str) -> Optional[SimpleTranscript]:
    """Look up transcript in SQLite index."""
    if not db_path or not os.path.exists(db_path):
        return None
        
    search_id = transcript_id.replace("transcript:", "").replace("mapped_transcript:", "")
    
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute("SELECT data FROM transcripts WHERE id=?", (search_id,))
        row = c.fetchone()
        conn.close()
        
        if row:
            data = json.loads(row[0])
            # Reconstruct SimpleTranscript
            exons = [SimpleFeature(**x) for x in data['exons']]
            cds_list = [SimpleFeature(**x) for x in data['cds_list']]
            utrs = [SimpleFeature(**x) for x in data['utrs']]
            
            return SimpleTranscript(
                feature_id=data['feature_id'],
                seq_region=data['seq_region'],
                start=data['start'],
                end=data['end'],
                strand=data['strand'],
                exons=exons,
                cds_list=cds_list,
                utrs=utrs,
                biotype=data.get('biotype', '')
            )
    except Exception as e:
        logger.error(f"Index lookup failed: {e}")
        
    return None


# Serialize GFF index builds per database path to prevent concurrent writers
# from clobbering the same SQLite file.
_index_build_locks_guard = threading.Lock()


_index_build_locks: Dict[str, threading.Lock] = {}


# The parser retains transcript models while indexing and is deliberately
# memory-heavy. Limit full rebuilds to one per backend process; normal reads of
# existing indexes do not acquire this semaphore.
_index_rebuild_guard = threading.Semaphore(1)


# In-memory task registry for background GFF index builds.
_index_tasks_guard = threading.Lock()


_index_tasks: Dict[str, Dict[str, Any]] = {}  # task_id -> {status, index_path, error}


_index_task_queue: "queue.Queue[Tuple[str, str, str]]" = queue.Queue()


_index_worker_guard = threading.Lock()


_index_worker_started = False


GFF_INDEX_FORMAT_VERSION = "6"


# Version 6 changes how child-before-parent GFF records are populated, but not
# the SQLite schema. Version 5 indexes therefore remain safe to read and must
# not trigger a destructive, multi-genome rebuild during application startup.
GFF_INDEX_COMPATIBLE_VERSIONS = frozenset({"5", GFF_INDEX_FORMAT_VERSION})


# ============ SQLite Indexing ============


def _normalize_fs_path(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def _get_index_build_lock(db_path: str) -> threading.Lock:
    normalized = _normalize_fs_path(db_path)
    with _index_build_locks_guard:
        lock = _index_build_locks.get(normalized)
        if lock is None:
            lock = threading.Lock()
            _index_build_locks[normalized] = lock
        return lock


def _is_existing_index_usable(db_path: str, gff_path: str) -> bool:
    """Return True when an existing SQLite index is readable and compatible.

    Old indexes without metadata are accepted if core tables are present.
    """
    normalized_db = _normalize_fs_path(db_path)
    normalized_gff = _normalize_fs_path(gff_path)
    if not normalized_db or not os.path.exists(normalized_db):
        return False

    conn = None
    try:
        conn = sqlite3.connect(f"file:{normalized_db}?mode=ro", uri=True, timeout=5)
        c = conn.cursor()
        c.execute("""
            SELECT name
            FROM sqlite_master
            WHERE type='table' AND name IN ('genes', 'transcripts')
        """)
        table_names = {row[0] for row in c.fetchall()}
        if "genes" not in table_names or "transcripts" not in table_names:
            return False

        source_gff = None
        source_mtime_ns = None
        source_size = None
        index_format_version = None
        try:
            c.execute("SELECT key, value FROM metadata WHERE key IN ('source_gff', 'source_mtime_ns', 'source_size', 'index_format_version')")
            meta = {row[0]: row[1] for row in c.fetchall()}
            source_gff = meta.get('source_gff')
            source_mtime_ns = meta.get('source_mtime_ns')
            source_size = meta.get('source_size')
            index_format_version = meta.get('index_format_version')
        except sqlite3.OperationalError:
            # Legacy index without metadata table.
            source_gff = None

        if not source_gff or _normalize_fs_path(source_gff) != normalized_gff:
            return False

        # Older indexes with missing file metadata are rebuilt once so we can
        # reliably detect updated GFF3 files going forward.
        if source_mtime_ns is None or source_size is None:
            return False
        if str(index_format_version or "") not in GFF_INDEX_COMPATIBLE_VERSIONS:
            return False

        try:
            stat = os.stat(normalized_gff)
        except OSError:
            return False

        if str(stat.st_mtime_ns) != str(source_mtime_ns):
            return False
        if str(stat.st_size) != str(source_size):
            return False

        return True
    except sqlite3.Error:
        return False
    finally:
        if conn:
            conn.close()


def ensure_gff_index(
    gff_path: str,
    db_path: str,
    force_rebuild: bool = False,
    progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> str:
    """Build a GFF index once per path, reusing existing compatible DB when possible.

    Rebuilds are written to a private temporary database and atomically swapped
    into place only after a successful parse. A sidecar file lock prevents two
    backend processes (for example across a development-server reload) from
    rebuilding the same index simultaneously.
    """
    normalized_db = _normalize_fs_path(db_path)
    abs_gff = _normalize_fs_path(gff_path)

    # Keep the overwhelmingly common startup/read path lock-free. Besides
    # avoiding filesystem churn, this permits a valid index in a read-only data
    # directory to be used without attempting to create a sidecar lock file.
    if not force_rebuild and _is_existing_index_usable(normalized_db, abs_gff):
        return normalized_db

    lock = _get_index_build_lock(normalized_db)
    with lock:
        lock_path = f"{normalized_db}.build.lock"
        Path(lock_path).parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "a+b") as process_lock:
            if fcntl is not None:
                fcntl.flock(process_lock.fileno(), fcntl.LOCK_EX)
            try:
                # Re-check after taking the process lock: another backend may
                # have completed the index while this request was waiting.
                if not force_rebuild and _is_existing_index_usable(normalized_db, abs_gff):
                    return normalized_db

                with _index_rebuild_guard:
                    if not force_rebuild and _is_existing_index_usable(normalized_db, abs_gff):
                        return normalized_db

                    build_path = (
                        f"{normalized_db}.building-{os.getpid()}-"
                        f"{uuid.uuid4().hex}.tmp"
                    )
                    try:
                        create_gff_index(abs_gff, build_path, progress_cb=progress_cb)
                        os.replace(build_path, normalized_db)
                    finally:
                        for suffix in ("", "-journal", "-wal", "-shm"):
                            candidate = f"{build_path}{suffix}"
                            try:
                                if os.path.exists(candidate):
                                    os.remove(candidate)
                            except OSError:
                                pass
                return normalized_db
            finally:
                if fcntl is not None:
                    fcntl.flock(process_lock.fileno(), fcntl.LOCK_UN)


def init_index_db(db_path: str):
    """Initialize the SQLite index database schema."""
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Metadata table to track which GFF this index was built from
    c.execute('''
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')

    # Table for transcripts (fast lookup by ID)
    c.execute('''
        CREATE TABLE IF NOT EXISTS transcripts (
            id TEXT PRIMARY KEY,
            chrom TEXT,
            start INTEGER,
            end INTEGER,
            strand TEXT,
            parent_gene_id TEXT,
            data JSON,  -- Full transcript object as JSON
            is_canonical INTEGER DEFAULT 0  -- 1 if tagged Ensembl_canonical
        )
    ''')

    # Table for genes (spatial lookup for neighbourhood and genome browser)
    c.execute('''
        CREATE TABLE IF NOT EXISTS genes (
            id TEXT PRIMARY KEY,
            chrom TEXT,
            start INTEGER,
            end INTEGER,
            strand TEXT,
            name TEXT,
            biotype TEXT DEFAULT '',
            description TEXT DEFAULT ''
        )
    ''')

    # Backward-compatible schema upgrade for existing indexes.
    c.execute("PRAGMA table_info(genes)")
    gene_cols = {str(row[1]) for row in (c.fetchall() or [])}
    if "description" not in gene_cols:
        c.execute("ALTER TABLE genes ADD COLUMN description TEXT DEFAULT ''")
    if "version" not in gene_cols:
        c.execute("ALTER TABLE genes ADD COLUMN version TEXT DEFAULT ''")

    # Indices for speed
    c.execute('CREATE INDEX IF NOT EXISTS idx_genes_chrom_start ON genes (chrom, start)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_genes_chrom_end ON genes (chrom, end)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_transcripts_parent ON transcripts (parent_gene_id)')

    conn.commit()
    conn.close()


def _read_position_source(handle):
    """The object whose ``tell()`` tracks how far through the file we have read.

    For a plain text handle that is its own buffer; for a gzip handle it is the
    compressed file underneath, so progress is measured in bytes of the file on
    disk in both cases and can be compared against its size. Returns ``None``
    when nothing in the chain reports a position, which is the signal to report
    an indeterminate build rather than a wrong percentage.
    """
    buffer = getattr(handle, "buffer", handle)
    for candidate in (getattr(buffer, "fileobj", None), getattr(buffer, "myfileobj", None), buffer):
        if candidate is None:
            continue
        try:
            candidate.tell()
        except Exception:
            continue
        return candidate
    return None


#: Lines between progress reports while parsing. Large enough that the check is
#: lost in the noise of parsing a line, small enough that the meter still moves
#: several times a second on a big annotation.
INDEX_PROGRESS_LINE_INTERVAL = 20000


def create_gff_index(gff_path: str, db_path: str, progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None):
    """Parse GFF3 and populate the SQLite index.

    ``progress_cb`` is called every :data:`INDEX_PROGRESS_LINE_INTERVAL` lines
    with the stage, the bytes read so far, and the running feature counts. The
    browser draws a meter from it: a multi-gigabyte annotation takes minutes,
    and an indeterminate spinner for that long is indistinguishable from a hang.
    """
    file_io.log_progress(f"Indexing {Path(gff_path).name} to {Path(db_path).name}...")

    def report(stage: str, position: int = 0, total: int = 0) -> None:
        if progress_cb is None:
            return
        try:
            progress_cb({
                "stage": stage,
                "processed_bytes": int(position),
                "total_bytes": int(total),
                "genes": int(count_genes),
                "transcripts": len(transcripts_data),
            })
        except Exception:
            pass  # Progress is decoration; never let it fail a build.
    
    if os.path.exists(db_path):
        os.remove(db_path)
        
    init_index_db(db_path)

    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Store source GFF metadata so we can validate/reuse indexes safely.
    stat = os.stat(gff_path)
    c.executemany(
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
        [
            ('source_gff', os.path.abspath(gff_path)),
            ('source_mtime_ns', str(stat.st_mtime_ns)),
            ('source_size', str(stat.st_size)),
            ('index_format_version', GFF_INDEX_FORMAT_VERSION),
        ],
    )

    # We need to collect genes and transcripts
    # Transcripts need their exons/CDS/UTRs for the full object
    
    # First pass: identify genes and transcripts, store raw lines or objects
    # This is complex because GFF3 is hierarchical.
    # To keep it simple and memory-efficient for this "lightweight" backend:
    # We will use the existing parsing logic but iterate through the whole file.
    
    # Actually, a single pass line-reader is best.
    
    genes_batch = []
    gene_coords_map = {}  # g_id -> (chrom, start, end, strand, biotype)
    gene_child_features = {}  # g_id -> {exons:[], cds:[], utrs:[]}
    transcripts_data = {} # id -> {parts, exons:[], cds:[], utrs:[]}
    # GFF3 only requires parents to exist somewhere in the document; it does not
    # require a transcript row to precede its exons/CDS/UTRs. Some Ensembl HPRC
    # files put the first exon before the transcript, so retain such children
    # until their parent is encountered instead of misclassifying them as gene
    # children.
    pending_transcript_child_features = {}
    pending_explicit_transcript_parents = set()
    
    gene_feature_types = {
        'gene',
        'pseudogene',
        'ncRNA_gene',
        'rRNA_gene',
        'snRNA_gene',
        'snoRNA_gene',
        'miRNA_gene',
        'misc_RNA_gene',
        'tRNA_gene',
        'transposable_element_gene',
        'scRNA_gene',
        'vault_RNA_gene',
    }

    feature_types = {'lnc_RNA', 'mRNA', 'transcript', 'ncRNA', 'rRNA', 'snRNA',
                    'snoRNA', 'miRNA', 'misc_RNA', 'pseudogenic_transcript',
                    'processed_transcript', 'unconfirmed_transcript',
                    'V_gene_segment', 'J_gene_segment', 'D_gene_segment', 'C_gene_segment',
                    'scRNA', 'tRNA', 'antisense_RNA', 'primary_transcript',
                    'guide_RNA', 'vault_RNA', 'RNase_P_RNA', 'RNase_MRP_RNA',
                    'SRP_RNA', 'telomerase_RNA'}
    child_feature_types = {'exon', 'CDS', 'five_prime_UTR', 'three_prime_UTR'}
    
    count_genes = 0
    count_tx = 0
    
    def parse_attrs(attr_str):
        return {k: v for k, v in [x.split('=', 1) for x in attr_str.split(';') if '=' in x]}

    def new_child_bucket():
        return {'exons': [], 'cds': [], 'utrs': []}

    def append_child(bucket, feature_type, feature_parts):
        if feature_type == 'exon':
            bucket['exons'].append(feature_parts)
        elif feature_type == 'CDS':
            bucket['cds'].append(feature_parts)
        else:
            bucket['utrs'].append((feature_type, feature_parts))

    def normalize_tx_biotype(raw_biotype, feature_type, has_cds):
        value = str(raw_biotype or "").strip()
        lowered = value.lower()
        generic_values = {"", "gene", "mrna", "transcript", "rna", "cds"}
        if has_cds and (lowered in generic_values or feature_type == "mRNA"):
            return "protein_coding"
        return value

    def is_protein_coding_biotype(raw_biotype):
        lowered = str(raw_biotype or "").strip().lower().replace(" ", "_")
        if "cds_not_defined" in lowered:
            return False
        return lowered == "protein_coding" or lowered.startswith("protein_coding")

    def transcript_raw_biotype(parts):
        raw_attrs = parts[8]
        for attr_name in ('biotype', 'gene_biotype', 'gbkey', 'ncrna_class'):
            pattern = rf'{attr_name}=([^;]+)'
            m = re.search(pattern, raw_attrs)
            if m:
                return m.group(1)
        return ""

    def synthesize_cds_from_transcript(exons, parts, strand):
        source = exons if exons else [{
            'feature_type': 'exon',
            'start': int(parts[3]),
            'end': int(parts[4]),
            'strand': strand,
        }]
        return [
            {
                'feature_type': 'CDS',
                'start': int(item['start']),
                'end': int(item['end']),
                'strand': str(item.get('strand') or strand),
            }
            for item in source
        ]

    # An index build runs for minutes on a large annotation, on a worker thread
    # inside the API process. Without this it starves the event loop for its
    # whole duration and the rest of the app looks hung — the very thing moving
    # the build off the request path was meant to avoid.
    yielder = CooperativeYielder()

    try:
        total_bytes = os.path.getsize(gff_path)
    except OSError:
        total_bytes = 0

    with file_io.open_maybe_gz(gff_path, 'r') as f:
        position_source = _read_position_source(f)
        lines_until_report = INDEX_PROGRESS_LINE_INTERVAL
        report("parsing", 0, total_bytes)
        for line in f:
            yielder.tick()
            lines_until_report -= 1
            if lines_until_report <= 0:
                lines_until_report = INDEX_PROGRESS_LINE_INTERVAL
                position = 0
                if position_source is not None:
                    try:
                        position = position_source.tell()
                    except Exception:
                        position_source = None
                report("parsing", position, total_bytes)
            if line.startswith('#'): continue
            parts = line.strip().split('\t')
            if len(parts) < 9: continue

            ftype = parts[2]
            # Skip features that can never be gene-/transcript-/exon-level to avoid
            # parsing their (often long) attribute strings unnecessarily.
            if ftype not in gene_feature_types and ftype not in feature_types and ftype not in child_feature_types:
                # Might still be a transcript-level feature with a gene parent (RefSeq
                # uses non-standard feature types).  Only skip if the ID column does NOT
                # start with 'gene-' / 'rna-', which would indicate a real gene/RNA entry.
                id_col = parts[8]
                if 'ID=gene-' not in id_col and 'ID=rna-' not in id_col and 'Parent=gene-' not in id_col and 'Parent=gene:' not in id_col:
                    continue
            attrs_str = parts[8]
            attrs = parse_attrs(attrs_str)
            raw_id = attrs.get('ID', '')
            parent_attr = attrs.get('Parent', '')
            # ID prefix normalisation: Ensembl uses 'gene:' / 'transcript:' (colon),
            # RefSeq uses 'gene-' / 'rna-' (hyphen).  Strip both forms so IDs are clean.
            has_gene_id = raw_id.startswith('gene:') or raw_id.startswith('gene-')
            is_gene_level = (ftype in gene_feature_types) or (has_gene_id and not parent_attr)

            # 1. Gene
            if is_gene_level:
                g_id = re.sub(r'^gene[:\-]', '', raw_id)
                if not g_id:
                    g_id = attrs.get('gene_id', '')
                if not g_id:
                    continue
                g_name = attrs.get('Name') or attrs.get('gene_name') or attrs.get('gene') or attrs.get('locus_tag') or g_id
                g_biotype = attrs.get('biotype') or attrs.get('gene_biotype') or attrs.get('gbkey', '')
                g_description = unquote(str(
                    attrs.get('description')
                    or attrs.get('gene_description')
                    or attrs.get('product')
                    or ''
                )).strip()
                g_version = attrs.get('version', '')
                genes_batch.append((
                    g_id, parts[0], int(parts[3]), int(parts[4]), parts[6], g_name, g_biotype, g_description, g_version
                ))
                gene_coords_map[g_id] = (parts[0], int(parts[3]), int(parts[4]), parts[6], g_biotype)
                gene_child_features.setdefault(g_id, new_child_bucket())
                count_genes += 1

                if len(genes_batch) > 1000:
                    c.executemany(
                        'INSERT OR IGNORE INTO genes (id, chrom, start, end, strand, name, biotype, description, version) VALUES (?,?,?,?,?,?,?,?,?)',
                        genes_batch
                    )
                    genes_batch = []

            # 2. Transcript-level features
            is_parent_gene_feature = parent_attr.startswith('gene:') or parent_attr.startswith('gene-')
            is_transcript_level = (
                ftype in feature_types
                or (is_parent_gene_feature and ftype not in child_feature_types and bool(raw_id))
            )
            if is_transcript_level:
                # Strip Ensembl ('transcript:'/'mapped_transcript:') and RefSeq ('rna-') ID prefixes.
                t_id = re.sub(r'^(?:transcript|mapped_transcript|rna)[:\-]', '', raw_id)
                if not t_id:
                     t_id = attrs.get('transcript_id', '')
                if not t_id:
                    continue

                p_id = re.sub(r'^gene[:\-]', '', parent_attr.split(',')[0])
                if not p_id: p_id = t_id
                
                # Check for Ensembl_canonical tag
                tags = attrs.get('tag', '')
                is_canonical = any(
                    token in tags
                    for token in ('Ensembl_canonical', 'RefSeq Select', 'MANE Select', 'MANE Plus Clinical')
                )
                tag_list = [t.strip() for t in str(tags).split(',') if t.strip()]
                
                previously_attached = transcripts_data.get(t_id, new_child_bucket())
                pending_children = pending_transcript_child_features.pop(t_id, new_child_bucket())
                pending_explicit_transcript_parents.discard(t_id)
                transcripts_data[t_id] = {
                    'parts': parts,
                    'parent': p_id,
                    'exons': [*previously_attached.get('exons', []), *pending_children['exons']],
                    'cds': [*previously_attached.get('cds', []), *pending_children['cds']],
                    'utrs': [*previously_attached.get('utrs', []), *pending_children['utrs']],
                    'is_canonical': is_canonical,
                    'tags': tag_list,
                    'version': attrs.get('version', ''),
                }
                
            # 3. Child features (Exon, CDS, UTR)
            elif ftype in child_feature_types:
                parent_str = parent_attr
                parent_ids = [p.strip() for p in parent_str.split(',') if p.strip()]
                for raw_parent in parent_ids:
                    is_explicit_transcript_parent = bool(
                        re.match(r'^(?:transcript|mapped_transcript|rna)[:\-]', raw_parent)
                    )
                    is_explicit_gene_parent = bool(re.match(r'^gene[:\-]', raw_parent))
                    parent = re.sub(r'^(?:transcript|mapped_transcript|rna)[:\-]', '', raw_parent)
                    if not parent:
                        continue

                    if is_explicit_gene_parent:
                        gene_parent = re.sub(r'^gene[:\-]', '', raw_parent)
                        append_child(
                            gene_child_features.setdefault(gene_parent, new_child_bucket()),
                            ftype,
                            parts,
                        )
                        continue

                    if parent in transcripts_data:
                        append_child(transcripts_data[parent], ftype, parts)
                    elif not is_explicit_transcript_parent and parent in gene_coords_map:
                        append_child(
                            gene_child_features.setdefault(parent, new_child_bucket()),
                            ftype,
                            parts,
                        )
                    else:
                        append_child(
                            pending_transcript_child_features.setdefault(parent, new_child_bucket()),
                            ftype,
                            parts,
                        )
                        if is_explicit_transcript_parent:
                            pending_explicit_transcript_parents.add(parent)

    # Resolve unprefixed child parents that turned out to be genes declared later
    # in the file. Explicit transcript parents with a missing transcript remain
    # unattached rather than contaminating an unrelated gene with the same ID.
    for parent, bucket in list(pending_transcript_child_features.items()):
        if (
            parent not in pending_explicit_transcript_parents
            and parent not in transcripts_data
            and parent in gene_coords_map
        ):
            gene_bucket = gene_child_features.setdefault(parent, new_child_bucket())
            gene_bucket['exons'].extend(bucket['exons'])
            gene_bucket['cds'].extend(bucket['cds'])
            gene_bucket['utrs'].extend(bucket['utrs'])

    # Commit remaining genes
    if genes_batch:
        c.executemany(
            'INSERT OR IGNORE INTO genes (id, chrom, start, end, strand, name, biotype, description, version) VALUES (?,?,?,?,?,?,?,?,?)',
            genes_batch
        )
    
    # Process and insert transcripts
    report("writing", total_bytes, total_bytes)
    tx_batch = []
    
    for t_id, data in transcripts_data.items():
        yielder.tick()
        parts = data['parts']
        parent_gene = gene_coords_map.get(data['parent'])
        parent_gene_biotype = parent_gene[4] if parent_gene else ""
        gene_bucket = gene_child_features.get(data['parent'], new_child_bucket())
        raw_biotype = transcript_raw_biotype(parts)
        effective_raw_biotype = raw_biotype or parent_gene_biotype
        should_inherit_gene_cds = (
            parts[2] == 'mRNA'
            or is_protein_coding_biotype(effective_raw_biotype)
        )
        
        # Build SimpleTranscript object (reusing logic from find_transcript_fast)
        # Exons
        exons = []
        for ep in data['exons']:
            exons.append({'feature_type': 'exon', 'start': int(ep[3]), 'end': int(ep[4]), 'strand': ep[6]})
        if not exons:
            for ep in gene_bucket.get('exons', []):
                exons.append({'feature_type': 'exon', 'start': int(ep[3]), 'end': int(ep[4]), 'strand': ep[6]})
        exons.sort(key=lambda x: x['start'])
        
        # CDS
        cds_list = []
        for cp in data['cds']:
            phase_raw = str(cp[7]).strip() if len(cp) > 7 else "."
            phase_value = int(phase_raw) if phase_raw in {"0", "1", "2"} else None
            cds_item = {'feature_type': 'CDS', 'start': int(cp[3]), 'end': int(cp[4]), 'strand': cp[6]}
            if phase_value is not None:
                cds_item['phase'] = phase_value
            cds_list.append(cds_item)
        if not cds_list and should_inherit_gene_cds:
            for cp in gene_bucket.get('cds', []):
                phase_raw = str(cp[7]).strip() if len(cp) > 7 else "."
                phase_value = int(phase_raw) if phase_raw in {"0", "1", "2"} else None
                cds_item = {'feature_type': 'CDS', 'start': int(cp[3]), 'end': int(cp[4]), 'strand': cp[6]}
                if phase_value is not None:
                    cds_item['phase'] = phase_value
                cds_list.append(cds_item)
        cds_list.sort(key=lambda x: x['start'])
        
        # UTRs
        utrs = []
        for ut, up in data['utrs']:
            utrs.append({'feature_type': ut, 'start': int(up[3]), 'end': int(up[4]), 'strand': up[6]})
        if not utrs:
            for ut, up in gene_bucket.get('utrs', []):
                utrs.append({'feature_type': ut, 'start': int(up[3]), 'end': int(up[4]), 'strand': up[6]})
            
        # Biotype
        biotype = raw_biotype

        if not exons:
            # A real transcript with no explicit exon should never inherit the
            # whole gene span: that can extend beyond this isoform and renders a
            # false terminal exon. Its own feature bounds are the safe fallback.
            exons = [{
                'feature_type': 'exon',
                'start': int(parts[3]),
                'end': int(parts[4]),
                'strand': parts[6],
            }]

        if not cds_list and should_inherit_gene_cds:
            cds_list = synthesize_cds_from_transcript(exons, parts, parts[6])

        biotype = normalize_tx_biotype(effective_raw_biotype, parts[2], bool(cds_list))

        # Check canonical flag
        is_canonical = 1 if data.get('is_canonical', False) else 0
        
        # Construct JSON-serializable dict
        tx_obj = {
            'feature_id': t_id,
            'seq_region': parts[0],
            'start': int(parts[3]),
            'end': int(parts[4]),
            'strand': parts[6],
            'exons': exons,
            'cds_list': cds_list,
            'utrs': utrs,
            'biotype': biotype,
            'is_canonical': bool(is_canonical),
            'tags': data.get('tags', []),
            'version': data.get('version', ''),
        }
        
        tx_batch.append((
            t_id, parts[0], int(parts[3]), int(parts[4]), parts[6], data['parent'], json.dumps(tx_obj), is_canonical
        ))
        
        if len(tx_batch) > 500:
             c.executemany('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)', tx_batch)
             tx_batch = []
             
    if tx_batch:
        c.executemany('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)', tx_batch)

    # For genes that have no transcript children in the GFF3 (e.g. processed pseudogenes
    # or other single-feature entries), synthesise one transcript spanning the gene so the
    # genome browser and feature explorer always have something to render.
    genes_with_transcripts = {data['parent'] for data in transcripts_data.values()}
    synthetic_batch = []
    for g_id, (chrom, g_start, g_end, strand, biotype) in gene_coords_map.items():
        yielder.tick()
        if g_id in genes_with_transcripts:
            continue
        bucket = gene_child_features.get(g_id, new_child_bucket())
        exons = [
            {'feature_type': 'exon', 'start': int(ep[3]), 'end': int(ep[4]), 'strand': ep[6]}
            for ep in bucket.get('exons', [])
        ]
        exons.sort(key=lambda x: x['start'])
        if not exons:
            exons = [{'feature_type': 'exon', 'start': g_start, 'end': g_end, 'strand': strand}]

        cds_list = []
        for cp in bucket.get('cds', []):
            phase_raw = str(cp[7]).strip() if len(cp) > 7 else "."
            phase_value = int(phase_raw) if phase_raw in {"0", "1", "2"} else None
            cds_item = {'feature_type': 'CDS', 'start': int(cp[3]), 'end': int(cp[4]), 'strand': cp[6]}
            if phase_value is not None:
                cds_item['phase'] = phase_value
            cds_list.append(cds_item)
        cds_list.sort(key=lambda x: x['start'])
        if not cds_list and is_protein_coding_biotype(biotype):
            cds_list = [{
                'feature_type': 'CDS',
                'start': g_start,
                'end': g_end,
                'strand': strand,
            }]

        utrs = [
            {'feature_type': ut, 'start': int(up[3]), 'end': int(up[4]), 'strand': up[6]}
            for ut, up in bucket.get('utrs', [])
        ]

        syn_biotype = normalize_tx_biotype(biotype, 'transcript', bool(cds_list))
        syn_id = g_id
        syn_obj = {
            'feature_id': syn_id,
            'seq_region': chrom,
            'start': g_start,
            'end': g_end,
            'strand': strand,
            'exons': exons,
            'cds_list': cds_list,
            'utrs': utrs,
            'biotype': syn_biotype,
            'is_canonical': True,
            'tags': [],
            'version': '',
        }
        synthetic_batch.append((syn_id, chrom, g_start, g_end, strand, g_id, json.dumps(syn_obj), 1))
        if len(synthetic_batch) >= 500:
            c.executemany('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)', synthetic_batch)
            synthetic_batch = []
    if synthetic_batch:
        c.executemany('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)', synthetic_batch)

    # Sanity check for immune receptor loci, which often use unusual transcript feature types.
    try:
        c.execute("SELECT COUNT(*) FROM genes WHERE biotype LIKE 'IG_%' OR biotype LIKE 'TR_%'")
        igtr_gene_count = int(c.fetchone()[0] or 0)
        c.execute("""
            SELECT COUNT(*)
            FROM transcripts t
            JOIN genes g ON g.id = t.parent_gene_id
            WHERE g.biotype LIKE 'IG_%' OR g.biotype LIKE 'TR_%'
        """)
        igtr_tx_count = int(c.fetchone()[0] or 0)
        if igtr_gene_count > 0 and igtr_tx_count == 0:
            file_io.log_progress("  ! IG/TR sanity check: genes detected but no linked transcripts were indexed")
        else:
            file_io.log_progress(f"  ✓ IG/TR sanity check: {igtr_gene_count} genes, {igtr_tx_count} transcripts")
    except Exception as e:
        file_io.log_progress(f"  ! IG/TR sanity check skipped: {e}")

    conn.commit()
    conn.close()
    file_io.log_progress(f"  ✓ Indexing complete: {count_genes} genes, {len(transcripts_data)} transcripts")


def _resolve_index_path(gff_path: str, output_dir: str, fallback_name: str) -> Path:
    """Determine where to store a GFF3 index.

    If the GFF3 file lives inside the local_data directory tree
    (for example ``output_dir/local_data/<species>/<assembly>/`` or
    ``output_dir/local_data/ncbi/<species>/<assembly>/``), the index is placed
    alongside it as ``<assembly>.gff3.index.db``.

    Otherwise the index is kept next to the annotation it was built from, which
    is where users look for it and keeps a custom genome self-contained. Only
    when that directory cannot be written to does it fall back to a managed
    ``output_dir/indexes/`` folder — never to the bare output directory root,
    where index files for unrelated genomes used to accumulate.
    """
    gff = Path(gff_path).resolve()
    local_root = Path(output_dir).resolve() / "local_data"
    try:
        rel = gff.relative_to(local_root)
        provider, species_key, assembly = parse_local_data_relative_parts(rel.parts)
        if species_key and assembly:
            return gff.parent / f"{assembly}.gff3.index.db"
    except ValueError:
        pass  # gff_path is not under local_data

    if os.access(str(gff.parent), os.W_OK):
        return gff.parent / fallback_name

    managed = Path(output_dir) / "indexes"
    try:
        managed.mkdir(parents=True, exist_ok=True)
    except OSError:
        return Path(output_dir) / fallback_name
    return managed / fallback_name


def _index_basename_for_annotation(gff_path: str) -> str:
    """`braker.gtf.gz` -> `braker.gff3.index.db`."""
    return f"{annotation_name_stem(Path(gff_path).name)}.gff3.index.db"


def _update_index_task(task_id: str, **updates: Any) -> None:
    with _index_tasks_guard:
        task = _index_tasks.get(task_id)
        if task is not None:
            task.update(updates)


def _index_worker_loop() -> None:
    while True:
        task_id, gff_path_str, target_index_str = _index_task_queue.get()
        try:
            _update_index_task(task_id, status="running", started_at=now_iso(), error=None)

            def on_progress(progress: Dict[str, Any], _task_id: str = task_id) -> None:
                _update_index_task(_task_id, progress=progress)

            db_path = ensure_gff_index(
                gff_path_str,
                target_index_str,
                force_rebuild=False,
                progress_cb=on_progress,
            )
            _update_index_task(task_id, status="success", index_path=db_path, completed_at=now_iso(), error=None)
        except Exception as exc:
            logger.error(f"Index generation failed for {gff_path_str}: {exc}")
            _update_index_task(task_id, status="failed", error=str(exc), completed_at=now_iso())
        finally:
            _prune_finished_index_tasks()
            _index_task_queue.task_done()


def _ensure_index_worker_started() -> None:
    global _index_worker_started
    with _index_worker_guard:
        if _index_worker_started:
            return
        worker = threading.Thread(target=_index_worker_loop, name="gff-index-worker", daemon=True)
        worker.start()
        _index_worker_started = True


#: Finished index tasks kept in the registry. They are the only record of why a
#: build failed, so a handful are retained, but the registry is process-lifetime
#: state and used to grow without limit.
MAX_FINISHED_INDEX_TASKS = 40


def _prune_finished_index_tasks() -> None:
    """Drop the oldest finished tasks once the registry has more than it needs."""
    with _index_tasks_guard:
        finished = [
            (str(task.get("completed_at") or ""), task_id)
            for task_id, task in _index_tasks.items()
            if task.get("status") in {"success", "failed"}
        ]
        if len(finished) <= MAX_FINISHED_INDEX_TASKS:
            return
        finished.sort()
        for _, task_id in finished[:len(finished) - MAX_FINISHED_INDEX_TASKS]:
            _index_tasks.pop(task_id, None)


def _annotation_signature(gff_path: str) -> str:
    """``mtime:size`` for an annotation, or ``""`` when it cannot be read.

    Recorded against a build so a failure can be tied to the exact file that
    produced it. Replace or repair the annotation and the signature moves on,
    which is what lets a genome recover from a bad download without a restart.
    """
    try:
        stat = os.stat(_normalize_fs_path(gff_path))
    except OSError:
        return ""
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def forget_index_failures(gff_path: str, db_path: str = "") -> int:
    """Discard remembered failures for an annotation. Returns how many went.

    Without this a single failed build wedges the genome for the lifetime of the
    process: :func:`_index_build_error_for` keeps finding the failed task, so
    browsing keeps reporting the old error and never queues another attempt.
    """
    normalized_gff = _normalize_fs_path(gff_path)
    normalized_db = _normalize_fs_path(db_path) if db_path else ""
    with _index_tasks_guard:
        doomed = [
            task_id
            for task_id, task in _index_tasks.items()
            if task.get("status") == "failed"
            and (
                task.get("gff_path") == normalized_gff
                or (normalized_db and task.get("db_path") == normalized_db)
            )
        ]
        for task_id in doomed:
            _index_tasks.pop(task_id, None)
    return len(doomed)


def _queued_index_positions() -> Dict[str, int]:
    """Task id -> its place in the queue, 1 for the build that is running.

    Indexing is deliberately serial — two multi-gigabyte parses at once starve
    everything else in the process — so a genome can sit untouched for minutes
    behind another one. Telling the browser where it is in the line is the
    difference between "queued behind Mus musculus" and an unexplained wait.
    """
    with _index_tasks_guard:
        running = [tid for tid, task in _index_tasks.items() if task.get("status") == "running"]
        queued = sorted(
            (
                (str(task.get("queued_at") or ""), tid)
                for tid, task in _index_tasks.items()
                if task.get("status") == "queued"
            )
        )
    positions = {tid: 1 for tid in running}
    offset = len(running) + 1
    for index, (_, tid) in enumerate(queued):
        positions[tid] = offset + index
    return positions


def queue_index_build(gff_path: str, db_path: str) -> Tuple[str, str]:
    """Hand a GFF3 index build to the background worker, reusing a live task.

    Returns ``(task_id, status)``. This is deliberately cheap and never waits for
    the build: it is called from request handlers that must answer immediately,
    including the browse endpoints, which report "not ready yet" rather than
    holding a connection open for the minutes a large annotation takes.

    A build already running for the same annotation is reused even when it is
    writing to a differently named index file. The selector and the browse path
    do not always name the target identically, and parsing a multi-gigabyte GFF3
    twice at once to produce two equivalent indexes helps nobody.
    """
    normalized_target = _normalize_fs_path(db_path)
    normalized_gff = _normalize_fs_path(gff_path)
    with _index_tasks_guard:
        for tid, task in _index_tasks.items():
            if task.get("status") not in {"queued", "running"}:
                continue
            if task.get("db_path") == normalized_target or task.get("gff_path") == normalized_gff:
                return tid, str(task.get("status") or "queued")

        task_id = str(uuid.uuid4())
        _index_tasks[task_id] = {
            "status": "queued",
            "db_path": normalized_target,
            "gff_path": normalized_gff,
            "gff_signature": _annotation_signature(normalized_gff),
            "index_path": None,
            "error": None,
            "progress": None,
            "queued_at": now_iso(),
        }

    _ensure_index_worker_started()
    _index_task_queue.put((task_id, str(gff_path), str(db_path)))
    return task_id, "queued"

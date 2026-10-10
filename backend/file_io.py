"""Reading genome files: gzip/bgzip-aware opening, FASTA indexing, and a FASTA
handle that is safe to share between the threadpool's request threads.
"""

import gzip
import logging
import os
import threading
from pathlib import Path
from typing import IO

import pysam

logger = logging.getLogger(__name__)


def log_progress(msg: str):
    """Print progress message with flush for immediate output."""
    print(f"[PROGRESS] {msg}", flush=True)


def open_maybe_gz(filepath, mode: str = 'r') -> IO:
    """Open a str or Path, using gzip for .gz/.bgz and UTF-8 in text mode."""
    filepath = str(filepath)
    is_text = 'b' not in mode
    if filepath.endswith(('.gz', '.bgz')):
        gz_mode = mode if ('t' in mode or 'b' in mode) else mode + 't'
        return gzip.open(filepath, gz_mode, encoding='utf-8' if is_text else None)
    return open(filepath, mode, encoding='utf-8' if is_text else None)


def _is_bgzipped(filepath: str) -> bool:
    """Check if a file is bgzip-compressed (not plain gzip)."""
    try:
        with open(filepath, 'rb') as f:
            header = f.read(4)
            # bgzip files start with the gzip magic bytes 1f 8b,
            # followed by 08 (deflate) and 04 (FEXTRA flag set)
            return header[:4] == b'\x1f\x8b\x08\x04'
    except Exception:
        return False


def ensure_fasta_index(fasta_path: str, force_reindex: bool = False) -> str:
    """Ensure a FASTA file is indexed for pysam access.

    Handles plain FASTA, bgzipped (.fa.gz), and regular gzipped (.fa.gz) files.
    Regular gzip files are decompressed to plain FASTA since pysam requires
    either plain or bgzip format.
    Returns the path to use with pysam.FastaFile().
    """
    # If the file is gzipped but NOT bgzipped, decompress it first
    if fasta_path.endswith('.gz') and not _is_bgzipped(fasta_path):
        plain_path = fasta_path[:-3]  # Remove .gz extension
        if not os.path.exists(plain_path):
            log_progress(f"Decompressing {Path(fasta_path).name} (gzip → plain FASTA for indexing)...")
            try:
                with gzip.open(fasta_path, 'rb') as gz_in, open(plain_path, 'wb') as f_out:
                    while True:
                        chunk = gz_in.read(1024 * 1024 * 16)  # 16MB chunks
                        if not chunk:
                            break
                        f_out.write(chunk)
                log_progress(f"  ✓ Decompressed to {Path(plain_path).name}")
            except Exception as e:
                # Clean up partial file on failure
                if os.path.exists(plain_path):
                    os.remove(plain_path)
                logger.error(f"Failed to decompress FASTA {fasta_path}: {e}")
                raise
        fasta_path = plain_path

    fai_path = fasta_path + '.fai'
    if force_reindex and os.path.exists(fai_path):
        try:
            os.remove(fai_path)
        except Exception:
            pass
    if not os.path.exists(fai_path):
        log_progress(f"Creating FASTA index for {Path(fasta_path).name}...")
        try:
            pysam.faidx(fasta_path)
            log_progress("  ✓ FASTA index created")
        except Exception as e:
            logger.error(f"Failed to index FASTA {fasta_path}: {e}")
            raise
    return fasta_path


class ThreadSafeFasta:
    """Serialise access to a shared ``pysam.FastaFile``.

    htslib stores mutable seek and decompression state on each handle; concurrent
    reads can fail or return wrong bases. A lock lets request threads safely
    share one cached handle without duplicating large FASTA indexes per thread.
    """

    __slots__ = ("_fasta", "_lock")

    def __init__(self, fasta):
        self._fasta = fasta
        self._lock = threading.Lock()

    def fetch(self, *args, **kwargs):
        with self._lock:
            return self._fasta.fetch(*args, **kwargs)

    def get_reference_length(self, *args, **kwargs):
        with self._lock:
            return self._fasta.get_reference_length(*args, **kwargs)

    @property
    def references(self):
        with self._lock:
            return self._fasta.references

    @property
    def lengths(self):
        with self._lock:
            return self._fasta.lengths

    def close(self):
        with self._lock:
            self._fasta.close()

    def __getattr__(self, name):
        # Anything not wrapped explicitly still reads under the lock.
        with self._lock:
            return getattr(self._fasta, name)


def open_indexed_fasta(fasta_path: str, force_reindex: bool = False) -> ThreadSafeFasta:
    """Index a FASTA if needed and open it for safe concurrent reads."""
    indexed_path = ensure_fasta_index(fasta_path, force_reindex=force_reindex)
    return ThreadSafeFasta(pysam.FastaFile(indexed_path))

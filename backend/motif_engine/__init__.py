"""Portable motif search, atomic sequence caching and multiresolution colour masks.

Callers provide immutable sequence keys and text loaders. No alignment, genome,
HTTP, React or colour-hex dependencies belong in this package.
"""
from .engine import MotifCache, SearchCancelled, search_spans, pattern_key, composition_key

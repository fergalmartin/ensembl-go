"""Disk-backed, bidirectional gene search over original homology TSV rows.

The index is disposable. Searches resolve only directly linked local query genes;
they never reverse percentages or infer a transitive gene family.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import math
import os
import sqlite3
import tempfile
import threading
from contextlib import closing
from pathlib import Path

SCHEMA_VERSION = 1
_BUILD_LOCK = threading.Lock()
FIELDS = ("query_gene_stable_id", "query_gene_name", "ref_gene_stable_id", "ref_gene_name")


def species_key(value):
    return "_".join(str(value or "").strip().lower().split())


def assembly_key(value):
    value = str(value or "").strip().lower()
    return "grch38" if value in ("grch38", "grch38.p14") else value


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def row_rank(row):
    kind = str(row.get("homology_type") or "").lower()
    tier = 2 if kind == "homolog_rbbh" else 1 if kind == "homolog_bbh" else 0
    identity, coverage = number(row.get("query_perc_id")), number(row.get("query_perc_cov"))
    score = .6 * identity + .4 * coverage if identity is not None and coverage is not None else (
        identity if identity is not None else coverage if coverage is not None else -1
    )
    return tier, round(score, 10)


def target_identity(row, source_token, row_id):
    species = species_key(row.get("ref_species"))
    assembly = assembly_key(row.get("ref_assembly"))
    gene = str(row.get("ref_gene_stable_id") or "").strip().lower()
    # A name is never sufficient to establish that two rows refer to the same gene.
    key = json.dumps([species, assembly, gene], separators=(",", ":")) if all((species, assembly, gene)) else (
        f"incomplete:{source_token}:{row_id}"
    )
    return key, json.dumps([species, assembly], separators=(",", ":"))


def passes_filters(row, filters, target):
    for field, threshold in (("query_perc_id", filters.get("min_identity")),
                             ("query_perc_cov", filters.get("min_coverage"))):
        if threshold is not None:
            value = number(row.get(field))
            if value is None or value < threshold:
                return False
    types = filters.get("types")
    if types is not None and str(row.get("homology_type") or "") not in types:
        return False
    targets = filters.get("target_assemblies")
    return targets is None or target in targets


class HomologySearchStore:
    def __init__(self, cache_dir):
        self.cache_dir = Path(cache_dir).expanduser().resolve()

    @staticmethod
    def fingerprint(path):
        stat = path.stat()
        return [SCHEMA_VERSION, stat.st_mtime_ns, stat.st_size]

    def _index_path(self, path):
        digest = hashlib.sha256(str(path).encode()).hexdigest()
        return self.cache_dir / f"{digest}.sqlite"

    @staticmethod
    def _metadata(db_path):
        try:
            with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
                return json.loads(db.execute("SELECT value FROM metadata").fetchone()[0])
        except (sqlite3.Error, ValueError, TypeError, IndexError):
            return None

    def ensure_index(self, path):
        path = Path(path).resolve()
        db_path = self._index_path(path)
        fingerprint = self.fingerprint(path)
        meta = self._metadata(db_path)
        if isinstance(meta, dict) and meta.get("fingerprint") == fingerprint:
            return db_path, meta
        # One cold build at a time, including requests for different genome files.
        with _BUILD_LOCK:
            for _attempt in range(2):
                fingerprint = self.fingerprint(path)
                meta = self._metadata(db_path)
                if isinstance(meta, dict) and meta.get("fingerprint") == fingerprint:
                    return db_path, meta
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                fd, temp_name = tempfile.mkstemp(dir=self.cache_dir, suffix=".sqlite")
                os.close(fd)
                temp_path = Path(temp_name)
                try:
                    meta = self._build(path, temp_path, fingerprint)
                    if self.fingerprint(path) != fingerprint:
                        continue
                    os.replace(temp_path, db_path)
                    return db_path, meta
                finally:
                    temp_path.unlink(missing_ok=True)
        raise ValueError("Homology file changed during indexing. Retry the search.")

    def _build(self, path, db_path, fingerprint):
        opener = gzip.open if path.name.lower().endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8-sig", newline="") as handle, closing(sqlite3.connect(db_path)) as db:
            reader = csv.DictReader(handle, delimiter="\t")
            columns = reader.fieldnames or []
            canonical = {column.lower(): column for column in columns}
            if not {"query_gene_stable_id", "ref_gene_stable_id"}.issubset(canonical):
                raise ValueError("Unsupported homology TSV: a header with query_gene_stable_id and ref_gene_stable_id is required.")
            if len(columns) != len(canonical):
                raise ValueError("Unsupported homology TSV: duplicate column names.")
            db.executescript("""
                CREATE TABLE metadata (value TEXT NOT NULL);
                CREATE TABLE rows (row_id INTEGER PRIMARY KEY, query_id TEXT, query_name TEXT,
                                   ref_id TEXT, ref_name TEXT, payload TEXT NOT NULL);
            """)
            batch = []
            for row_id, raw in enumerate(reader):
                row = {column: str(raw.get(column) or "").strip() for column in columns}
                values = [row.get(canonical.get(field, ""), "").lower() for field in FIELDS]
                batch.append((row_id, *values, json.dumps(row, separators=(",", ":"))))
                if len(batch) >= 2000:
                    db.executemany("INSERT INTO rows VALUES (?,?,?,?,?,?)", batch)
                    batch.clear()
            db.executemany("INSERT INTO rows VALUES (?,?,?,?,?,?)", batch)
            for field in ("query_id", "query_name", "ref_id", "ref_name"):
                db.execute(f"CREATE INDEX idx_{field} ON rows ({field})")
            meta = {"fingerprint": fingerprint, "columns": columns, "canonical": canonical,
                    "source_token": hashlib.sha256((str(path) + str(fingerprint)).encode()).hexdigest()}
            db.execute("INSERT INTO metadata VALUES (?)", (json.dumps(meta),))
            db.commit()
            return meta

    def search(self, path, query, *, filters=None, offset=0, limit=100,
               query_gene_id="", target_key="", sort_key="score", direction="desc", include_evidence=True,
               focus_query_gene_id="", focus_target_key=""):
        query = str(query or "").strip()
        if not query:
            raise ValueError("Enter a gene symbol or ID.")
        db_path, meta = self.ensure_index(path)
        filters = filters or {}
        canonical = meta["canonical"]

        def normalized(row):
            return {key: row.get(original, "") for key, original in canonical.items()}

        with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
            exact_sql = "query_id=? OR query_name=? OR ref_id=? OR ref_name=?"
            args = (query.lower(),) * 4
            matches = db.execute(f"SELECT row_id,payload FROM rows WHERE {exact_sql}", args)
            matched_by = "exact"
            if db.execute(f"SELECT 1 FROM rows WHERE {exact_sql} LIMIT 1", args).fetchone() is None:
                # instr treats %, _ and other custom-ID characters literally.
                matches = db.execute("SELECT row_id,payload FROM rows WHERE instr(query_id,?)>0 OR "
                                     "instr(query_name,?)>0 OR instr(ref_id,?)>0 OR instr(ref_name,?)>0", args)
                matched_by = "contains"
            genes = {}
            for _row_id, payload in matches:
                row = normalized(json.loads(payload))
                gene_id = row.get("query_gene_stable_id", "")
                if not gene_id:
                    continue
                gene = genes.setdefault(gene_id.lower(), {"id": gene_id, "name": row.get("query_gene_name", ""), "provenance": []})
                if not gene["name"]:
                    gene["name"] = row.get("query_gene_name", "")
                for field in FIELDS:
                    value = row.get(field, "")
                    match = value.lower() == query.lower() if matched_by == "exact" else query.lower() in value.lower()
                    if value and match:
                        origin = {"endpoint": "query" if field.startswith("query_") else "ref", "field": field, "value": value}
                        if origin not in gene["provenance"]:
                            gene["provenance"].append(origin)
            if not genes:
                matched_by = "none"
            # Temporary IDs avoid SQLite parameter-count limits for broad queries.
            db.execute("CREATE TEMP TABLE resolved (id TEXT PRIMARY KEY)")
            db.executemany("INSERT INTO resolved VALUES (?)", [(gene_id,) for gene_id in genes])
            db.execute("CREATE TEMP TABLE filtered (row_id INTEGER PRIMARY KEY, gene TEXT, tier INTEGER, score REAL, numeric_sort REAL, text_sort TEXT, is_focus INTEGER)")
            groups, best_ranks = {}, {}
            filtered_batch = []
            total_rows = 0
            types = set()
            for row_id, payload in db.execute("SELECT row_id,payload FROM rows JOIN resolved ON rows.query_id=resolved.id ORDER BY row_id"):
                original = json.loads(payload)
                row = normalized(original)
                gene_id = row["query_gene_stable_id"]
                target, target_assembly = target_identity(row, meta["source_token"], row_id)
                rank = row_rank(row)
                rank_group = (gene_id.lower(), target_assembly)
                best_ranks[rank_group] = max(best_ranks.get(rank_group, (-1, -1)), rank)
                total_rows += 1
                types.add(row.get("homology_type", ""))
                key = (gene_id.lower(), target)
                group = groups.setdefault(key, {
                    "query_gene_id": gene_id, "target_key": target, "target_assembly_key": target_assembly,
                    "species": row.get("ref_species", ""), "assembly": row.get("ref_assembly", ""),
                    "gene_id": row.get("ref_gene_stable_id", ""), "symbol": row.get("ref_gene_name", ""),
                    "incomplete": target.startswith("incomplete:"), "variants": {}, "row_count": 0,
                })
                variant_key = (row.get("homology_type", ""), number(row.get("query_perc_id")), number(row.get("query_perc_cov")))
                variant = group["variants"].setdefault(variant_key, {
                    "type": variant_key[0], "identity": variant_key[1], "coverage": variant_key[2],
                    "rank": rank, "count": 0,
                })
                variant["count"] += 1
                group["row_count"] += 1
                if passes_filters(row, filters, target_assembly) and (
                    not query_gene_id or gene_id.lower() == query_gene_id.lower()
                ) and (not target_key or target == target_key):
                    numeric_sort = number(row.get(sort_key))
                    filtered_batch.append((row_id, gene_id.lower(), rank[0], rank[1],
                                           numeric_sort if numeric_sort is not None else -1, row.get(sort_key, "").lower(),
                                           int(bool(focus_query_gene_id and focus_target_key) and gene_id.lower() == focus_query_gene_id.lower() and target == focus_target_key)))
                    if len(filtered_batch) >= 2000:
                        db.executemany("INSERT INTO filtered VALUES (?,?,?,?,?,?,?)", filtered_batch)
                        filtered_batch.clear()
            db.executemany("INSERT INTO filtered VALUES (?,?,?,?,?,?,?)", filtered_batch)

            for group in groups.values():
                rank_group = (group["query_gene_id"].lower(), group["target_assembly_key"])
                variants = sorted(group["variants"].values(), key=lambda item: item["rank"], reverse=True)
                for variant in variants:
                    variant["best"] = variant["rank"] == best_ranks[rank_group]
                    variant.pop("rank")
                group["variants"] = variants

            order = "ASC" if direction == "asc" else "DESC"
            sort = f"tier {order},score {order}" if sort_key == "score" else (
                f"numeric_sort {order}" if sort_key in ("query_perc_id", "query_perc_cov") else f"text_sort {order}"
            )
            total_filtered = db.execute("SELECT count(*) FROM filtered").fetchone()[0]
            limit, offset = max(1, min(500, limit)), max(0, offset)
            focus_row_id = None
            if focus_query_gene_id and focus_target_key:
                # Locate evidence within the complete filtered/sorted result set.
                # Navigation selects a page; it never narrows the result table.
                focus = db.execute(
                    f"SELECT row_id,position FROM (SELECT row_id,is_focus,"
                    f"ROW_NUMBER() OVER (ORDER BY gene,{sort},row_id)-1 AS position FROM filtered) "
                    "WHERE is_focus=1 ORDER BY position LIMIT 1"
                ).fetchone()
                if focus:
                    focus_row_id, position = focus
                    offset = position // limit * limit
            page = []
            for row_id, payload in db.execute(
                f"SELECT rows.row_id,rows.payload FROM rows JOIN filtered USING (row_id) ORDER BY gene,{sort},row_id LIMIT ? OFFSET ?",
                (limit, offset),
            ):
                original = json.loads(payload)
                row = normalized(original)
                target, target_assembly = target_identity(row, meta["source_token"], row_id)
                page.append({"row_id": row_id, "values": original, "query_gene_id": row["query_gene_stable_id"],
                             "target_key": target, "best": row_rank(row) == best_ranks[(row["query_gene_stable_id"].lower(), target_assembly)]})
            return {
                "query": query, "source_token": meta["source_token"], "columns": meta["columns"],
                "canonical_columns": canonical, "matched_by": matched_by,
                "resolved_genes": list(genes.values()), "evidence": list(groups.values()) if include_evidence else None,
                "types": sorted(types - {""}), "total_rows": total_rows, "filtered_rows": total_filtered,
                "offset": offset, "limit": limit, "rows": page, "focus_row_id": focus_row_id,
            }

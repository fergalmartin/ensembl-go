from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple


DEFAULT_TAXONOMY_ARTIFACT_PATH = Path(__file__).resolve().parent / "data" / "taxonomy_classification.json"


@dataclass(frozen=True)
class ClassificationResult:
    group: str
    sub_group: Optional[str] = None
    source: str = "unknown"
    taxid: int = 0
    resolved_taxid: int = 0
    missing_taxids: Tuple[int, ...] = ()


FallbackClassifier = Callable[[str, str, int, int], Tuple[str, Optional[str]]]


# NCBI taxonomy anchors used by the download view's public categories.
# The rule order matters: specific clades must be checked before broad clades.
TAXONOMY_ANCHOR_RULES: Tuple[Tuple[Tuple[int, ...], Tuple[str, Optional[str]]], ...] = (
    # Mammal subgroups
    ((9443,), ("Mammals", "Primates")),        # Primates
    ((9989,), ("Mammals", "Rodents")),         # Rodentia
    ((9397,), ("Mammals", "Bats")),            # Chiroptera
    ((9362,), ("Mammals", "True insectivores")), # Eulipotyphla
    ((9263,), ("Mammals", "Marsupials")),      # Marsupialia
    ((33554,), ("Mammals", "Carnivores")),     # Carnivora
    ((91561,), ("Mammals", "Even-toed ungulates & whales")), # Artiodactyla
    ((9787,), ("Mammals", "Odd-toed ungulates")), # Perissodactyla
    ((9975,), ("Mammals", "Rabbits & hares")), # Lagomorpha
    ((9255, 9254), ("Mammals", "Monotremes")), # Monotremata/Prototheria
    ((311790,), ("Mammals", "Afrotheria")),    # Afrotheria
    ((9348,), ("Mammals", "Xenarthra")),       # Xenarthra
    ((9971,), ("Mammals", "Pangolins")),       # Pholidota

    # Insect subgroups
    ((7088,), ("Insects", "Moths")),           # Lepidoptera
    ((7147,), ("Insects", "Flies")),           # Diptera
    ((7041,), ("Insects", "Beetles")),         # Coleoptera
    ((7399,), ("Insects", "Bees & Wasps")),    # Hymenoptera

    # Plant subgroups
    ((4479,), ("Plants", "Cereals")),          # Poaceae

    # Microbes
    ((2,), ("Microbes", "Bacteria")),          # Bacteria
    ((2157,), ("Microbes", "Archaea")),        # Archaea
    ((4751,), ("Microbes", "Fungi & Yeasts")), # Fungi
    (
        (
            33630,   # Alveolata
            33634,   # Stramenopiles
            554915,  # Amoebozoa
            33682,   # Euglenozoa
            207245,  # Fornicata
            5752,    # Heterolobosea
            543769,  # Rhizaria
            33083,   # Choanoflagellata
            28009,   # Apicomplexa
            2763,    # Rhodophyta
            2830,    # Haptophyta
            192874,  # Capsasporidae
        ),
        ("Microbes", "Protists"),
    ),

    # Vertebrates and plants
    ((40674,), ("Mammals", "Other Mammals")),  # Mammalia
    (
        (
            7898,    # Actinopterygii
            7777,    # Chondrichthyes
            7762,    # Myxini
            118072,  # Coelacanthimorpha
            7878,    # Dipnoi
        ),
        ("Fish", None),
    ),
    ((8782,), ("Birds", None)),                 # Aves
    ((1294634, 8504), ("Reptiles", None)),      # Reptilia/Squamata
    ((8292,), ("Amphibians", None)),            # Amphibia
    ((7742,), ("Fish", None)),                  # Vertebrata fallback, after tetrapods
    ((33090,), ("Plants", "Other Plants")),    # Viridiplantae

    # Non-insect invertebrates
    ((6231, 6157, 6340), ("Other Invertebrates", "Worms")),  # Nematoda/flatworms/annelids
    ((6447,), ("Other Invertebrates", "Molluscs")),          # Mollusca
    ((6073,), ("Other Invertebrates", "Corals & Jellyfish")),# Cnidaria
    ((6657,), ("Other Invertebrates", "Crustaceans")),       # Crustacea
    ((6854,), ("Other Invertebrates", "Arachnids")),         # Arachnida
    ((7586,), ("Other Invertebrates", "Echinoderms")),       # Echinodermata
    ((6040,), ("Other Invertebrates", "Sponges")),           # Porifera
    ((10190, 42241, 10226), ("Other Invertebrates", "Other")),# Rotifera/Tardigrada/Bryozoa
    ((7712, 7735), ("Other Invertebrates", "Other")),        # Tunicata/Cephalochordata
    ((50557,), ("Insects", "Other Insects")),                # Insecta
    ((33208,), ("Other Invertebrates", "Other")),            # Metazoa, after vertebrates/insects
)


ANCHOR_TAXIDS = sorted({
    taxid
    for anchors, _result in TAXONOMY_ANCHOR_RULES
    for taxid in anchors
})


def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _candidate_taxids(taxid: Any, species_taxonomy_id: Any) -> List[int]:
    candidates: List[int] = []
    for raw in (species_taxonomy_id, taxid):
        value = _int_or_zero(raw)
        if value and value not in candidates:
            candidates.append(value)
    return candidates


class TaxonomyLineageClassifier:
    """Classify species into Ensembl download groups using compact lineage data."""

    def __init__(
        self,
        artifact_path: Optional[Path] = None,
        artifact: Optional[Dict[str, Any]] = None,
    ):
        self.artifact_path = Path(artifact_path or DEFAULT_TAXONOMY_ARTIFACT_PATH)
        self.artifact = artifact if isinstance(artifact, dict) else self._load_artifact(self.artifact_path)

    def _load_artifact(self, path: Path) -> Dict[str, Any]:
        try:
            if not path.exists():
                return {}
            with path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def artifact_status(self) -> Dict[str, Any]:
        metadata = self.artifact.get("metadata") if isinstance(self.artifact, dict) else {}
        coverage = self.artifact.get("coverage") if isinstance(self.artifact, dict) else {}
        return {
            "available": bool(self.artifact.get("taxids")),
            "path": str(self.artifact_path),
            "schema_version": self.artifact.get("schema_version", ""),
            "generated_at": str((metadata or {}).get("generated_at") or ""),
            "source_catalog_fingerprint": str((metadata or {}).get("source_catalog_fingerprint") or ""),
            "requested_taxid_count": int((coverage or {}).get("requested_taxid_count") or 0),
            "lineage_taxid_count": len(self.artifact.get("taxids") or {}),
        }

    def resolve_taxid(self, taxid: int) -> int:
        if not taxid:
            return 0
        merged = self.artifact.get("merged_taxids") or {}
        try:
            return int(merged.get(str(taxid)) or taxid)
        except Exception:
            return taxid

    def lineage_for_taxid(self, taxid: int) -> Tuple[int, Tuple[int, ...]]:
        resolved = self.resolve_taxid(taxid)
        taxids = self.artifact.get("taxids") or {}
        record = taxids.get(str(taxid)) or taxids.get(str(resolved))
        if not isinstance(record, dict):
            return resolved, ()
        try:
            lineage = tuple(int(value) for value in (record.get("lineage") or []) if int(value or 0))
        except Exception:
            lineage = ()
        return _int_or_zero(record.get("resolved_taxid") or resolved), lineage

    def classify_lineage(self, lineage: Iterable[int]) -> Optional[Tuple[str, Optional[str]]]:
        lineage_ids = {int(value) for value in lineage if int(value or 0)}
        for anchors, result in TAXONOMY_ANCHOR_RULES:
            if any(anchor in lineage_ids for anchor in anchors):
                return result
        return None

    def classify(
        self,
        scientific_name: str,
        common_name: str,
        taxid: Any,
        species_taxonomy_id: Any,
        fallback_classifier: Optional[FallbackClassifier] = None,
    ) -> ClassificationResult:
        missing_taxids: List[int] = []
        for candidate in _candidate_taxids(taxid, species_taxonomy_id):
            resolved, lineage = self.lineage_for_taxid(candidate)
            if not lineage:
                missing_taxids.append(candidate)
                continue
            classified = self.classify_lineage(lineage)
            if classified:
                group, sub_group = classified
                return ClassificationResult(group, sub_group, "lineage", candidate, resolved)
            return ClassificationResult("Other", None, "lineage_unclassified", candidate, resolved)

        if fallback_classifier:
            group, sub_group = fallback_classifier(scientific_name, common_name, _int_or_zero(taxid), _int_or_zero(species_taxonomy_id))
            return ClassificationResult(
                str(group or "Other") or "Other",
                sub_group,
                "heuristic",
                _int_or_zero(species_taxonomy_id) or _int_or_zero(taxid),
                0,
                tuple(missing_taxids),
            )

        return ClassificationResult(
            "Other",
            None,
            "missing_lineage" if missing_taxids else "unknown",
            _int_or_zero(species_taxonomy_id) or _int_or_zero(taxid),
            0,
            tuple(missing_taxids),
        )

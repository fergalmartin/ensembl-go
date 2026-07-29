import csv
import json
import hashlib
import logging
import asyncio
import os
import re
import shutil
import time
import threading
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Dict, Optional
from urllib.parse import quote, urlencode, urlparse
from pydantic import BaseModel
import requests

from assembly_report import (
    build_ncbi_all_prefix,
    extract_ncbi_assembly_dirs_from_listing,
    select_ncbi_assembly_dir,
    split_gca_accession,
)
from genome_identity import DEFAULT_PROVIDER, NCBI_PROVIDER, normalize_source_database
from project_classifier import DEFAULT_PROJECT_ARTIFACT_PATH, PROJECT_ORDER, ProjectMembershipClassifier
from species_name_policy import (
    build_species_name_policy,
    catalog_fingerprint as species_policy_catalog_fingerprint,
    load_species_name_policy,
    preferred_species_display_name,
    save_species_name_policy,
    species_record_from_summary,
)
from security_utils import get_with_validated_redirects, validate_remote_download_url
from taxonomy_classifier import TaxonomyLineageClassifier

logger = logging.getLogger(__name__)

ENSEMBL_FTP_BASE = "https://ftp.ebi.ac.uk/pub/ensemblorganisms/"
ENSEMBL_SPECIES_CATALOG_NEW_URL = ENSEMBL_FTP_BASE + "species.new_ftp_structure.json"
ENSEMBL_SPECIES_CATALOG_LEGACY_URL = ENSEMBL_FTP_BASE + "species.json"
ENSEMBL_NEW_FTP_PATH_RE = re.compile(r"^GC[AF]/\d{3}/\d{3}/\d{3}/\d+/")
NCBI_DATASETS_API_BASE = "https://api.ncbi.nlm.nih.gov/datasets/v2"
NCBI_DATASETS_API_HOST = "api.ncbi.nlm.nih.gov"
NCBI_DATASETS_API_PATH_PREFIX = "/datasets/"
NCBI_API_DEFAULT_DELAY_SECONDS = 1.0
NCBI_API_DEFAULT_429_DELAY_SECONDS = 10.0
NCBI_METADATA_DISCOVERY_TTL_SECONDS = 60 * 60 * 24  # 24 hours
CATALOG_REFRESH_TTL_SECONDS = 60 * 60 * 24  # 24 hours
CATALOG_PREVIEW_LIMIT = 20
NCBI_REFSEQ_CACHE_TTL_SECONDS = 60 * 60  # 1 hour
NCBI_FEATURED_ACCESSIONS = [
    "GCF_000001405.40",  # Homo sapiens GRCh38.p14
    "GCF_000001405.25",  # Homo sapiens GRCh37.p13
    "GCF_009914755.1",   # Homo sapiens T2T-CHM13v2.0
    "GCF_000001635.9",   # Mus musculus GRCm39
    "GCF_036323735.1",   # Rattus norvegicus GRCr8
    "GCF_000002315.6",   # Gallus gallus GRCg6a
    "GCF_000002035.6",   # Danio rerio GRCz11
    "GCF_002234675.1",   # Oryzias latipes ASM223467v1
    "GCF_000001215.4",   # Drosophila melanogaster Release 6
    "GCF_000005575.2",   # Anopheles gambiae AgamP4
    "GCF_000002765.6",   # Plasmodium falciparum 3D7
    "GCF_000001735.4",   # Arabidopsis thaliana TAIR10.1
    "GCF_001433935.1",   # Oryza sativa Oryza_sativa_v1.0
    "GCA_900519105.1",   # Triticum aestivum (no RefSeq equivalent)
    "GCF_000002985.6",   # Caenorhabditis elegans WBcel235
    "GCF_000146045.2",   # Saccharomyces cerevisiae R64
    "GCF_000005845.2",   # Escherichia coli K-12 MG1655
]

ASSEMBLY_FILE_TYPES = {"fasta", "metadata"}
DATASET_FILE_TYPES = {
    "gff3",
    "homology",
    "cdna",
    "protein",
    "xref",
    "gff3_index",
    "gtf_index",
    "cdna_index",
    "protein_index",
    "xref_index",
    "gtf",
    "embl",
    "alignment",
    "other_annotation",
    "other",
}
DEFAULT_DATASET_FILE_TYPES = {"gff3", "homology", "cdna", "protein", "xref"}
SIDE_CAR_SUFFIXES = (".fai", ".gzi", ".csi", ".tbi")
FTP_DIRECTORY_CACHE_TTL_SECONDS = 60 * 60 * 24
PAIRWISE_ALIGNMENT_MANIFEST_FILENAME = "pairwise_alignments.release-116.tsv"
PAIRWISE_ALIGNMENT_RELEASE_SOURCE = "ensembl_compara"
PAIRWISE_ALIGNMENT_RELEASE_DATE = "release-116"
PAIRWISE_ALIGNMENT_RELEASE_LABEL = "Ensembl Compara release 116"
PAIRWISE_ALIGNMENT_DIRECTORY_URL = (
    "https://ftp.ensembl.org/pub/release-116/maf/ensembl-compara/pairwise_alignments/"
)

# Maps RefSeq browse-group names to NCBI taxonomy IDs used in dataset_report queries.
NCBI_TAXON_GROUPS: Dict[str, str] = {
    "Mammals":    "40674",   # Mammalia
    "Fish":       "7898",    # Actinopterygii
    "Birds":      "8782",    # Aves
    "Reptiles":   "1294634", # Reptilia
    "Amphibians": "8292",    # Amphibia
    "Insects":    "50557",   # Insecta
    "Nematodes":  "6231",    # Nematoda
    "Plants":     "33090",   # Viridiplantae
    "Fungi":      "4751",    # Fungi
    "Bacteria":   "2",       # Bacteria
    "Archaea":    "2157",    # Archaea
}

NCBI_AGGREGATE_GROUPS: Dict[str, List[str]] = {
    "Vertebrates": [
        NCBI_TAXON_GROUPS["Mammals"],
        NCBI_TAXON_GROUPS["Fish"],
        NCBI_TAXON_GROUPS["Birds"],
        NCBI_TAXON_GROUPS["Reptiles"],
        NCBI_TAXON_GROUPS["Amphibians"],
    ],
    "Invertebrates": [
        NCBI_TAXON_GROUPS["Insects"],
        NCBI_TAXON_GROUPS["Nematodes"],
    ],
    "Microbes": [
        NCBI_TAXON_GROUPS["Bacteria"],
        NCBI_TAXON_GROUPS["Archaea"],
    ],
}

NCBI_CATALOG_GROUPS: List[str] = [
    "Mammals",
    "Fish",
    "Birds",
    "Reptiles",
    "Amphibians",
    "Insects",
    "Nematodes",
    "Plants",
    "Fungi",
    "Bacteria",
    "Archaea",
]

DOWNLOAD_GROUP_ORDER = [
    "Mammals", "Fish", "Birds", "Reptiles", "Amphibians",
    "Insects", "Plants",
    "Other Invertebrates", "Microbes", "Other",
    "Projects",
]

DOWNLOAD_SUB_GROUP_ORDER: Dict[str, List[str]] = {
    "Mammals": [
        "Primates",
        "Rodents",
        "Bats",
        "True insectivores",
        "Marsupials",
        "Carnivores",
        "Even-toed ungulates & whales",
        "Odd-toed ungulates",
        "Rabbits & hares",
        "Monotremes",
        "Afrotheria",
        "Xenarthra",
        "Pangolins",
        "Other Mammals",
    ],
}


def _ordered_sub_group_items(group: str, sub_counts: Counter) -> List[tuple]:
    preferred = {name: index for index, name in enumerate(DOWNLOAD_SUB_GROUP_ORDER.get(group, []))}
    return sorted(
        sub_counts.items(),
        key=lambda item: (
            preferred.get(item[0], len(preferred)),
            -item[1],
            str(item[0]).lower(),
        ),
    )


def _now_iso_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _write_json_atomic(path: Path, payload: Any) -> None:
    """Write JSON so readers never observe a partially written file.

    The catalogue is large enough that a quit or crash mid-write would otherwise
    leave truncated JSON behind, which then fails to parse on every later start.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique per writer: status polls can call this concurrently with a refresh, and a
    # shared temporary name would let two writers interleave into the same file.
    tmp_path = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with tmp_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise


def _parse_iso_timestamp(value: Any) -> float:
    raw = str(value or "").strip()
    if not raw:
        return 0.0
    try:
        normalized = raw.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except Exception:
        return 0.0


def _accession_sharded_prefix(accession: Any) -> str:
    match = re.match(r"^(GC[AF])_(\d{9})(?:\.(\d+))?$", str(accession or "").strip())
    if not match:
        return ""
    source, digits, version = match.groups()
    chunks = [digits[index:index + 3] for index in range(0, len(digits), 3)]
    if not version:
        return f"{source}/{'/'.join(chunks)}/"
    return f"{source}/{'/'.join(chunks)}/{version}/"


def _iter_catalog_string_values(value: Any):
    if isinstance(value, dict):
        for item in value.values():
            yield from _iter_catalog_string_values(item)
        return
    if isinstance(value, list):
        for item in value:
            yield from _iter_catalog_string_values(item)
        return
    if isinstance(value, str):
        yield value


def _iter_catalog_file_paths(payload: Dict[str, Any]):
    species = payload.get("species") if isinstance(payload, dict) else {}
    if not isinstance(species, dict):
        return
    for species_key, info in species.items():
        if not isinstance(info, dict):
            continue
        assemblies = info.get("assemblies") or {}
        if not isinstance(assemblies, dict):
            continue
        for accession, asm_data in assemblies.items():
            if not isinstance(asm_data, dict):
                continue
            assembly_files = ((asm_data.get("assembly") or {}).get("files") or {})
            for path in _iter_catalog_string_values(assembly_files):
                if "/" in path:
                    yield str(species_key), str(accession), path

            providers = asm_data.get("genebuild_providers") or {}
            if not isinstance(providers, dict):
                continue
            for provider_data in providers.values():
                if not isinstance(provider_data, dict):
                    continue
                for build_data in provider_data.values():
                    if not isinstance(build_data, dict):
                        continue
                    for path in _iter_catalog_string_values(build_data.get("paths") or {}):
                        if "/" in path:
                            yield str(species_key), str(accession), path


def _detect_catalog_format(payload: Dict[str, Any]) -> tuple[str, List[str]]:
    warnings: List[str] = []
    path_count = 0
    new_path_count = 0
    unexpected_samples: List[str] = []
    mismatch_samples: List[str] = []

    for species_key, accession, path in _iter_catalog_file_paths(payload):
        path_count += 1
        if ENSEMBL_NEW_FTP_PATH_RE.match(path):
            new_path_count += 1
            expected_prefix = _accession_sharded_prefix(accession)
            if expected_prefix and not path.startswith(expected_prefix) and len(mismatch_samples) < 3:
                mismatch_samples.append(f"{species_key}/{accession}: {path}")
            continue
        if len(unexpected_samples) < 3:
            unexpected_samples.append(f"{species_key}/{accession}: {path}")

    if path_count == 0:
        return "unknown", ["Species catalogue contains no downloadable file paths to validate."]

    if new_path_count == path_count:
        catalog_format = "new_ftp_structure"
    elif new_path_count == 0:
        catalog_format = "legacy_or_unknown"
        warnings.append(
            "Species catalogue does not use the expected accession-sharded Ensembl FTP paths "
            "(for example GCA/000/005/845/2/...)."
        )
    else:
        catalog_format = "mixed"
        warnings.append(
            f"Species catalogue mixes accession-sharded and non-sharded paths "
            f"({new_path_count} of {path_count} paths matched the new FTP structure)."
        )

    if unexpected_samples:
        warnings.append("Unexpected Ensembl FTP catalogue path samples: " + "; ".join(unexpected_samples))
    if mismatch_samples:
        warnings.append("Accession-sharded path prefix mismatch samples: " + "; ".join(mismatch_samples))
    return catalog_format, warnings


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

class AssemblySummary(BaseModel):
    accession: str = ""
    gca: str = ""
    name: str
    level: str
    provider: str = DEFAULT_PROVIDER
    source_database: str = "Ensembl"
    equivalent_accessions: List[str] = []
    projects: List[str] = []


class SpeciesSummary(BaseModel):
    key: str
    scientific_name: str
    common_name: str
    display_name: str = ""
    display_name_reason: str = ""
    taxid: int
    species_taxonomy_id: int
    group: str
    sub_group: Optional[str] = None
    assemblies: List[AssemblySummary]
    provider: str = DEFAULT_PROVIDER


class GroupCount(BaseModel):
    name: str
    count: int
    sub_groups: List[Dict]  # [{name, count}]


class FileInfo(BaseModel):
    url: str
    filename: str
    size: Optional[int] = 0
    type: str  # 'fasta', 'gff3', 'homology', 'metadata', 'other'
    provider: str = DEFAULT_PROVIDER
    scope: str = "dataset"  # 'assembly' or 'dataset'
    dataset_release_key: str = ""
    dataset_release_source: str = ""
    dataset_release_date: str = ""
    dataset_release_label: str = ""
    is_index: bool = False
    selected_by_default: bool = False
    parent_type: str = ""
    alignment_id: str = ""
    alignment_type: str = ""
    method_link_species_set_id: str = ""
    other_species_name: str = ""
    other_species_gca: str = ""
    other_species_gcf: str = ""
    other_assembly_name: str = ""
    other_accession: str = ""


class DownloadTask(BaseModel):
    id: str
    filename: str
    url: str
    species_key: str
    assembly: str
    provider: str = DEFAULT_PROVIDER
    file_type: Optional[str] = None  # 'fasta', 'gff3', 'homology', 'metadata'
    dataset_release_key: str = ""
    dataset_release_source: str = ""
    dataset_release_date: str = ""
    dataset_release_label: str = ""
    status: str  # 'pending', 'downloading', 'completed', 'failed', 'canceled'
    progress: float = 0.0
    error: Optional[str] = None
    warning: Optional[str] = None
    destination: str
    cancel_requested: bool = False
    current_download_path: Optional[str] = None


class DownloadCancelled(Exception):
    """Raised inside the download worker when the user cancels a task."""


def _to_species_key(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9]+", "_", str(value or "").strip()).strip("_")
    return token or "unknown_species"


def _source_database_label(value: Any, assembly: str = "") -> str:
    raw = str(value or "").strip()
    if raw.startswith("SOURCE_DATABASE_"):
        raw = raw.replace("SOURCE_DATABASE_", "", 1)
    mapping = {
        "GENBANK": "GenBank",
        "REFSEQ": "RefSeq",
        "UNSPECIFIED": "",
    }
    return mapping.get(raw.upper(), normalize_source_database(raw, NCBI_PROVIDER, assembly))


# ---------------------------------------------------------------------------
# Taxonomy classifier
# ---------------------------------------------------------------------------

# Manually curated species_taxonomy_id → (group, sub_group).
# Checked against NCBI taxonomy. This handles the most-studied species
# which tend to have ambiguous or generic common names.
_TAXID_MAP: Dict[int, tuple] = {
    # Rodents
    10090: ("Mammals", "Rodents"),    # Mus musculus
    10096: ("Mammals", "Rodents"),    # Mus spretus
    10089: ("Mammals", "Rodents"),    # Mus caroli
    10091: ("Mammals", "Rodents"),    # Mus musculus musculus
    10092: ("Mammals", "Rodents"),    # Mus musculus domesticus
    10093: ("Mammals", "Rodents"),    # Mus pahari
    10116: ("Mammals", "Rodents"),    # Rattus norvegicus
    10029: ("Mammals", "Rodents"),    # Cricetulus griseus
    1047088: ("Mammals", "Rodents"),  # Arvicola amphibius
    9986: ("Mammals", "Rabbits & hares"),  # Oryctolagus cuniculus
    # Primates
    9606: ("Mammals", "Primates"),    # Homo sapiens
    9598: ("Mammals", "Primates"),    # Pan troglodytes
    9597: ("Mammals", "Primates"),    # Pan paniscus
    9544: ("Mammals", "Primates"),    # Macaca mulatta
    # Ungulates
    9823: ("Mammals", "Even-toed ungulates & whales"),   # Sus scrofa
    9913: ("Mammals", "Even-toed ungulates & whales"),   # Bos taurus
    9940: ("Mammals", "Even-toed ungulates & whales"),   # Ovis aries
    9925: ("Mammals", "Even-toed ungulates & whales"),   # Capra hircus
    9796: ("Mammals", "Odd-toed ungulates"),   # Equus caballus
    # Carnivores
    9612: ("Mammals", "Carnivores"),  # Canis lupus familiaris
    9685: ("Mammals", "Carnivores"),  # Felis catus
    # Bats
    9413: ("Mammals", "Bats"),  # Megaderma lyra
    # Marsupials
    13616: ("Mammals", "Marsupials"),  # Monodelphis domestica
    # Fish
    8030: ("Fish", None),    # Salmo salar
    8090: ("Fish", None),    # Oryzias latipes
    7994: ("Fish", None),    # Astyanax mexicanus
    7955: ("Fish", None),    # Danio rerio
    8128: ("Fish", None),    # Oreochromis niloticus
    158456: ("Fish", None),  # Betta splendens
    38527: ("Fish", None),   # Abramis brama
    13397: ("Fish", None),   # Carcharodon carcharias
    # Birds
    9031: ("Birds", None),   # Gallus gallus
    8839: ("Birds", None),   # Anas platyrhynchos
    932674: ("Birds", None), # Corvus cornix cornix
    # Plants - Cereals
    4565: ("Plants", "Cereals"),    # Triticum aestivum
    4567: ("Plants", "Cereals"),    # Triticum turgidum
    4571: ("Plants", "Cereals"),    # Triticum turgidum subsp. durum
    37682: ("Plants", "Cereals"),   # Aegilops tauschii
    4530: ("Plants", "Cereals"),    # Oryza sativa
    39946: ("Plants", "Cereals"),   # Oryza sativa Indica
    39947: ("Plants", "Cereals"),   # Oryza sativa Japonica
    1736656: ("Plants", "Cereals"), # Oryza sativa tropical japonica
    1736658: ("Plants", "Cereals"), # Oryza sativa aromatic
    1736659: ("Plants", "Cereals"), # Oryza sativa aus
    4513: ("Plants", "Cereals"),    # Hordeum vulgare
    112509: ("Plants", "Cereals"),  # Hordeum vulgare subsp.
    4577: ("Plants", "Cereals"),    # Zea mays
    4558: ("Plants", "Cereals"),    # Sorghum bicolor
    # Plants - Other
    3702: ("Plants", "Other Plants"),  # Arabidopsis thaliana
    4081: ("Plants", "Other Plants"),  # Solanum lycopersicum
    4113: ("Plants", "Other Plants"),  # Solanum tuberosum
    3711: ("Plants", "Other Plants"),  # Brassica rapa
    3712: ("Plants", "Other Plants"),  # Brassica oleracea
    3708: ("Plants", "Other Plants"),  # Brassica napus
    29760: ("Plants", "Other Plants"), # Vitis vinifera
    3847: ("Plants", "Other Plants"),  # Glycine max
    3880: ("Plants", "Other Plants"),  # Medicago truncatula
    # Insects
    7227: ("Insects", "Flies"),         # Drosophila melanogaster
    309970: ("Insects", "Bees & Wasps"), # Bombus picipes
    85660: ("Insects", "Bees & Wasps"),  # Bombus hortorum
    1086592: ("Insects", "Bees & Wasps"), # Cataglyphis hispanica
    7061: ("Insects", "Beetles"),        # Melolontha melolontha
    110024: ("Insects", "Beetles"),      # Nebria brevicollis
    33443: ("Insects", "Moths"),         # Heliconius sara
    104476: ("Insects", "Moths"),        # Agriopis aurantiaria
    1637456: ("Insects", "Flies"),       # Criorhina ranunculi
    # Amphibians
    8364: ("Amphibians", None),         # Xenopus tropicalis
    # Fungi
    4932: ("Microbes", "Fungi & Yeasts"),  # Saccharomyces cerevisiae
    # Other invertebrates
    6239: ("Other Invertebrates", "Worms"),
    6526: ("Other Invertebrates", "Molluscs"),
    6148: ("Other Invertebrates", "Corals & Jellyfish"),
    6210: ("Other Invertebrates", "Worms"),
    120202: ("Other Invertebrates", "Crustaceans"),
    # Microbes
    562: ("Microbes", "Bacteria"),   # Escherichia coli
    5833: ("Microbes", "Protists"),  # Plasmodium falciparum
}

# Common name keyword → (group, sub_group) lookups.
# Checked most-specific (insects before fish, etc.) to avoid overlaps.
_KEYWORD_RULES: List[tuple] = [
    # --- Insects ---
    ({"moth", "moths", "butterfly", "butterflies", "silkworm", "hawkmoth", "geometrid",
      "monarch butterfly", "scarce umber moth"},
     ("Insects", "Moths")),
    ({"fly", "flies", "mosquito", "mosquitos", "mosquitoes", "gnat", "midge",
      "crane fly", "sand fly", "blowfly", "horsefly", "hoverfly", "pomace fly",
      "pomace flies", "fruit fly", "blackfly", "african malaria mosquito"},
     ("Insects", "Flies")),
    ({"beetle", "beetles", "weevil", "ladybird", "ladybug", "longhorn", "bark beetle",
      "ground beetle", "diving beetle", "cockchafer", "rove beetle",
      "willow leaf beetle"},
     ("Insects", "Beetles")),
    ({"bee", "bees", "bumblebee", "honeybee", "wasp", "wasps", "ant", "ants",
      "hornet", "sawfly", "parasitoid wasp", "endoparasitoid wasp", "parasitoid",
      "hymenoptera", "hymenopterans", "desert ant", "wasps, ants & bees",
      "wasps, ants, and bees"},
     ("Insects", "Bees & Wasps")),
    ({"insect", "insects", "grasshopper", "grasshoppers", "cricket", "locust",
      "cockroach", "mantis", "caddisfly", "caddisflies", "mayfly", "mayflies",
      "stonefly", "stoneflies", "springtail", "damselfly", "dragonfly", "thrips",
      "louse", "lice", "bug", "bugs", "aphid", "aphids"},
     ("Insects", "Other Insects")),

    # --- Fish ---
    ({"fish", "fishes", "bony fish", "bony fishes", "salmon", "trout", "zebrafish",
      "medaka", "tilapia", "bream", "perch", "stickleback", "three-spined stickleback",
      "tetra", "mexican tetra", "shark", "great white shark", "ray", "lamprey",
      "eel", "cod", "herring", "tuna", "carp", "common carp", "loach", "catfish",
      "bass", "pike", "flounder", "anchovy", "sardine", "mackerel", "snapper",
      "grouper", "cichlid", "guppy", "killifish", "pufferfish", "seahorse",
      "siamese fighting fish", "atlantic salmon", "japanese medaka",
      "nile tilapia", "common bream", "mexican tetra"},
     ("Fish", None)),

    # --- Amphibians ---
    ({"frog", "toad", "salamander", "newt", "axolotl", "clawed frog",
      "tropical clawed frog", "caecilian"},
     ("Amphibians", None)),

    # --- Reptiles ---
    ({"snake", "lizard", "crocodile", "alligator", "turtle", "tortoise",
      "gecko", "iguana", "chameleon", "skink", "monitor", "viper", "cobra",
      "python", "boa", "tuatara", "anole"},
     ("Reptiles", None)),

    # --- Birds ---
    ({"bird", "birds", "crow", "duck", "chicken", "pigeon", "dove",
      "finch", "sparrow", "mallard", "grouse", "warbler", "lark",
      "parrot", "eagle", "hawk", "falcon", "owl", "heron", "starling",
      "thrush", "robin", "tit", "wren", "blackbird", "magpie", "jay",
      "rook", "raven", "tern", "gull", "seagull", "flamingo", "pelican",
      "gannet", "albatross", "penguin", "ostrich", "emu", "kiwi",
      "turkey", "quail", "pheasant", "partridge", "crane", "stork",
      "ibis", "kingfisher", "woodpecker", "swallow", "martin",
      "hooded crow", "canary", "goldfinch", "chaffinch"},
     ("Birds", None)),

    # --- Rodents ---
    ({"mouse", "rat", "hamster", "vole", "gerbil", "guinea pig",
      "mole-rat", "squirrel", "dormouse", "beaver", "capybara",
      "eurasian water vole", "chinese hamster", "algerian mouse",
      "ryukyu mouse", "shrew mouse", "norway rat"},
     ("Mammals", "Rodents")),

    # --- Mammal common-name exceptions ---
    ({"tree shrew", "tree shrews", "flying lemur", "flying lemurs",
      "colugo", "colugos"},
     ("Mammals", "Other Mammals")),

    # --- Primates ---
    ({"human", "chimp", "chimpanzee", "gorilla", "orangutan", "macaque",
      "monkey", "lemur", "gibbon", "baboon", "marmoset", "bonobo", "ape",
      "tarsier", "galago"},
     ("Mammals", "Primates")),

    # --- Bats ---
    ({"bat", "bats", "vampire bat", "horseshoe bat", "fruit bat",
      "big-eared bat", "brown bat", "free-tailed bat", "tomb bat"},
     ("Mammals", "Bats")),

    # --- True insectivores ---
    ({"shrew", "shrews", "mole", "moles", "hedgehog", "hedgehogs",
      "pygmy shrew", "white-toothed shrew"},
     ("Mammals", "True insectivores")),

    # --- Marsupials ---
    ({"opossum", "opossums", "possum", "possums", "koala", "kangaroo",
      "wallaby", "wombat", "marsupial", "marsupials"},
     ("Mammals", "Marsupials")),

    # --- Carnivores ---
    ({"dog", "cat", "wolf", "fox", "bear", "brown bear", "otter", "ferret",
      "weasel", "badger", "seal", "sea lion", "panda", "lion", "tiger",
      "leopard", "cheetah", "hyena", "indian false vampire"},
     ("Mammals", "Carnivores")),

    # --- Even-toed ungulates and whales ---
    ({"pig", "boar", "cow", "cattle", "bison", "buffalo", "yak", "sheep",
      "goat", "deer", "elk", "moose", "antelope", "camel", "llama", "alpaca",
      "giraffe", "hippopotamus", "hippo", "dolphin", "porpoise", "whale"},
     ("Mammals", "Even-toed ungulates & whales")),

    # --- Odd-toed ungulates ---
    ({"horse", "donkey", "ass", "zebra", "rhinoceros", "rhino", "tapir"},
     ("Mammals", "Odd-toed ungulates")),

    # --- Rabbits and hares ---
    ({"rabbit", "rabbits", "hare", "hares", "pika", "pikas"},
     ("Mammals", "Rabbits & hares")),

    # --- Monotremes ---
    ({"platypus", "echidna", "monotreme", "monotremes"},
     ("Mammals", "Monotremes")),

    # --- Afrotheria ---
    ({"elephant", "elephants", "manatee", "manatees", "tenrec", "tenrecs",
      "aardvark", "aardvarks", "hyrax", "hyraxes"},
     ("Mammals", "Afrotheria")),

    # --- Xenarthra ---
    ({"armadillo", "armadillos", "sloth", "sloths", "anteater", "anteaters",
      "tamandua", "tamanduas"},
     ("Mammals", "Xenarthra")),

    # --- Pangolins ---
    ({"pangolin", "pangolins"},
     ("Mammals", "Pangolins")),

    # --- Other Mammals ---
    ({"colugo", "colugos", "flying lemur", "tree shrew", "tree shrews"},
     ("Mammals", "Other Mammals")),

    # --- Plants - Cereals ---
    ({"wheat", "rice", "barley", "maize", "corn", "sorghum", "oat",
      "oats", "rye", "triticale", "millet", "teff", "wild barley",
      "domesticated barley", "bread wheat", "durum wheat", "indica rice",
      "aus rice", "japonica rice", "aromatic rice", "goatgrass",
      "tausch's goatgrass"},
     ("Plants", "Cereals")),

    # --- Plants - Other ---
    ({"plant", "plants", "eudicot", "eudicots", "monocot", "monocots",
      "tomato", "potato", "soybean", "soya", "grape", "wine grape",
      "cotton", "sunflower", "mustard", "oilseed", "rapeseed", "cabbage",
      "kale", "broccoli", "cauliflower", "medic", "barrel medic",
      "alfalfa", "lucerne", "clover", "tobacco", "thale-cress", "cress",
      "arabidopsis", "poplar", "eucalyptus", "pine", "spruce", "oak",
      "willow", "breadfruit", "banana", "mango", "papaya", "melon",
      "cucumber", "squash", "pepper", "carrot", "lettuce", "spinach",
      "beet", "cassava", "yam", "sweet potato", "coffee", "cocoa",
      "flax", "hemp", "sesame", "lentil", "chickpea", "peanut",
      "groundnut", "field mustard", "oilseed rape"},
     ("Plants", "Other Plants")),

    # --- Fungi & Yeasts (under Microbes) ---
    ({"yeast", "fungi", "fungus", "mushroom", "mold", "mould", "oomycete",
      "rust", "smut", "baker's yeast", "brewer's yeast"},
     ("Microbes", "Fungi & Yeasts")),

    # --- Other invertebrates ---
    ({"coral", "stony coral", "stony corals", "sea anemone", "anemones",
      "jellyfish", "jellyfishes", "hydra", "hydrozoans", "cauliflower coral"},
     ("Other Invertebrates", "Corals & Jellyfish")),
    ({"worm", "worms", "nematode", "roundworm", "flatworm", "tapeworm",
      "leech", "tube worm", "tube worms", "segmented worm", "segmented worms",
      "dog tapeworm", "oligochaete", "bloodfluke planorb", "bryozoa",
      "bryozoans"},
     ("Other Invertebrates", "Worms")),
    ({"snail", "slug", "mussel", "clam", "oyster", "scallop", "bivalve",
      "bivalves", "gastropod", "gastropods", "cephalopod", "cephalopods",
      "octopus", "squid", "cuttlefish", "abalone", "limpet"},
     ("Other Invertebrates", "Molluscs")),
    ({"crab", "lobster", "shrimp", "prawn", "barnacle", "copepod",
      "amphipod", "isopod", "krill", "water flea", "crustacean",
      "crustaceans", "artemia", "woodlouse"},
     ("Other Invertebrates", "Crustaceans")),
    ({"starfish", "sea urchin", "sea cucumber", "brittle star", "crinoid",
      "echinoderm"},
     ("Other Invertebrates", "Echinoderms")),
    ({"sponge", "sponges"},
     ("Other Invertebrates", "Sponges")),
    ({"rotifer", "tardigrade", "water bear tardigrade", "springtail",
      "mayfly", "roundworm", "water bear"},
     ("Other Invertebrates", "Other")),
    ({"tick", "ticks", "mite", "mites", "spider", "spiders", "scorpion",
      "harvestman", "arachnid"},
     ("Other Invertebrates", "Arachnids")),
]

# Scientific name prefixes that indicate bacteria or protists
_BACTERIA_PREFIXES = {
    "escherichia", "salmonella", "bacillus", "staphylococcus", "streptococcus",
    "mycobacterium", "pseudomonas", "vibrio", "listeria", "helicobacter",
    "campylobacter", "clostridium", "yersinia", "shigella", "klebsiella",
    "enterococcus", "lactobacillus", "bifidobacterium", "treponema", "borrelia",
    "rickettsia", "chlamydia", "mycoplasma", "haemophilus", "neisseria",
    "bordetella", "legionella", "brucella", "francisella", "burkholderia",
}
_PROTIST_PREFIXES = {
    "plasmodium", "leishmania", "trypanosoma", "toxoplasma", "giardia",
    "cryptosporidium", "entamoeba", "paramecium", "tetrahymena", "dictyostelium",
    "emiliania", "puccinia", "magnaporthe", "zymoseptoria", "schizosaccharomyces",
    "capsaspora", "salpingoeca",
}

# Lepidoptera (butterflies & moths) genera — most have no common name
_LEPIDOPTERA_GENERA = {
    "erebia", "melitaea", "boloria", "colias", "pyrgus", "aricia", "lycaena",
    "coenonympha", "lasiommata", "maniola", "pararge", "thymelicus",
    "callophrys", "polyommatus", "plebejus", "cyaniris", "celastrina",
    "satyrium", "thecla", "quercusia", "cupido", "glaucopsyche", "iolana",
    "lysandra", "agriades", "zizina", "chilades", "phengaris", "maculinea",
    "iphiclides", "papilio", "pieris", "leptidea", "anthocharis",
    "aporia", "gonepteryx", "catopsilia", "eurema", "nymphalis", "vanessa",
    "aglais", "polygonia", "araschnia", "neptis", "limenitis", "charaxes",
    "hipparchia", "chazara", "oeneis", "brintesia", "kanetisa",
    "acleris", "zygaena", "idaea", "eupithecia", "agriopis",
    "cerastis", "eudonia", "laspeyria", "polymixis", "agrochola",
    "tinea", "heliconius", "danaus", "morpho", "caligo",
    # Additional genera
    "euchloe", "epiblema", "euphydryas", "epinotia", "cyclophora",
    "lomographa", "synanthedon", "cosmia", "melanargia", "catocala",
    "amphipoea", "noctua", "xestia", "agrotis", "spodoptera",
    "helicoverpa", "mamestra", "orthosia", "phytometra", "apamea",
    "autographa", "scoliopteryx", "rivula", "plusia", "acronicta",
    "scopula", "perizoma", "xanthorhoe", "lampropteryx", "horisme",
    "operophtera", "theria", "alsophila", "archiearis", "polymixis",
}

# Diptera (flies) genera
_DIPTERA_GENERA = {
    "anopheles", "aedes", "culex", "simulium", "stomoxys", "musca",
    "calliphora", "lucilia", "sarcophaga", "glossina", "phlebotomus",
    "lutzomyia", "drosophila", "ceratitis", "bactrocera", "rhagoletis",
    "cheilosia", "criorhina", "chrysotoxum", "pollenia", "empis",
    "tipula", "chironomus",
}

# Hymenoptera (bees, wasps, ants) genera
_HYMENOPTERA_GENERA = {
    "andrena", "apis", "bombus", "xylocopa", "halictus", "lasioglossum",
    "osmia", "megachile", "nomada", "coelioxys", "sphecodes",
    "vespa", "vespula", "polistes", "dolichovespula",
    "formica", "myrmica", "lasius", "ponera", "solenopsis",
    "pimpla", "ichneumon", "nasonia", "pteromalus", "trichogramma",
    "cataglyphis", "tenthredo", "arge", "athalia", "macrocentrus",
}

# Coleoptera (beetles) genera
_COLEOPTERA_GENERA = {
    "tribolium", "tenebrio", "sitophilus", "diabrotica", "leptinotarsa",
    "coleomegilla", "coccinella", "harmonia", "chrysomela", "phratora",
    "plagiodera", "melolontha", "anomala", "cetonia", "cockchafer",
    "nebria", "carabus", "pterostichus", "agriotes", "elater",
    "oryctes", "dynastes", "goliathus", "lucanus",
}

# Fish genera (beyond taxid lookup)
_FISH_GENERA = {
    "salmo", "oncorhynchus", "danio", "oryzias", "astyanax",
    "oreochromis", "betta", "abramis", "gadus", "clupeoides",
    "esox", "perca", "cranoglanis", "lepisosteus", "polypterus",
    "latimeria", "acipenser", "petromyzon", "scyliorhinus", "squalus",
    "takifugu", "tetraodon", "gasterosteus", "lethenteron",
    "carassius", "cyprinus", "labeo", "catla", "hypomesus",
    "sander", "morone", "larimichthys", "sparus",
    "dicentrarchus", "solea", "pleuronectes", "hippoglossus",
    "argentina", "odontesthes",
    "sinocyclocheilus", "alosa", "megalops", "leucoraja", "labrus",
    "epinephelus", "lates", "anabas", "channa", "clarias",
    "pangasianodon", "silurus", "ictalurus", "anguilla",
    "mola", "xiphias", "thunnus",
}

# Bird genera (beyond taxid lookup)
_BIRD_GENERA = {
    "larus", "anas", "anser", "gallus", "meleagris", "numida",
    "coturnix", "phasianus", "corvus", "pica", "garrulus",
    "taeniopygia", "serinus", "carduelis", "fringilla", "passer",
    "turdus", "erithacus", "phylloscopus", "acrocephalus",
    "falco", "accipiter", "buteo", "aquila", "haliaeetus",
    "strix", "bubo", "athene", "tyto",
    "columba", "streptopelia",
    "phoenicopterus", "pelecanus",
    "aptenodytes", "spheniscus",
    "cygnus", "aythya", "aix", "mergus", "somateria",
    "charadrius", "vanellus", "tringa", "calidris",
    "sturnus", "hirundo", "delichon",
    "sylvia", "muscicapa", "ficedula",
}

# Archaea genera
_ARCHAEA_GENERA = {
    "methanobacterium", "methanococcus", "methanosarcina", "methanothermobacter",
    "halobacterium", "haloferax", "haloquadratum", "natronobacterium",
    "sulfolobus", "thermoplasma", "pyrococcus", "thermococcus",
    "archaeoglobus", "pyrobaculum", "aeropyrum", "ignicoccus",
    "nitrosopumilus", "cenarchaeum", "nanoarchaeum",
}

# Mammal genera (beyond taxid lookup)
_BAT_GENERA = {
    "artibeus", "corynorhinus", "desmodus", "eptesicus", "hipposideros",
    "megaderma", "miniopterus", "mops", "myotis", "phyllostomus",
    "pipistrellus", "plecotus", "pteropus", "rhinolophus", "saccopteryx",
    "tadarida", "taphozous", "vespertilio", "noctilio", "molossus",
}

_TRUE_INSECTIVORE_GENERA = {
    "blarina", "crocidura", "erinaceus", "sorex", "suncus", "talpa",
}

_MARSUPIAL_GENERA = {
    "monodelphis", "vombatus", "phascolarctos", "macropus", "sarcophilus",
}

_CARNIVORE_GENERA = {
    "mustela", "vulpes", "martes", "neovison", "lutra", "meles",
    "ailurus", "ursus", "canis", "felis", "panthera", "puma",
    "acinonyx", "hyaena", "crocuta", "enhydra", "phoca", "zalophus",
}

_EVEN_TOED_UNGULATE_WHALE_GENERA = {
    "sus", "bos", "bison", "ovis", "capra", "camelus", "lama", "vicugna",
    "cervus", "odocoileus", "alces", "giraffa", "hippopotamus",
    "phocoena", "tursiops", "orcinus", "physeter", "balaenoptera",
}

_ODD_TOED_UNGULATE_GENERA = {
    "equus", "ceratotherium", "diceros", "rhinoceros", "tapirus",
}

_LAGOMORPH_GENERA = {
    "oryctolagus", "lepus", "ochotona",
}

_MONOTREME_GENERA = {
    "ornithorhynchus", "tachyglossus", "zaglossus",
}

_AFROTHERIA_GENERA = {
    "loxodonta", "elephas", "trichechus", "tenrec", "orycteropus",
    "procavia", "chrysochloris", "echinops",
}

_XENARTHRA_GENERA = {
    "dasypus", "choloepus", "bradypus", "tamandua", "myrmecophaga",
}

_PANGOLIN_GENERA = {
    "manis", "phataginus", "smutsia",
}

_MAMMAL_GENERA = {
    # Rodents not in taxid map
    "marmota", "spermophilus", "cynomys", "tamias", "sciurus",
    "castor", "hydrochoerus", "cavia", "chinchilla", "octodon",
}

# Plant genera (beyond taxid lookup)
_PLANT_GENERA = {
    "arabidopsis", "oryza", "triticum", "hordeum", "zea", "sorghum",
    "brassica", "solanum", "vitis", "glycine", "medicago", "aegilops",
    "avena", "secale", "fragaria", "malus", "prunus", "rosa",
    "helianthus", "gossypium", "nicotiana", "lycopersicon",
    "ailanthus", "populus", "eucalyptus", "pinus", "abies",
    "quercus", "betula", "juglans", "castanea", "fagus",
    "carex", "lolium", "festuca", "poa", "panicum", "setaria",
    "capsicum", "cucumis", "cucurbita", "citrullus", "lycopersicum",
    "coffea", "theobroma", "camellia", "linum", "cannabis",
    "sesamum", "lens", "cicer", "phaseolus", "vigna",
    "arachis", "lupinus", "pisum",
    "veronica", "hypericum", "potentilla", "vicia", "eragrostis",
    "ribes", "schoenoplectus", "marchantia", "riccia", "conocephalum",
    "plantago", "ranunculus", "viola", "silene", "dianthus",
    "digitalis", "salvia", "mentha", "lavandula", "origanum",
    "thymus", "ocimum", "pelargonium", "geranium",
    "allium", "asparagus", "dioscorea",
    "manihot", "ipomoea", "jatropha", "ricinus", "hevea",
    "citrus", "musa", "cocos", "phoenix",
}

# Fungi genera (beyond taxid lookup)
_FUNGI_GENERA = {
    "saccharomyces", "schizosaccharomyces", "candida", "aspergillus",
    "penicillium", "fusarium", "alternaria", "botrytis", "trichoderma",
    "neurospora", "ustilago", "puccinia", "phytophthora", "pythium",
    "russula", "agaricus", "coprinopsis", "laccaria", "tuber",
    "magnaporthe", "zymoseptoria", "blumeria", "podospora",
    "colletotrichum", "hygrocybe", "lactarius", "inocybe", "cladonia",
    "rhizopus", "mucor", "rhizoctonia", "sclerotinia", "verticillium",
    "metarhizium", "beauveria", "claviceps", "epichloe",
}

# Protist / parasite genera
_PROTIST_GENERA = {
    "plasmodium", "leishmania", "trypanosoma", "toxoplasma", "giardia",
    "cryptosporidium", "entamoeba", "paramecium", "tetrahymena",
    "dictyostelium", "emiliania", "pfiesteria", "thalassiosira",
    "phytophthora",  # oomycete often grouped here
}

# Arachnid genera
_ARACHNID_GENERA = {
    "ixodes", "rhipicephalus", "haemaphysalis", "amblyomma", "boophilus",
    "tetranychus", "panonychus", "varroa", "sarcoptes", "demodex",
    "acarus", "dermatophagoides",
    "araneae", "latrodectus", "loxosceles", "araneus", "tegenaria",
}

# Other invertebrate genera
_OTHER_INVERT_GENERA = {
    "branchiostoma",  # amphioxus
    "crassostrea", "mytilus", "pecten", "ostrea",  # bivalves
    "helix", "lymnaea", "biomphalaria",  # gastropods
    "octopus", "loligo", "sepia",  # cephalopods
    "strongylocentrotus", "arbacia",  # sea urchins
    "asterias",  # starfish
    "daphnia", "artemia", "litopenaeus",  # crustaceans
    "caenorhabditis", "meloidogyne", "ascaris",  # nematodes
    "echinococcus", "taenia", "schistosoma", "fasciola",  # flatworms
    "lumbriculus", "helobdella",  # annelids
    "hypsibius",  # tardigrade
    "folsomia",  # springtail
    "acropora", "porites", "millepora", "actinia",  # more corals/anemones
    "littorina", "pinctada", "anisus", "saccostrea", "gigantidas",  # more molluscs
    "strigamia", "lithobius", "scolopendra",  # centipedes
    "maratus",  # peacock spider
    "litopenaeus", "penaeus", "gammarus",  # more crustaceans
    "agelas", "amphimedon", "ephydatia",  # more sponges
}


def _classify_species(scientific_name: str, common_name: str,
                      taxid: int, species_taxonomy_id: int) -> tuple:
    """Return (group, sub_group) strings for a species."""
    # 1. Check curated taxid map first (most reliable)
    for tid in (species_taxonomy_id, taxid):
        if tid and tid in _TAXID_MAP:
            return _TAXID_MAP[tid]

    cn = (common_name or "").lower().strip()
    sn = (scientific_name or "").lower().strip()

    # 2. Genus-based classification first (more reliable than common names)
    first_word = sn.split()[0] if sn else ""

    if first_word in _BACTERIA_PREFIXES:
        return ("Microbes", "Bacteria")
    if first_word in _ARCHAEA_GENERA:
        return ("Microbes", "Archaea")
    if first_word in _PROTIST_GENERA or first_word in _PROTIST_PREFIXES:
        return ("Microbes", "Protists")
    if first_word in _FUNGI_GENERA:
        return ("Microbes", "Fungi & Yeasts")
    if first_word in _LEPIDOPTERA_GENERA:
        return ("Insects", "Moths")
    if first_word in _DIPTERA_GENERA:
        return ("Insects", "Flies")
    if first_word in _HYMENOPTERA_GENERA:
        return ("Insects", "Bees & Wasps")
    if first_word in _COLEOPTERA_GENERA:
        return ("Insects", "Beetles")
    if first_word in _PLANT_GENERA:
        return ("Plants", "Other Plants")
    if first_word in _FISH_GENERA:
        return ("Fish", None)
    if first_word in _BIRD_GENERA:
        return ("Birds", None)
    if first_word in _BAT_GENERA:
        return ("Mammals", "Bats")
    if first_word in _TRUE_INSECTIVORE_GENERA:
        return ("Mammals", "True insectivores")
    if first_word in _MARSUPIAL_GENERA:
        return ("Mammals", "Marsupials")
    if first_word in _CARNIVORE_GENERA:
        return ("Mammals", "Carnivores")
    if first_word in _EVEN_TOED_UNGULATE_WHALE_GENERA:
        return ("Mammals", "Even-toed ungulates & whales")
    if first_word in _ODD_TOED_UNGULATE_GENERA:
        return ("Mammals", "Odd-toed ungulates")
    if first_word in _LAGOMORPH_GENERA:
        return ("Mammals", "Rabbits & hares")
    if first_word in _MONOTREME_GENERA:
        return ("Mammals", "Monotremes")
    if first_word in _AFROTHERIA_GENERA:
        return ("Mammals", "Afrotheria")
    if first_word in _XENARTHRA_GENERA:
        return ("Mammals", "Xenarthra")
    if first_word in _PANGOLIN_GENERA:
        return ("Mammals", "Pangolins")
    if first_word in _MAMMAL_GENERA:
        return ("Mammals", "Other Mammals")
    if first_word in _ARACHNID_GENERA:
        return ("Other Invertebrates", "Arachnids")
    if first_word in _OTHER_INVERT_GENERA:
        return ("Other Invertebrates", "Other")

    # 3. Common-name keyword matching (word-boundary to avoid substring issues)
    if cn:
        for keyword_set, result in _KEYWORD_RULES:
            for kw in keyword_set:
                if re.search(r'\b' + re.escape(kw) + r'\b', cn):
                    return result

    return ("Other", None)


# ---------------------------------------------------------------------------
# Download manager
# ---------------------------------------------------------------------------

class DownloadManager:
    def __init__(self, data_path: Path, cache_dir: Optional[Path] = None, catalog_source_url: Optional[str] = None):
        self.data_path = data_path
        self.species_data: Dict[str, Any] = {}
        self.tasks: Dict[str, DownloadTask] = {}
        self._species_cache: Optional[List[SpeciesSummary]] = None
        self._metadata_url_cache: Dict[str, Dict[str, Any]] = {}
        self._pairwise_alignment_rows_cache: List[Dict[str, str]] = []
        self._pairwise_alignment_rows_mtime: float = -1.0
        self._pairwise_alignment_catalog_lookup_cache: Optional[Dict[str, List[Dict[str, str]]]] = None
        self._ncbi_species_cache: Dict[str, SpeciesSummary] = {}
        self._ncbi_species_list_cache: Dict[str, Dict[str, Any]] = {}
        self._ncbi_group_count_cache: Dict[str, Any] = {}  # {groups: [...], fetched_at: float}
        self._ftp_directory_cache: Dict[str, Dict[str, Any]] = {}
        self._ncbi_catalog_lock = threading.Lock()
        self._ncbi_api_download_lock = threading.Lock()
        self._ncbi_api_last_request_at = 0.0
        self.cache_dir = Path(cache_dir).expanduser().resolve() if cache_dir else self.data_path.parent
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.catalog_cache_path = self.cache_dir / "remote_species_catalog.json"
        self.catalog_state_path = self.cache_dir / "remote_species_catalog_state.json"
        self.project_cache_path = self.cache_dir / "project_classification.json"
        self.species_name_policy_path = self.cache_dir / "species_name_policy.json"
        self.species_name_policy: Dict[str, Any] = {}
        self.taxonomy_classifier = TaxonomyLineageClassifier()
        self.taxonomy_classification_diagnostics: Dict[str, Any] = {}
        self.project_classifier = ProjectMembershipClassifier(
            artifact_path=self.project_cache_path,
            fallback_artifact_path=DEFAULT_PROJECT_ARTIFACT_PATH,
        )
        self.project_classification_status: Dict[str, Any] = {}
        explicit_catalog_url = str(catalog_source_url or os.environ.get("ENSEMBL_LOCAL_SPECIES_JSON_URL") or "").strip()
        if explicit_catalog_url:
            self.catalog_source_urls = [explicit_catalog_url]
        else:
            self.catalog_source_urls = [ENSEMBL_SPECIES_CATALOG_NEW_URL, ENSEMBL_SPECIES_CATALOG_LEGACY_URL]
        self.catalog_source_url = self.catalog_source_urls[0] if self.catalog_source_urls else None
        self.catalog_payload: Dict[str, Any] = {}
        self.catalog_last_updated: str = ""
        self.catalog_source_kind: str = "bundled"
        self.catalog_current_url: str = ""
        self.catalog_format: str = "unknown"
        self.catalog_warnings: List[str] = []
        self._catalog_state: Dict[str, Any] = {}
        self._catalog_refresh_lock = threading.Lock()
        self._catalog_refresh_in_progress = False
        self._catalog_refresh_pending = False
        self._catalog_refresh_thread: Optional[threading.Thread] = None
        # State first: it records the species count of the last completed refresh, which
        # load_data needs in order to tell a complete cache from a partial one.
        self._load_catalog_state()
        self.load_data(prefer_cached=True)
        self._load_species_name_policy()
        self._ensure_catalog_state_defaults()

    def _pairwise_alignment_manifest_path(self) -> Path:
        return self.cache_dir / PAIRWISE_ALIGNMENT_MANIFEST_FILENAME

    def _load_pairwise_alignment_rows(self) -> List[Dict[str, str]]:
        path = self._pairwise_alignment_manifest_path()
        try:
            mtime = path.stat().st_mtime
        except FileNotFoundError:
            self._pairwise_alignment_rows_cache = []
            self._pairwise_alignment_rows_mtime = -1.0
            return []
        except Exception:
            return list(self._pairwise_alignment_rows_cache)

        if self._pairwise_alignment_rows_mtime == mtime:
            return list(self._pairwise_alignment_rows_cache)

        try:
            with path.open("r", encoding="utf-8", newline="") as handle:
                rows = [dict(row) for row in csv.DictReader(handle, delimiter="\t")]
        except Exception:
            logger.exception("Failed to load pairwise alignment manifest from %s", path)
            rows = []

        self._pairwise_alignment_rows_cache = rows
        self._pairwise_alignment_rows_mtime = mtime
        return list(rows)

    def _normalize_alignment_match_token(self, value: Any) -> str:
        return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())

    def _alignment_side_accessions(self, row: Dict[str, str], side: int) -> set[str]:
        tokens: set[str] = set()
        for field in (
            f"species_{side}_gca",
            f"species_{side}_gcf",
            f"species_{side}_primary_accession",
        ):
            raw = str(row.get(field) or "").strip()
            if raw:
                tokens.add(raw.upper())
        equivalents = str(row.get(f"species_{side}_equivalent_accessions") or "")
        for raw in re.split(r"[,;|\s]+", equivalents):
            token = raw.strip()
            if token:
                tokens.add(token.upper())
        return tokens

    def _catalog_species_match_tokens(self, species_key: str, species: Dict[str, Any]) -> set[str]:
        values = [
            species_key,
            (species or {}).get("scientific_name"),
            (species or {}).get("display_name"),
            (species or {}).get("common_name"),
        ]
        return {self._normalize_alignment_match_token(value) for value in values if str(value or "").strip()}

    def _catalog_assembly_match_tokens(self, assembly: str, asm_data: Dict[str, Any]) -> set[str]:
        values = [
            assembly,
            (asm_data or {}).get("name"),
            (asm_data or {}).get("assembly_name"),
        ]
        return {self._normalize_alignment_match_token(value) for value in values if str(value or "").strip()}

    def _catalog_accession_tokens(self, assembly: str, asm_data: Dict[str, Any]) -> set[str]:
        tokens: set[str] = set()
        values = [
            assembly,
            (asm_data or {}).get("gca"),
            (asm_data or {}).get("accession"),
            (asm_data or {}).get("primary_accession"),
        ]
        values.extend((asm_data or {}).get("equivalent_accessions") or [])
        for raw in values:
            token = str(raw or "").strip()
            if token:
                tokens.add(token.upper())
        return tokens

    def _pairwise_alignment_catalog_lookup(self) -> Dict[str, List[Dict[str, str]]]:
        if self._pairwise_alignment_catalog_lookup_cache is not None:
            return self._pairwise_alignment_catalog_lookup_cache

        lookup: Dict[str, List[Dict[str, str]]] = {}
        for species_key, species in (self.species_data or {}).items():
            if not isinstance(species, dict):
                continue
            assemblies = species.get("assemblies") or {}
            if not isinstance(assemblies, dict) or not assemblies:
                continue
            assembly, raw_asm_data = next(iter(assemblies.items()))
            asm_data = raw_asm_data if isinstance(raw_asm_data, dict) else {}
            accession = str(assembly or "").strip()
            equivalents = [
                str(value or "").strip()
                for value in (asm_data.get("equivalent_accessions") or [])
                if str(value or "").strip()
            ]
            record = {
                "species_key": str(species_key or "").strip(),
                "accession": accession,
                "gca": str(asm_data.get("gca") or (accession if accession.upper().startswith("GCA_") else "")).strip(),
                "gcf": str(asm_data.get("gcf") or next((value for value in equivalents if value.upper().startswith("GCF_")), "")).strip(),
                "assembly_name": str(asm_data.get("name") or asm_data.get("assembly_name") or "").strip(),
            }
            tokens = self._catalog_species_match_tokens(str(species_key or ""), species)
            for taxon_field in ("taxid", "species_taxonomy_id"):
                taxon = str(species.get(taxon_field) or "").strip()
                if taxon:
                    tokens.add(taxon)
            for token in tokens:
                if token:
                    lookup.setdefault(token, []).append(record)

        self._pairwise_alignment_catalog_lookup_cache = lookup
        return lookup

    def _catalog_record_for_alignment_side(self, row: Dict[str, str], side: int) -> Dict[str, str]:
        tokens = [
            self._normalize_alignment_match_token(row.get(f"species_{side}_species_key")),
            self._normalize_alignment_match_token(row.get(f"species_{side}_species_name")),
            self._normalize_alignment_match_token(row.get(f"species_{side}_compara_name")),
            self._normalize_alignment_match_token(row.get(f"species_{side}_display_name")),
            self._normalize_alignment_match_token(row.get(f"species_{side}_common_name")),
            str(row.get(f"species_{side}_taxon_id") or "").strip(),
        ]
        lookup = self._pairwise_alignment_catalog_lookup()
        for token in tokens:
            if not token:
                continue
            candidates = lookup.get(token) or []
            if len(candidates) == 1:
                return candidates[0]
        return {}

    def _alignment_side_matches_catalog(
        self,
        row: Dict[str, str],
        side: int,
        catalog_accessions: set[str],
        catalog_assemblies: set[str],
        catalog_species: set[str],
    ) -> bool:
        row_accessions = self._alignment_side_accessions(row, side)
        if catalog_accessions and row_accessions.intersection(catalog_accessions):
            return True

        row_assemblies = {
            self._normalize_alignment_match_token(row.get(f"species_{side}_assembly_name")),
            self._normalize_alignment_match_token(row.get(f"species_{side}_catalog_assembly_name")),
        }
        row_species = {
            self._normalize_alignment_match_token(row.get(f"species_{side}_species_key")),
            self._normalize_alignment_match_token(row.get(f"species_{side}_species_name")),
            self._normalize_alignment_match_token(row.get(f"species_{side}_compara_name")),
        }
        row_assemblies.discard("")
        row_species.discard("")
        if row_assemblies.intersection(catalog_assemblies) and row_species.intersection(catalog_species):
            return True
        return bool(not row_accessions and row_species.intersection(catalog_species))

    def _alignment_file_info_from_row(self, row: Dict[str, str], current_side: int) -> FileInfo:
        other_side = 2 if current_side == 1 else 1
        release = str(row.get("release") or "116").strip() or "116"
        release_date = f"release-{release}"
        release_key = self._release_key(PAIRWISE_ALIGNMENT_RELEASE_SOURCE, release_date)
        other_gca = str(row.get(f"species_{other_side}_gca") or "").strip()
        other_gcf = str(row.get(f"species_{other_side}_gcf") or "").strip()
        other_primary = str(row.get(f"species_{other_side}_primary_accession") or "").strip()
        other_record: Dict[str, str] = {}
        if not other_gca and not other_gcf and not other_primary:
            other_record = self._catalog_record_for_alignment_side(row, other_side)
            other_gca = other_record.get("gca") or ""
            other_gcf = other_record.get("gcf") or ""
            other_primary = other_record.get("accession") or ""
        other_assembly = str(row.get(f"species_{other_side}_assembly_name") or "").strip()
        if not other_assembly:
            if not other_record:
                other_record = self._catalog_record_for_alignment_side(row, other_side)
            other_assembly = other_record.get("assembly_name") or ""
        return FileInfo(
            url=str(row.get("ftp_url") or "").strip(),
            filename=str(row.get("ftp_filename") or "").strip(),
            type="alignment",
            provider=DEFAULT_PROVIDER,
            scope="dataset",
            dataset_release_key=release_key,
            dataset_release_source=PAIRWISE_ALIGNMENT_RELEASE_SOURCE,
            dataset_release_date=release_date,
            dataset_release_label=f"Ensembl Compara release {release}",
            selected_by_default=False,
            alignment_id=str(row.get("alignment_id") or "").strip(),
            alignment_type=str(row.get("alignment_type") or "").strip(),
            method_link_species_set_id=str(row.get("method_link_species_set_id") or "").strip(),
            other_species_name=str(row.get(f"species_{other_side}_species_name") or "").strip(),
            other_species_gca=other_gca,
            other_species_gcf=other_gcf,
            other_assembly_name=other_assembly,
            other_accession=other_gca or other_gcf or other_primary,
        )

    def _get_pairwise_alignment_file_infos(
        self,
        species_key: str,
        assembly: str,
        species: Dict[str, Any],
        asm_data: Dict[str, Any],
    ) -> List[FileInfo]:
        catalog_accessions = self._catalog_accession_tokens(assembly, asm_data)
        catalog_assemblies = self._catalog_assembly_match_tokens(assembly, asm_data)
        catalog_species = self._catalog_species_match_tokens(species_key, species)
        files: List[FileInfo] = []
        seen: set[str] = set()
        for row in self._load_pairwise_alignment_rows():
            if not str(row.get("ftp_url") or "").strip() or not str(row.get("ftp_filename") or "").strip():
                continue
            matching_sides = [
                side for side in (1, 2)
                if self._alignment_side_matches_catalog(
                    row,
                    side,
                    catalog_accessions,
                    catalog_assemblies,
                    catalog_species,
                )
            ]
            for side in matching_sides:
                item = self._alignment_file_info_from_row(row, side)
                key = f"{item.url}|{side}|{item.other_species_name}|{item.other_assembly_name}"
                if key in seen:
                    continue
                files.append(item)
                seen.add(key)
        return sorted(
            files,
            key=lambda item: (
                item.other_species_name.lower(),
                item.other_accession.lower(),
                item.alignment_type.lower(),
                item.filename.lower(),
            ),
        )

    def _discover_ncbi_assembly_report(self, assembly: str) -> Optional[Dict[str, str]]:
        stem, version, full_accession = split_gca_accession(assembly)
        if not stem:
            return None

        listing_url = build_ncbi_all_prefix(stem)
        if not listing_url:
            return None

        listing_resp = requests.get(listing_url, timeout=6)
        if not listing_resp.ok:
            return None

        directories = extract_ncbi_assembly_dirs_from_listing(listing_resp.text or "")
        selected_dir = select_ncbi_assembly_dir(directories, stem, version, full_accession)
        if not selected_dir:
            return None

        report_filename = f"{selected_dir}_assembly_report.txt"
        report_url = f"{listing_url}{selected_dir}/{report_filename}"

        # Validation request: prefer HEAD, fall back to GET if HEAD is disallowed.
        head_resp = requests.head(report_url, timeout=6)
        if head_resp.ok:
            return {"url": report_url, "filename": report_filename}

        with requests.get(report_url, timeout=6, stream=True) as get_resp:
            if get_resp.ok:
                return {"url": report_url, "filename": report_filename}
        return None

    def _get_metadata_file_info(self, assembly: str) -> Optional[FileInfo]:
        now = time.time()
        cached = self._metadata_url_cache.get(assembly)
        if cached and (now - float(cached.get("fetched_at") or 0.0)) <= NCBI_METADATA_DISCOVERY_TTL_SECONDS:
            url = str(cached.get("url") or "").strip()
            filename = str(cached.get("filename") or "").strip()
            if url and filename:
                return FileInfo(url=url, filename=filename, type="metadata")
            return None

        try:
            discovered = self._discover_ncbi_assembly_report(assembly)
        except Exception:
            discovered = None

        if discovered and discovered.get("url") and discovered.get("filename"):
            self._metadata_url_cache[assembly] = {
                "fetched_at": now,
                "url": discovered["url"],
                "filename": discovered["filename"],
            }
            return FileInfo(url=discovered["url"], filename=discovered["filename"], type="metadata")

        # Negative-cache misses so UI polling does not repeatedly hit NCBI.
        self._metadata_url_cache[assembly] = {"fetched_at": now, "url": "", "filename": ""}
        return None

    def _load_catalog_payload_from_path(self, path: Path) -> Dict[str, Any]:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise ValueError("Species catalogue payload must be an object")
        if not isinstance(payload.get("species"), dict):
            raise ValueError("Species catalogue payload is missing a valid 'species' object")
        return payload

    def _load_catalog_payload_from_url(self, url: str) -> Dict[str, Any]:
        response = requests.get(url, timeout=20)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Remote species catalogue payload must be an object")
        if not isinstance(payload.get("species"), dict):
            raise ValueError("Remote species catalogue payload is missing a valid 'species' object")
        return payload

    def _load_preferred_remote_catalog_payload(self) -> tuple[Dict[str, Any], str, str]:
        urls = [url for url in self.catalog_source_urls if str(url or "").strip()]
        if not urls:
            raise ValueError("No remote species catalogue URLs configured")

        last_error: Optional[Exception] = None
        for index, url in enumerate(urls):
            try:
                source_kind = "remote_url" if index == 0 else "remote_url_fallback"
                return self._load_catalog_payload_from_url(url), url, source_kind
            except requests.HTTPError as exc:
                last_error = exc
                status_code = int(getattr(getattr(exc, "response", None), "status_code", 0) or 0)
                if index == 0 and status_code == 404 and len(urls) > 1:
                    continue
                raise
        if last_error:
            raise last_error
        raise ValueError("No remote species catalogue URLs configured")

    def _set_catalog_payload(self, payload: Dict[str, Any], source_kind: str, source_locator: str = ""):
        self.catalog_payload = json.loads(json.dumps(payload))
        self.species_data = self.catalog_payload.get("species", {}) or {}
        self.catalog_last_updated = str(self.catalog_payload.get("last_updated") or "").strip()
        self.catalog_source_kind = str(source_kind or "bundled")
        self.catalog_current_url = str(source_locator or "").strip()
        self.catalog_format, self.catalog_warnings = _detect_catalog_format(self.catalog_payload)
        for warning in self.catalog_warnings:
            logger.warning("Species catalogue warning: %s", warning)
        self._species_cache = None
        self._pairwise_alignment_catalog_lookup_cache = None

    def _catalog_entries(self, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Dict[str, str]]:
        source = payload or self.catalog_payload or {"species": {}}
        species = source.get("species") or {}
        entries: Dict[str, Dict[str, str]] = {}
        for species_key, info in species.items():
            scientific_name = str((info or {}).get("scientific_name") or species_key).strip()
            assemblies = (info or {}).get("assemblies") or {}
            for assembly, asm_data in assemblies.items():
                entries[f"{species_key}::{assembly}"] = {
                    "species_key": str(species_key),
                    "assembly": str(assembly),
                    "scientific_name": scientific_name,
                    "assembly_name": str((asm_data or {}).get("name") or assembly).strip(),
                }
        return entries

    def _catalog_fingerprint(self, payload: Optional[Dict[str, Any]] = None) -> str:
        source = payload or self.catalog_payload or {"species": {}}
        encoded = json.dumps(source, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha1(encoded).hexdigest()

    def _load_species_name_policy(self) -> Dict[str, Any]:
        self.species_name_policy = load_species_name_policy(self.species_name_policy_path)
        return self.species_name_policy

    def _species_summary_records(self, summaries: List[SpeciesSummary]) -> List[Dict[str, Any]]:
        return [species_record_from_summary(summary) for summary in summaries]

    def _apply_species_display_names(self, summaries: List[SpeciesSummary]) -> List[SpeciesSummary]:
        policy = self.species_name_policy or self._load_species_name_policy()
        out: List[SpeciesSummary] = []
        for summary in summaries:
            resolved = preferred_species_display_name(species_record_from_summary(summary), policy)
            out.append(
                summary.model_copy(
                    update={
                        "display_name": resolved.get("display_name", ""),
                        "display_name_reason": resolved.get("display_name_reason", ""),
                    }
                )
            )
        return out

    def _empty_taxonomy_classification_diagnostics(self) -> Dict[str, Any]:
        return {
            "artifact": self.taxonomy_classifier.artifact_status(),
            "total_species": 0,
            "lineage_classified_count": 0,
            "heuristic_classified_count": 0,
            "curated_classified_count": 0,
            "lineage_unclassified_count": 0,
            "other_count": 0,
            "missing_taxid_count": 0,
            "missing_taxids": [],
            "source_counts": {},
            "group_counts": {},
        }

    def _taxonomy_classification_status(self) -> Dict[str, Any]:
        if self.taxonomy_classification_diagnostics:
            return json.loads(json.dumps(self.taxonomy_classification_diagnostics))
        return self._empty_taxonomy_classification_diagnostics()

    def _project_classification_status(self) -> Dict[str, Any]:
        status = self.project_classifier.status()
        if self.project_classification_status:
            status.update(json.loads(json.dumps(self.project_classification_status)))
        return status

    def _assembly_project_candidates(self, accession: str, asm_data: Optional[Dict[str, Any]] = None) -> List[str]:
        candidates = [str(accession or "").strip()]
        data = asm_data if isinstance(asm_data, dict) else {}
        for field in ("gca", "accession", "assembly_accession"):
            value = str(data.get(field) or "").strip()
            if value:
                candidates.append(value)
        for value in data.get("equivalent_accessions") or []:
            text = str(value or "").strip()
            if text:
                candidates.append(text)
        out: List[str] = []
        seen = set()
        for candidate in candidates:
            key = candidate.upper()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(candidate)
        return out

    def _projects_for_assembly(self, accession: str, asm_data: Optional[Dict[str, Any]] = None) -> List[str]:
        return self.project_classifier.projects_for_accessions(self._assembly_project_candidates(accession, asm_data))

    def refresh_project_metadata(self, force: bool = False) -> Dict[str, Any]:
        if self.project_cache_path.exists() and not force:
            self.project_classifier = ProjectMembershipClassifier(
                artifact_path=self.project_cache_path,
                fallback_artifact_path=DEFAULT_PROJECT_ARTIFACT_PATH,
            )
            return self._project_classification_status()
        artifact = self.project_classifier.refresh(self.project_cache_path)
        status = self.project_classifier.status()
        status["last_refreshed_at"] = str((artifact.get("metadata") or {}).get("generated_at") or "")
        self.project_classification_status = status
        return self._project_classification_status()

    def _classify_species_for_download(
        self,
        scientific_name: str,
        common_name: str,
        taxid: int,
        species_taxonomy_id: int,
    ):
        return self.taxonomy_classifier.classify(
            scientific_name,
            common_name,
            taxid,
            species_taxonomy_id,
            fallback_classifier=_classify_species,
        )

    def _record_taxonomy_classification(
        self,
        diagnostics: Dict[str, Any],
        result: Any,
    ) -> None:
        diagnostics["total_species"] = int(diagnostics.get("total_species") or 0) + 1
        source = str(getattr(result, "source", "") or "unknown")
        group = str(getattr(result, "group", "") or "Other") or "Other"
        source_counts = diagnostics.setdefault("source_counts", {})
        source_counts[source] = int(source_counts.get(source) or 0) + 1
        group_counts = diagnostics.setdefault("group_counts", {})
        group_counts[group] = int(group_counts.get(group) or 0) + 1

        if source == "lineage":
            diagnostics["lineage_classified_count"] = int(diagnostics.get("lineage_classified_count") or 0) + 1
        elif source == "heuristic":
            diagnostics["heuristic_classified_count"] = int(diagnostics.get("heuristic_classified_count") or 0) + 1
        elif source == "curated":
            diagnostics["curated_classified_count"] = int(diagnostics.get("curated_classified_count") or 0) + 1
        elif source == "lineage_unclassified":
            diagnostics["lineage_unclassified_count"] = int(diagnostics.get("lineage_unclassified_count") or 0) + 1

        if group == "Other":
            diagnostics["other_count"] = int(diagnostics.get("other_count") or 0) + 1

        missing = set(int(value) for value in diagnostics.get("missing_taxids") or [] if int(value or 0))
        for taxid_value in getattr(result, "missing_taxids", ()) or ():
            try:
                taxid_int = int(taxid_value or 0)
            except Exception:
                continue
            if taxid_int:
                missing.add(taxid_int)
        diagnostics["missing_taxids"] = sorted(missing)
        diagnostics["missing_taxid_count"] = len(missing)

    def _policy_matches_current_catalog(self, policy: Optional[Dict[str, Any]] = None) -> bool:
        payload = policy if isinstance(policy, dict) else self.species_name_policy
        metadata = payload.get("metadata") if isinstance(payload, dict) else {}
        return str((metadata or {}).get("source_catalog_fingerprint") or "") == self._catalog_fingerprint()

    def refresh_species_name_policy(
        self,
        include_ncbi: bool = True,
        force: bool = False,
        app_summaries: Optional[List[SpeciesSummary]] = None,
    ) -> Dict[str, Any]:
        loaded = self.species_name_policy or self._load_species_name_policy()
        if loaded and not force and self._policy_matches_current_catalog(loaded):
            return loaded

        if app_summaries is None:
            app_summaries = self._build_app_species_summaries()

        records = self._species_summary_records(app_summaries)
        ncbi_errors: List[str] = []
        ncbi_count = 0
        ncbi_fetched_at = ""
        if include_ncbi:
            ncbi_fetched_at = _now_iso_utc()
            for source_filter in ("refseq", "genbank"):
                try:
                    ncbi_summaries = self._fetch_ncbi_species_catalog(source_filter)
                    ncbi_count += len(ncbi_summaries)
                    records.extend(self._species_summary_records(ncbi_summaries))
                except Exception as exc:
                    ncbi_errors.append(f"{source_filter}: {exc}")

        policy = build_species_name_policy(
            records,
            metadata={
                "source_catalog_fingerprint": self._catalog_fingerprint(),
                "source_catalog_last_updated": self.catalog_last_updated,
                "source_catalog_species_count": len(self.catalog_payload.get("species") or {}),
                "app_species_count": len(app_summaries),
                "ncbi_included": bool(include_ncbi),
                "ncbi_fetched_at": ncbi_fetched_at,
                "ncbi_species_count": ncbi_count,
                "ncbi_errors": ncbi_errors,
            },
        )
        save_species_name_policy(self.species_name_policy_path, policy)
        self.species_name_policy = policy
        if self._species_cache is not None:
            self._species_cache = self._apply_species_display_names(self._species_cache)
        return policy

    def _compute_catalog_diff(self, previous_payload: Dict[str, Any], next_payload: Dict[str, Any]) -> Dict[str, Any]:
        previous_entries = self._catalog_entries(previous_payload)
        next_entries = self._catalog_entries(next_payload)
        previous_ids = set(previous_entries)
        next_ids = set(next_entries)
        added_ids = sorted(next_ids - previous_ids)
        retired_ids = sorted(previous_ids - next_ids)
        return {
            "added_count": len(added_ids),
            "retired_count": len(retired_ids),
            "added_preview": [next_entries[key] for key in added_ids[:CATALOG_PREVIEW_LIMIT]],
            "retired_preview": [previous_entries[key] for key in retired_ids[:CATALOG_PREVIEW_LIMIT]],
        }

    def _save_catalog_state(self):
        state = json.loads(json.dumps(self._catalog_state or {}))
        _write_json_atomic(self.catalog_state_path, state)

    def _load_catalog_state(self):
        if not self.catalog_state_path.exists():
            self._catalog_state = {}
            return
        try:
            self._catalog_state = json.loads(self.catalog_state_path.read_text(encoding="utf-8"))
        except Exception:
            self._catalog_state = {}

    def _ensure_catalog_state_defaults(self):
        state = dict(self._catalog_state or {})
        state.setdefault("last_checked_at", "")
        state.setdefault("last_successful_refresh_at", "")
        state.setdefault("last_error", "")
        state.setdefault("current_catalog_last_updated", self.catalog_last_updated)
        state.setdefault("current_catalog_source", self.catalog_source_kind)
        state.setdefault("current_catalog_url", self.catalog_current_url)
        state.setdefault("current_catalog_format", self.catalog_format)
        state.setdefault("catalog_warnings", list(self.catalog_warnings or []))
        state.setdefault("current_catalog_fingerprint", self._catalog_fingerprint())
        state.setdefault("current_catalog_species_count", len(self.catalog_payload.get("species") or {}))
        state.setdefault("current_catalog_genome_count", len(self._catalog_entries()))
        state.setdefault("taxonomy_classification", self._taxonomy_classification_status())
        state.setdefault("project_classification", self._project_classification_status())
        latest_change = state.get("latest_change") if isinstance(state.get("latest_change"), dict) else {}
        latest_change.setdefault("token", "")
        latest_change.setdefault("checked_at", "")
        latest_change.setdefault("added_count", 0)
        latest_change.setdefault("retired_count", 0)
        latest_change.setdefault("added_preview", [])
        latest_change.setdefault("retired_preview", [])
        latest_change.setdefault("seen", True)
        state["latest_change"] = latest_change
        self._catalog_state = state
        try:
            # Only seed the cache from a catalogue that actually holds species. Writing an
            # empty or absent payload here used to leave a cache file that could never be
            # parsed, which then looked like "already downloaded" on every later start.
            if not self.catalog_cache_path.exists() and self.has_usable_catalog():
                _write_json_atomic(self.catalog_cache_path, self.catalog_payload)
            self._save_catalog_state()
        except Exception:
            logger.exception("Failed to persist initial remote species catalogue state")

    def has_usable_catalog(self) -> bool:
        """True when a catalogue with at least one species is loaded."""
        return bool(self.species_data)

    def _load_complete_catalog_payload(self, path: Path, source_kind: str) -> Dict[str, Any]:
        """Load a catalogue file, rejecting anything that is not a complete download.

        A file existing on disk is not evidence that its download finished. It may be
        truncated from an interrupted write, or an empty placeholder produced when no
        catalogue was available at build time. Either way it must not be mistaken for
        a usable catalogue, or the application silently offers no species to download.
        """
        payload = self._load_catalog_payload_from_path(path)

        species = payload.get("species") or {}
        if not species:
            raise ValueError(f"{path} contains no species; treating it as an incomplete download")

        if source_kind == "cache":
            # refresh_catalog records the species count alongside the cache it wrote, so a
            # mismatch means the file on disk is not the one that was completed.
            expected_count = (self._catalog_state or {}).get("current_catalog_species_count")
            if isinstance(expected_count, int) and expected_count > 0 and len(species) != expected_count:
                raise ValueError(
                    f"{path} holds {len(species)} species but the last completed refresh "
                    f"recorded {expected_count}; treating it as an incomplete download"
                )

        return payload

    def _discard_unusable_catalog_cache(self, reason: str) -> None:
        try:
            self.catalog_cache_path.unlink()
            logger.warning("Discarded unusable species catalogue cache (%s)", reason)
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("Could not remove unusable species catalogue cache: %s", exc)

    def load_data(self, prefer_cached: bool = True):
        candidates: List[tuple[Path, str]] = []
        if prefer_cached and self.catalog_cache_path.exists():
            candidates.append((self.catalog_cache_path, "cache"))
        candidates.append((self.data_path, "bundled"))
        last_error = None
        for path, source_kind in candidates:
            if not path.exists():
                continue
            try:
                payload = self._load_complete_catalog_payload(path, source_kind)
                self._set_catalog_payload(payload, source_kind, str(path))
                logger.info(f"Loaded {len(self.species_data)} species from {path}")
                return
            except Exception as exc:
                last_error = exc
                if source_kind == "cache":
                    # Remove it so the next refresh writes a clean file rather than
                    # tripping over the same unusable one on every start.
                    self._discard_unusable_catalog_cache(str(exc))
        if last_error is not None:
            logger.warning(f"No usable species catalogue on disk: {last_error}")
        else:
            logger.info(f"No species catalogue bundled at {self.data_path}")
        if self.catalog_source_urls:
            logger.info("The species catalogue will be fetched from Ensembl on startup.")

    def get_catalog_status(self) -> Dict[str, Any]:
        self._ensure_catalog_state_defaults()
        status = json.loads(json.dumps(self._catalog_state or {}))
        status["refresh_in_progress"] = bool(self._catalog_refresh_in_progress or self._catalog_refresh_pending)
        status["refresh_available"] = bool(self.catalog_source_urls) or self.data_path.exists()
        status["catalog_available"] = self.has_usable_catalog()
        status["species_count"] = len(self.species_data or {})
        # Lets the download view distinguish "still arriving" from "genuinely nothing here".
        status["initial_fetch_in_progress"] = bool(
            status["refresh_in_progress"] and not status["catalog_available"]
        )
        status["current_catalog_url"] = self.catalog_current_url
        status["current_catalog_format"] = self.catalog_format
        status["catalog_warnings"] = list(self.catalog_warnings or [])
        status["taxonomy_classification"] = self._taxonomy_classification_status()
        status["project_classification"] = self._project_classification_status()
        return status

    def acknowledge_catalog_change(self, token: str = "") -> Dict[str, Any]:
        self._ensure_catalog_state_defaults()
        latest_change = self._catalog_state.get("latest_change") or {}
        latest_token = str(latest_change.get("token") or "")
        if latest_token and (not token or token == latest_token):
            latest_change["seen"] = True
            self._catalog_state["latest_change"] = latest_change
            self._save_catalog_state()
        return self.get_catalog_status()

    def is_catalog_refresh_stale(self, ttl_seconds: int = CATALOG_REFRESH_TTL_SECONDS) -> bool:
        last_checked_ts = _parse_iso_timestamp((self._catalog_state or {}).get("last_checked_at"))
        if not last_checked_ts:
            return True
        return (time.time() - last_checked_ts) >= float(ttl_seconds)

    def refresh_catalog(self, force: bool = False) -> Dict[str, Any]:
        if not force and not self.is_catalog_refresh_stale():
            return self.get_catalog_status()
        with self._catalog_refresh_lock:
            self._catalog_refresh_in_progress = True
            try:
                checked_at = _now_iso_utc()
                self._ensure_catalog_state_defaults()
                source_locator = ""
                if self.catalog_source_urls:
                    payload, source_locator, source_kind = self._load_preferred_remote_catalog_payload()
                else:
                    payload = self._load_catalog_payload_from_path(self.data_path)
                    source_kind = "source_file"
                    source_locator = str(self.data_path)

                previous_payload = self.catalog_payload or {"species": {}}
                previous_fingerprint = self._catalog_fingerprint(previous_payload)
                next_fingerprint = self._catalog_fingerprint(payload)

                self._catalog_state["last_checked_at"] = checked_at
                self._catalog_state["last_error"] = ""

                if next_fingerprint != previous_fingerprint:
                    diff = self._compute_catalog_diff(previous_payload, payload)
                    _write_json_atomic(self.catalog_cache_path, payload)
                    self._set_catalog_payload(payload, source_kind, source_locator)
                    app_summaries = self._build_app_species_summaries()
                    self._species_cache = self._apply_species_display_names(app_summaries)
                    self.refresh_species_name_policy(include_ncbi=True, force=True, app_summaries=app_summaries)
                    change_token = hashlib.sha1(f"{checked_at}:{next_fingerprint}".encode("utf-8")).hexdigest()[:12]
                    self._catalog_state["latest_change"] = {
                        "token": change_token,
                        "checked_at": checked_at,
                        "added_count": diff["added_count"],
                        "retired_count": diff["retired_count"],
                        "added_preview": diff["added_preview"],
                        "retired_preview": diff["retired_preview"],
                        "seen": False,
                    }
                else:
                    if not self.catalog_cache_path.exists():
                        _write_json_atomic(self.catalog_cache_path, payload)
                    self._set_catalog_payload(payload, source_kind, source_locator)
                    app_summaries = self._build_app_species_summaries()
                    self._species_cache = self._apply_species_display_names(app_summaries)

                self._catalog_state["last_successful_refresh_at"] = checked_at
                self._catalog_state["current_catalog_last_updated"] = self.catalog_last_updated
                self._catalog_state["current_catalog_source"] = self.catalog_source_kind
                self._catalog_state["current_catalog_url"] = self.catalog_current_url
                self._catalog_state["current_catalog_format"] = self.catalog_format
                self._catalog_state["catalog_warnings"] = list(self.catalog_warnings or [])
                self._catalog_state["current_catalog_fingerprint"] = self._catalog_fingerprint()
                self._catalog_state["current_catalog_species_count"] = len(self.catalog_payload.get("species") or {})
                self._catalog_state["current_catalog_genome_count"] = len(self._catalog_entries())
                self._catalog_state["taxonomy_classification"] = self._taxonomy_classification_status()
                try:
                    self.refresh_project_metadata(force=True)
                    self._species_cache = self._apply_species_display_names(self._build_app_species_summaries())
                    self._catalog_state["project_classification"] = self._project_classification_status()
                except Exception as project_exc:
                    project_status = self._project_classification_status()
                    project_status["last_error"] = str(project_exc)
                    self.project_classification_status = project_status
                    self._catalog_state["project_classification"] = project_status
                    logger.warning("Project metadata refresh failed: %s", project_exc)
                self._save_catalog_state()
                return self.get_catalog_status()
            except Exception as exc:
                self._catalog_state["last_checked_at"] = _now_iso_utc()
                self._catalog_state["last_error"] = str(exc)
                self._save_catalog_state()
                raise
            finally:
                self._catalog_refresh_in_progress = False

    def schedule_catalog_refresh_if_stale(self, force: bool = False) -> bool:
        if not force and not self.is_catalog_refresh_stale():
            return False
        if self._catalog_refresh_in_progress or self._catalog_refresh_pending:
            return False
        existing_thread = self._catalog_refresh_thread
        if existing_thread and existing_thread.is_alive():
            return False

        def _runner():
            try:
                self.refresh_catalog(force=True)
            except Exception:
                logger.exception("Background remote species catalogue refresh failed")
            finally:
                self._catalog_refresh_pending = False

        # Set before starting the thread so status reports the fetch immediately, rather
        # than leaving a gap until the worker reaches refresh_catalog's lock.
        self._catalog_refresh_pending = True
        self._catalog_refresh_thread = threading.Thread(
            target=_runner,
            name="remote-species-catalog-refresh",
            daemon=True,
        )
        self._catalog_refresh_thread.start()
        return True

    def ensure_catalog_available(self) -> bool:
        """Start fetching the species catalogue when none is loaded.

        Called at application startup so the download is already under way — often
        finished — by the time the user opens the download view, instead of only
        starting when they get there and finding it empty.
        """
        if self.has_usable_catalog():
            return False
        if not self.catalog_source_urls:
            logger.error(
                "No species catalogue is available and no remote catalogue URL is configured; "
                "the download view will have no species to offer."
            )
            return False
        logger.info("No species catalogue loaded; fetching it from Ensembl in the background.")
        return self.schedule_catalog_refresh_if_stale(force=True)

    def _post_ncbi_dataset_report(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        response = requests.post(
            f"{NCBI_DATASETS_API_BASE}/genome/dataset_report",
            json=payload,
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("NCBI dataset_report response must be an object")
        return data

    def _append_ncbi_report_to_species_map(
        self,
        grouped: Dict[str, Dict[str, Any]],
        report: Dict[str, Any],
        group_override: Optional[str] = None,
    ) -> None:
        if not isinstance(report, dict):
            return

        organism = report.get("organism") or {}
        scientific_name = str(
            organism.get("organism_name")
            or organism.get("sci_name")
            or report.get("accession")
            or "Unknown species"
        ).strip()
        common_name = str(organism.get("common_name") or "").strip()
        taxid = int(organism.get("tax_id") or 0)
        species_key = _to_species_key(scientific_name)
        assembly_accession = str(report.get("accession") or "").strip()
        if not assembly_accession:
            return

        assembly_info = report.get("assembly_info") or {}
        assembly_name = str(assembly_info.get("assembly_name") or assembly_accession).strip()
        assembly_level = str(assembly_info.get("assembly_level") or "").strip()
        paired_accession = str(report.get("paired_accession") or "").strip()
        source_database = _source_database_label(report.get("source_database"), assembly_accession)

        species_entry = grouped.setdefault(
            species_key,
            {
                "key": species_key,
                "scientific_name": scientific_name,
                "common_name": common_name,
                "taxid": taxid,
                "species_taxonomy_id": taxid,
                "assemblies": [],
                "assembly_ids": set(),
                "group_override": group_override,
            },
        )
        if not species_entry.get("common_name") and common_name:
            species_entry["common_name"] = common_name
        if not species_entry.get("taxid") and taxid:
            species_entry["taxid"] = taxid
            species_entry["species_taxonomy_id"] = taxid
        if group_override and not species_entry.get("group_override"):
            species_entry["group_override"] = group_override

        assembly_ids = species_entry.get("assembly_ids")
        if assembly_accession in assembly_ids:
            return
        assembly_ids.add(assembly_accession)
        species_entry["assemblies"].append(
            AssemblySummary(
                accession=assembly_accession,
                gca=assembly_accession,
                name=assembly_name,
                level=assembly_level,
                provider=NCBI_PROVIDER,
                source_database=source_database,
                equivalent_accessions=[paired_accession] if paired_accession else [],
            )
        )

    def _finalize_ncbi_species_summaries(self, grouped: Dict[str, Dict[str, Any]]) -> List[SpeciesSummary]:
        summaries: List[SpeciesSummary] = []
        for info in grouped.values():
            classification = self._classify_species_for_download(
                info.get("scientific_name", ""),
                info.get("common_name", ""),
                info.get("taxid", 0),
                info.get("species_taxonomy_id", 0),
            )
            group = str(info.get("group_override") or classification.group or "Other").strip() or "Other"
            sub_group = classification.sub_group
            assemblies = sorted(
                info.get("assemblies") or [],
                key=lambda asm: (
                    0 if str(getattr(asm, "source_database", "")).lower() == "refseq" else 1,
                    str(getattr(asm, "name", "")).lower(),
                    str(getattr(asm, "accession", getattr(asm, "gca", ""))).lower(),
                ),
            )
            summary = SpeciesSummary(
                key=info["key"],
                scientific_name=info["scientific_name"],
                common_name=info["common_name"],
                taxid=info["taxid"],
                species_taxonomy_id=info["species_taxonomy_id"],
                group=group,
                sub_group=sub_group,
                assemblies=assemblies,
                provider=NCBI_PROVIDER,
            )
            self._ncbi_species_cache[summary.key] = summary
            summaries.append(summary)
        summaries.sort(key=lambda s: (s.scientific_name.lower(), s.key.lower()))
        summaries = self._apply_species_display_names(summaries)
        for summary in summaries:
            self._ncbi_species_cache[summary.key] = summary
        return summaries

    def _build_ncbi_species_summaries(self, payload: Dict[str, Any], group_override: Optional[str] = None) -> List[SpeciesSummary]:
        grouped: Dict[str, Dict[str, Any]] = {}
        for report in payload.get("reports") or []:
            self._append_ncbi_report_to_species_map(grouped, report, group_override=group_override)
        return self._finalize_ncbi_species_summaries(grouped)

    def _fetch_ncbi_species_catalog(self, assembly_source: str = "refseq") -> List[SpeciesSummary]:
        source_filter = str(assembly_source or "refseq").strip().lower() or "refseq"
        cached = self._ncbi_species_list_cache.get(source_filter)
        if cached and (time.time() - float(cached.get("fetched_at") or 0.0)) < NCBI_REFSEQ_CACHE_TTL_SECONDS:
            return list(cached.get("species") or [])

        with self._ncbi_catalog_lock:
            cached = self._ncbi_species_list_cache.get(source_filter)
            if cached and (time.time() - float(cached.get("fetched_at") or 0.0)) < NCBI_REFSEQ_CACHE_TTL_SECONDS:
                return list(cached.get("species") or [])

            grouped: Dict[str, Dict[str, Any]] = {}
            for group_name in NCBI_CATALOG_GROUPS:
                taxon_id = NCBI_TAXON_GROUPS.get(group_name)
                if not taxon_id:
                    continue

                page_token: Optional[str] = None
                while True:
                    payload: Dict[str, Any] = {
                        "taxons": [taxon_id],
                        "filters": {
                            "has_annotation": True,
                            "assembly_version": "current",
                            "assembly_source": source_filter,
                        },
                        "page_size": 1000,
                        "returned_content": "COMPLETE",
                    }
                    if page_token:
                        payload["page_token"] = page_token

                    response = self._post_ncbi_dataset_report(payload)
                    for report in response.get("reports") or []:
                        self._append_ncbi_report_to_species_map(grouped, report, group_override=group_name)

                    next_page_token = str(response.get("next_page_token") or "").strip()
                    if not next_page_token:
                        break
                    page_token = next_page_token
                    time.sleep(0.1)

                time.sleep(0.1)

            species = self._finalize_ncbi_species_summaries(grouped)
            self._ncbi_species_list_cache[source_filter] = {
                "species": list(species),
                "fetched_at": time.time(),
            }
            return species

    def search_ncbi_species(
        self,
        query: str,
        assembly_source: str = "all",
        page_size: int = 100,
    ) -> Dict[str, Any]:
        text = str(query or "").strip()
        if len(text) < 2:
            return {
                "query": text,
                "provider": NCBI_PROVIDER,
                "species": [],
                "total_count": 0,
                "next_page_token": "",
            }

        source_filter = str(assembly_source or "all").strip().lower() or "all"
        bounded_page_size = max(1, min(int(page_size or 100), 200))
        base_payload = {
            "filters": {
                "has_annotation": True,
                "assembly_version": "current",
                "assembly_source": source_filter,
            },
            "page_size": bounded_page_size,
            "returned_content": "COMPLETE",
        }

        payloads: List[Dict[str, Any]] = []
        if re.match(r"^GC[AF]_\d+(?:\.\d+)?$", text, flags=re.IGNORECASE):
            payloads.append({
                **base_payload,
                "accessions": [text.upper()],
            })
        else:
            # NCBI's POST dataset_report endpoint reliably resolves organism/common-name
            # searches when passed via `taxons`, and assembly-name searches via
            # `assembly_names`. The documented `filters.search_text` field did not return
            # results in live testing for common queries like "human", so we use these
            # explicit search channels and merge the results.
            payloads.extend([
                {
                    **base_payload,
                    "taxons": [text],
                },
                {
                    **base_payload,
                    "assembly_names": [text],
                },
            ])

        merged_reports: List[Dict[str, Any]] = []
        seen_accessions: set[str] = set()
        for payload in payloads:
            response = self._post_ncbi_dataset_report(payload)
            for report in response.get("reports") or []:
                if not isinstance(report, dict):
                    continue
                accession = str(report.get("accession") or "").strip()
                if accession and accession in seen_accessions:
                    continue
                if accession:
                    seen_accessions.add(accession)
                merged_reports.append(report)

        response = {
            "reports": merged_reports,
            "total_count": len(merged_reports),
            "next_page_token": "",
        }
        species = self._build_ncbi_species_summaries(response)
        return {
            "query": text,
            "provider": NCBI_PROVIDER,
            "species": species,
            "total_count": int(response.get("total_count") or 0),
            "next_page_token": str(response.get("next_page_token") or "").strip(),
        }

    def list_featured_ncbi_species(self, assembly_source: str = "all") -> Dict[str, Any]:
        source_filter = str(assembly_source or "all").strip().lower() or "all"
        payload = {
            "accessions": list(NCBI_FEATURED_ACCESSIONS),
            "filters": {
                "has_annotation": True,
                "assembly_version": "current",
                "assembly_source": source_filter,
                "exclude_paired_reports": True,
            },
            "page_size": max(20, len(NCBI_FEATURED_ACCESSIONS)),
            "returned_content": "COMPLETE",
        }

        response = self._post_ncbi_dataset_report(payload)
        species = self._build_ncbi_species_summaries(response)
        return {
            "query": "",
            "provider": NCBI_PROVIDER,
            "species": species,
            "total_count": int(response.get("total_count") or len(species)),
            "next_page_token": str(response.get("next_page_token") or "").strip(),
        }

    def list_species(
        self,
        provider: str = DEFAULT_PROVIDER,
        group: Optional[str] = None,
        sub_group: Optional[str] = None,
    ) -> List[SpeciesSummary]:
        if str(provider or DEFAULT_PROVIDER).strip().lower() == NCBI_PROVIDER:
            result = list(self._fetch_ncbi_species_catalog("refseq"))
            normalized_group = str(group or "").strip()
            featured_accessions = set(NCBI_FEATURED_ACCESSIONS)

            def filter_featured(entries: List[SpeciesSummary]) -> List[SpeciesSummary]:
                filtered: List[SpeciesSummary] = []
                for species in entries:
                    matching_assemblies = [
                        assembly for assembly in (species.assemblies or [])
                        if str(getattr(assembly, "accession", getattr(assembly, "gca", ""))).strip() in featured_accessions
                    ]
                    if matching_assemblies:
                        filtered.append(species.model_copy(update={"assemblies": matching_assemblies}))
                return filtered

            if normalized_group and normalized_group not in {"All", "All genomes"}:
                if normalized_group == "Featured":
                    result = filter_featured(result)
                elif normalized_group == "Vertebrates":
                    result = [s for s in result if s.group in {"Mammals", "Fish", "Birds", "Reptiles", "Amphibians"}]
                elif normalized_group == "Invertebrates":
                    result = [s for s in result if s.group in {"Insects", "Nematodes"}]
                elif normalized_group == "Microbes":
                    result = [s for s in result if s.group in {"Bacteria", "Archaea"}]
                else:
                    result = [s for s in result if s.group == normalized_group]

            if sub_group:
                result = [s for s in result if s.sub_group == sub_group]
            return result
        if self._species_cache is None:
            self._build_cache()
        result = self._species_cache
        if group and group != "All":
            if group == "Projects":
                requested_project = str(sub_group or "").strip()
                filtered: List[SpeciesSummary] = []
                for species in result:
                    matching_assemblies = [
                        assembly for assembly in (species.assemblies or [])
                        if (
                            requested_project
                            and requested_project in (getattr(assembly, "projects", []) or [])
                        ) or (
                            not requested_project
                            and len(getattr(assembly, "projects", []) or []) > 0
                        )
                    ]
                    if matching_assemblies:
                        filtered.append(species.model_copy(update={"assemblies": matching_assemblies}))
                return filtered
            result = [s for s in result if s.group == group]
        if sub_group:
            result = [s for s in result if s.sub_group == sub_group]
        return result

    def _build_app_species_summaries(self) -> List[SpeciesSummary]:
        summaries = []
        diagnostics = self._empty_taxonomy_classification_diagnostics()
        for key, info in self.species_data.items():
            assemblies_raw = info.get("assemblies", {})
            assemblies = [
                AssemblySummary(
                    accession=gca,
                    gca=gca,
                    name=asm_data.get("name", gca),
                    level=asm_data.get("level", ""),
                    provider=DEFAULT_PROVIDER,
                    source_database="Ensembl",
                    projects=self._projects_for_assembly(gca, asm_data),
                )
                for gca, asm_data in assemblies_raw.items()
            ]
            classification = self._classify_species_for_download(
                info.get("scientific_name", ""),
                info.get("common_name", ""),
                info.get("taxid", 0),
                info.get("species_taxonomy_id", 0),
            )
            self._record_taxonomy_classification(diagnostics, classification)
            summaries.append(SpeciesSummary(
                key=key,
                scientific_name=info.get("scientific_name", key),
                common_name=info.get("common_name") or "",
                taxid=info.get("taxid", 0),
                species_taxonomy_id=info.get("species_taxonomy_id", 0),
                group=classification.group,
                sub_group=classification.sub_group,
                assemblies=assemblies,
                provider=DEFAULT_PROVIDER,
            ))
        summaries.sort(key=lambda s: (s.scientific_name.lower()))
        self.taxonomy_classification_diagnostics = diagnostics
        return summaries

    def _build_cache(self):
        summaries = self._build_app_species_summaries()
        if not self._policy_matches_current_catalog(self.species_name_policy):
            self.refresh_species_name_policy(include_ncbi=False, force=True, app_summaries=summaries)
        self._species_cache = self._apply_species_display_names(summaries)

    # ------------------------------------------------------------------
    # RefSeq group browsing
    # ------------------------------------------------------------------

    def _fetch_ncbi_group_counts(self) -> List[GroupCount]:
        """Return group counts for RefSeq browse groups using lightweight count queries."""
        cached = self._ncbi_group_count_cache
        if cached and (time.time() - cached.get("fetched_at", 0)) < NCBI_REFSEQ_CACHE_TTL_SECONDS:
            return cached["groups"]

        def count_one(group_name: str) -> int:
            taxon_id = NCBI_TAXON_GROUPS.get(group_name)
            if not taxon_id:
                return 0
            payload = {
                "taxons": [taxon_id],
                "filters": {
                    "has_annotation": True,
                    "assembly_version": "current",
                    "assembly_source": "refseq",
                },
                "page_size": 1,
                "returned_content": "COMPLETE",
            }
            try:
                return int(self._post_ncbi_dataset_report(payload).get("total_count") or 0)
            except Exception:
                return 0

        vertebrate_names = ["Mammals", "Fish", "Birds", "Reptiles", "Amphibians"]
        invertebrate_names = ["Insects", "Nematodes"]
        toplevel_names = ["Plants", "Fungi", "Bacteria", "Archaea"]
        all_names = vertebrate_names + invertebrate_names + toplevel_names

        counts: Dict[str, int] = {}
        for i, name in enumerate(all_names):
            counts[name] = count_one(name)
            if i < len(all_names) - 1:
                time.sleep(0.4)

        total_count = sum(counts.values())
        featured_count = len(NCBI_FEATURED_ACCESSIONS)

        groups: List[GroupCount] = [
            GroupCount(name="All genomes", count=total_count, sub_groups=[]),
            GroupCount(name="Featured", count=featured_count, sub_groups=[]),
            GroupCount(
                name="Vertebrates",
                count=sum(counts.get(n, 0) for n in vertebrate_names),
                sub_groups=[{"name": n, "count": counts.get(n, 0)} for n in vertebrate_names],
            ),
            GroupCount(
                name="Invertebrates",
                count=sum(counts.get(n, 0) for n in invertebrate_names),
                sub_groups=[{"name": n, "count": counts.get(n, 0)} for n in invertebrate_names],
            ),
        ]
        for name in toplevel_names:
            groups.append(GroupCount(name=name, count=counts.get(name, 0), sub_groups=[]))

        self._ncbi_group_count_cache = {"groups": groups, "fetched_at": time.time()}
        return groups

    def browse_ncbi_group(
        self,
        group: str = "Featured",
        page_token: Optional[str] = None,
        page_size: int = 100,
    ) -> Dict[str, Any]:
        """Return a paginated list of RefSeq species for the given group."""
        group = str(group or "Featured").strip()
        if group == "Featured":
            result = self.list_featured_ncbi_species(assembly_source="refseq")
            return {
                "group": group,
                "provider": NCBI_PROVIDER,
                "species": result["species"],
                "total_count": len(result["species"]),
                "next_page_token": None,
            }

        taxon_id = NCBI_TAXON_GROUPS.get(group)
        aggregate_taxons = NCBI_AGGREGATE_GROUPS.get(group)
        all_taxons = list(NCBI_TAXON_GROUPS.values()) if group == "All genomes" else None
        if not taxon_id and not aggregate_taxons and not all_taxons:
            return {"group": group, "provider": NCBI_PROVIDER, "species": [], "total_count": 0, "next_page_token": None}

        payload: Dict[str, Any] = {
            "taxons": all_taxons if all_taxons else ([taxon_id] if taxon_id else list(aggregate_taxons or [])),
            "filters": {
                "has_annotation": True,
                "assembly_version": "current",
                "assembly_source": "refseq",
            },
            "page_size": min(int(page_size or 100), 200),
            "returned_content": "COMPLETE",
        }
        if page_token:
            payload["page_token"] = str(page_token).strip()

        response = self._post_ncbi_dataset_report(payload)
        # For leaf taxon groups (e.g. "Fungi", "Plants") pass the group name as an
        # override so species.group matches the sidebar category name used for
        # client-side filtering.  Aggregate groups (Vertebrates, Invertebrates,
        # Microbes) intentionally keep individual classified group names so the
        # frontend Set-based filters work correctly.
        override = group if taxon_id else None
        species = self._build_ncbi_species_summaries(response, group_override=override)
        return {
            "group": group,
            "provider": NCBI_PROVIDER,
            "species": species,
            "total_count": int(response.get("total_count") or len(species)),
            "next_page_token": str(response.get("next_page_token") or "").strip() or None,
        }

    def refresh_ncbi_cache(self) -> Dict[str, Any]:
        """Clear cached RefSeq browse metadata so the next request fetches fresh values."""
        self._ncbi_group_count_cache = {}
        self._ncbi_species_cache = {}
        self._ncbi_species_list_cache = {}
        return {
            "provider": NCBI_PROVIDER,
            "refreshed_at": datetime.utcnow().isoformat() + "Z",
        }

    def list_groups(self, provider: str = DEFAULT_PROVIDER) -> List[GroupCount]:
        """Return available groups with species counts."""
        if str(provider or DEFAULT_PROVIDER).strip().lower() == NCBI_PROVIDER:
            try:
                return self._fetch_ncbi_group_counts()
            except Exception:
                return []
        if self._species_cache is None:
            self._build_cache()

        from collections import defaultdict
        group_sub: Dict[str, Counter] = defaultdict(Counter)
        for s in self._species_cache:
            group_sub[s.group][s.sub_group or ""] += 1

        results = []
        for g in DOWNLOAD_GROUP_ORDER:
            if g not in group_sub:
                continue
            sub_counts = group_sub[g]
            total = sum(sub_counts.values())
            sub_groups = [
                {"name": sg, "count": c}
                for sg, c in _ordered_sub_group_items(g, sub_counts)
                if sg
            ]
            results.append(GroupCount(name=g, count=total, sub_groups=sub_groups))

        # Add any groups not in the order
        for g, sub_counts in group_sub.items():
            if g not in DOWNLOAD_GROUP_ORDER:
                total = sum(sub_counts.values())
                sub_groups = [
                    {"name": sg, "count": c}
                    for sg, c in _ordered_sub_group_items(g, sub_counts)
                    if sg
                ]
                results.append(GroupCount(name=g, count=total, sub_groups=sub_groups))

        project_counts: Counter = Counter()
        project_accessions = set()
        for species in self._species_cache:
            for assembly in species.assemblies or []:
                accession = str(getattr(assembly, "accession", "") or getattr(assembly, "gca", "") or "").strip()
                projects = [str(value).strip() for value in (getattr(assembly, "projects", []) or []) if str(value).strip()]
                if projects and accession:
                    project_accessions.add(accession)
                for project in projects:
                    project_counts[project] += 1
        if project_counts:
            ordered_projects = [
                {"name": code, "count": int(project_counts.get(code) or 0)}
                for code in PROJECT_ORDER
                if int(project_counts.get(code) or 0) > 0
            ]
            ordered_projects.extend(
                {"name": code, "count": count}
                for code, count in sorted(project_counts.items())
                if code not in PROJECT_ORDER
            )
            results.append(GroupCount(name="Projects", count=len(project_accessions), sub_groups=ordered_projects))

        return results

    def get_species_details(self, key: str, provider: str = DEFAULT_PROVIDER) -> Optional[Dict]:
        if str(provider or DEFAULT_PROVIDER).strip().lower() == NCBI_PROVIDER:
            summary = self._ncbi_species_cache.get(str(key or "").strip())
            return summary.model_dump() if summary else None
        raw = self.species_data.get(key)
        if not isinstance(raw, dict):
            return raw
        if self._species_cache is None:
            self._build_cache()
        summary = next((item for item in self._species_cache or [] if item.key == key), None)
        payload = json.loads(json.dumps(raw))
        if summary:
            payload["display_name"] = summary.display_name
            payload["display_name_reason"] = summary.display_name_reason
        return payload

    def _is_fasta_name(self, token: str) -> bool:
        lower = str(token or "").strip().lower()
        return lower.endswith((
            ".fa", ".fna", ".fasta",
            ".fa.gz", ".fna.gz", ".fasta.gz",
            ".fa.bgz", ".fna.bgz", ".fasta.bgz",
        ))

    def _score_fasta_candidate(self, name: str, path: str) -> int:
        probe = f"{str(name or '').lower()} {str(path or '').lower()}"
        if "softmask" in probe or "softmasked" in probe:
            return 0
        if "unmask" in probe or "unmasked" in probe:
            return 1
        return 2

    def _release_label(self, source: str, release_date: str) -> str:
        src = str(source or "").strip() or "ensembl"
        date = str(release_date or "").strip() or "unknown"
        if src == NCBI_PROVIDER:
            return "RefSeq current" if date == "current" else f"RefSeq {date}"
        return f"{src} {date}"

    def _release_key(self, source: str, release_date: str) -> str:
        src = re.sub(r"[^A-Za-z0-9._-]+", "_", str(source or "").strip() or "ensembl")
        date = re.sub(r"[^A-Za-z0-9._-]+", "_", str(release_date or "").strip() or "unknown")
        return f"{src}/{date}"

    def _file_info_from_path(
        self,
        path: str,
        file_type: str,
        provider: str = DEFAULT_PROVIDER,
        scope: str = "dataset",
        dataset_release_source: str = "",
        dataset_release_date: str = "",
        selected_by_default: bool = False,
        is_index: bool = False,
        parent_type: str = "",
    ) -> FileInfo:
        release_key = self._release_key(dataset_release_source, dataset_release_date) if scope == "dataset" else ""
        return FileInfo(
            url=ENSEMBL_FTP_BASE + str(path or "").lstrip("/"),
            filename=str(path or "").rstrip("/").split("/")[-1],
            type=file_type,
            provider=provider,
            scope=scope,
            dataset_release_key=release_key,
            dataset_release_source=str(dataset_release_source or ""),
            dataset_release_date=str(dataset_release_date or ""),
            dataset_release_label=self._release_label(dataset_release_source, dataset_release_date) if scope == "dataset" else "",
            selected_by_default=selected_by_default,
            is_index=is_index,
            parent_type=parent_type,
        )

    def _classify_annotation_file(self, name: str, path: str) -> tuple:
        lower = f"{str(name or '').lower()} {str(path or '').lower()}"
        filename = str(name or path or "").split("/")[-1].lower()
        if filename.endswith((".gff3.bgz.csi", ".gff3.gz.tbi", ".gff3.csi", ".gff3.tbi")):
            return "gff3_index", True, "gff3"
        if filename.endswith((".gtf.bgz.csi", ".gtf.gz.tbi", ".gtf.csi", ".gtf.tbi")):
            return "gtf_index", True, "gtf"
        if filename.endswith((".fa.bgz.fai", ".fa.gz.fai", ".fa.fai", ".fa.bgz.gzi", ".fa.gz.gzi")) and "cdna" in lower:
            return "cdna_index", True, "cdna"
        if filename.endswith((".fa.bgz.fai", ".fa.gz.fai", ".fa.fai", ".fa.bgz.gzi", ".fa.gz.gzi")) and ("pep" in lower or "protein" in lower):
            return "protein_index", True, "protein"
        if filename.endswith(SIDE_CAR_SUFFIXES):
            if "xref" in lower:
                return "xref_index", True, "xref"
            return "other", True, ""
        if filename in {"genes.gff3.gz", "genes.gff3.bgz"} or filename.endswith((".gff3.gz", ".gff3.bgz", ".gff3")):
            return "gff3", False, ""
        if filename.startswith("cdna") and self._is_fasta_name(filename):
            return "cdna", False, ""
        if (filename.startswith("pep") or "protein" in filename) and self._is_fasta_name(filename):
            return "protein", False, ""
        if filename == "xref.tsv.gz" or filename.endswith(".xref.tsv.gz") or "xref" in filename:
            return "xref", False, ""
        if filename.endswith((".gtf.gz", ".gtf.bgz", ".gtf")):
            return "gtf", False, ""
        if filename.endswith((".embl.gz", ".embl")):
            return "embl", False, ""
        return "other_annotation", False, ""

    def _default_gff3_filename(self, files: List[FileInfo]) -> str:
        gff3s = [item for item in files if item.type == "gff3"]
        if not gff3s:
            return ""
        preferred = sorted(
            gff3s,
            key=lambda item: (
                Path(item.filename).name != "genes.gff3.gz",
                Path(item.filename).name != "genes.gff3.bgz",
                item.filename,
            ),
        )
        return preferred[0].filename

    def _fetch_ftp_directory_entries(self, directory_url: str) -> List[str]:
        now = time.time()
        cached = self._ftp_directory_cache.get(directory_url)
        if cached and now - float(cached.get("fetched_at") or 0) < FTP_DIRECTORY_CACHE_TTL_SECONDS:
            entries = cached.get("entries")
            if isinstance(entries, list):
                return list(entries)
            return list(cached.get("files") or [])
        response = get_with_validated_redirects(directory_url, validate_remote_download_url, timeout=12)
        response.raise_for_status()
        hrefs = re.findall(r'href=["\']([^"\']+)["\']', response.text or "", flags=re.IGNORECASE)
        entries = []
        for href in hrefs:
            token = str(href or "").strip()
            if not token or token.startswith("?") or token.startswith("../"):
                continue
            if "/" in token.rstrip("/"):
                continue
            entries.append(token)
        deduped = sorted(set(entries))
        self._ftp_directory_cache[directory_url] = {"fetched_at": now, "entries": deduped}
        return deduped

    def _fetch_ftp_directory_files(self, directory_url: str) -> List[str]:
        return [entry for entry in self._fetch_ftp_directory_entries(directory_url) if not entry.endswith("/")]

    def _resolve_live_homology_url(self, url: str) -> str:
        """Resolve stale catalogue homology-export dates from the live FTP listing.

        Genome annotation releases and homology exports are published on separate
        schedules. The catalogue can therefore retain a no-longer-present dated
        homology directory even when the geneset files for that release remain
        available.
        """
        match = re.match(r"^(.*?/homology/)([^/]+)/([^/]+)$", str(url or ""))
        if not match:
            return url
        homology_root, catalog_date, filename = match.groups()
        try:
            available_dates = [
                entry.rstrip("/")
                for entry in self._fetch_ftp_directory_entries(homology_root)
                if entry.endswith("/")
            ]
        except Exception:
            return url
        if not available_dates:
            return url

        candidate_dates = ([catalog_date] if catalog_date in available_dates else []) + [
            date for date in sorted(available_dates, reverse=True) if date != catalog_date
        ]
        for export_date in candidate_dates:
            try:
                available_files = self._fetch_ftp_directory_files(f"{homology_root}{export_date}/")
            except Exception:
                continue
            chosen_filename = filename if filename in available_files else next(
                (name for name in available_files if name.lower().endswith(".tsv.gz")),
                "",
            )
            if not chosen_filename:
                continue
            return f"{homology_root}{export_date}/{chosen_filename}"
        return url

    def _augment_release_with_directory_listing(self, release_files: List[FileInfo]) -> List[FileInfo]:
        existing_urls = {item.url for item in release_files}
        directories: Dict[str, FileInfo] = {}
        for item in release_files:
            if item.url:
                directories.setdefault(item.url.rsplit("/", 1)[0] + "/", item)
        augmented = list(release_files)
        for directory_url, template in directories.items():
            try:
                for filename in self._fetch_ftp_directory_files(directory_url):
                    path = directory_url.replace(ENSEMBL_FTP_BASE, "", 1) + filename
                    url = ENSEMBL_FTP_BASE + path
                    if url in existing_urls:
                        continue
                    file_type, is_index, parent_type = self._classify_annotation_file(filename, path)
                    if file_type == "other_annotation" and not is_index:
                        continue
                    augmented.append(self._file_info_from_path(
                        path,
                        file_type=file_type,
                        provider=template.provider,
                        scope="dataset",
                        dataset_release_source=template.dataset_release_source,
                        dataset_release_date=template.dataset_release_date,
                        is_index=is_index,
                        parent_type=parent_type,
                    ))
                    existing_urls.add(url)
            except Exception:
                continue
        return augmented

    def _release_directory_url_from_files(
        self,
        release_files: List[FileInfo],
        provider_key: str,
        release_date: str,
    ) -> str:
        marker = f"/{str(provider_key or '').strip()}/{str(release_date or '').strip()}/"
        for item in release_files:
            url = str(item.url or "")
            if marker and marker in url:
                return url[:url.index(marker) + len(marker)]
        for item in release_files:
            url = str(item.url or "")
            if "/" in url:
                return url.rsplit("/", 1)[0] + "/"
        return ""

    def get_file_availability(
        self,
        species_key: str,
        assembly: str,
        provider: str = DEFAULT_PROVIDER,
        include_directory_listing: bool = False,
    ) -> Dict[str, Any]:
        normalized_provider = str(provider or DEFAULT_PROVIDER).strip().lower() or DEFAULT_PROVIDER
        if normalized_provider == NCBI_PROVIDER:
            files = self._get_ncbi_download_urls(species_key, assembly, file_types=["fasta", "gff3", "metadata"])
            for item in files:
                item.scope = "assembly" if item.type in ASSEMBLY_FILE_TYPES else "dataset"
                item.selected_by_default = item.type in {"fasta", "gff3"}
                if item.scope == "dataset":
                    item.dataset_release_key = "ncbi/current"
                    item.dataset_release_source = NCBI_PROVIDER
                    item.dataset_release_date = "current"
                    item.dataset_release_label = "RefSeq current"
            return {
                "provider": NCBI_PROVIDER,
                "species_key": species_key,
                "assembly": assembly,
                "assembly_files": [item.model_dump() for item in files if item.scope == "assembly"],
                "dataset_releases": [{
                    "key": "ncbi/current",
                    "source": NCBI_PROVIDER,
                    "date": "current",
                    "label": "RefSeq current",
                    "is_default": True,
                    "files": [item.model_dump() for item in files if item.scope == "dataset"],
                }],
                "default_dataset_release_key": "ncbi/current",
            }

        species = self.species_data.get(species_key)
        asm_data = (species or {}).get("assemblies", {}).get(assembly)
        if not asm_data:
            return {
                "provider": DEFAULT_PROVIDER,
                "species_key": species_key,
                "assembly": assembly,
                "assembly_files": [],
                "dataset_releases": [],
                "default_dataset_release_key": "",
            }

        assembly_files: List[FileInfo] = []
        genome_seqs = (asm_data.get("assembly", {}).get("files", {}).get("genome_sequences", {}))
        fasta_candidates: List[tuple] = []
        for raw_name, raw_path in (genome_seqs or {}).items():
            name = str(raw_name or "").strip()
            path = str(raw_path or "").strip()
            if path and (self._is_fasta_name(name) or self._is_fasta_name(path)):
                fasta_candidates.append((self._score_fasta_candidate(name, path), name, path))
        if fasta_candidates:
            fasta_candidates.sort(key=lambda item: (item[0], item[1], item[2]))
            default_fasta_path = fasta_candidates[0][2]
            for _, _, path in fasta_candidates:
                assembly_files.append(self._file_info_from_path(
                    path,
                    file_type="fasta",
                    provider=DEFAULT_PROVIDER,
                    scope="assembly",
                    selected_by_default=(path == default_fasta_path),
                ))

        try:
            meta_file = self._get_metadata_file_info(assembly)
            if meta_file:
                meta_file.scope = "assembly"
                meta_file.selected_by_default = False
                assembly_files.append(meta_file)
        except Exception:
            pass

        dataset_releases: List[Dict[str, Any]] = []
        providers = asm_data.get("genebuild_providers", {}) or {}
        provider_order = (["ensembl"] if "ensembl" in providers else []) + [
            key for key in sorted(providers.keys()) if key != "ensembl"
        ]
        for provider_key in provider_order:
            provider_data = providers.get(provider_key, {}) or {}
            for release_date in sorted(provider_data.keys(), reverse=True):
                build_data = provider_data.get(release_date) or {}
                release_files: List[FileInfo] = []
                annotations = (build_data.get("paths", {})
                               .get("genebuild", {})
                               .get("files", {})
                               .get("annotations", {}))
                for name, path in (annotations or {}).items():
                    path = str(path or "").strip()
                    if not path:
                        continue
                    file_type, is_index, parent_type = self._classify_annotation_file(str(name or ""), path)
                    release_files.append(self._file_info_from_path(
                        path,
                        file_type=file_type,
                        provider=DEFAULT_PROVIDER,
                        scope="dataset",
                        dataset_release_source=provider_key,
                        dataset_release_date=release_date,
                        is_index=is_index,
                        parent_type=parent_type,
                    ))
                homology_data = (build_data.get("paths", {})
                                 .get("homologies", {})
                                 .get("files", {})
                                 .get("homology_data", {}))
                for _, path in (homology_data or {}).items():
                    path = str(path or "").strip()
                    if path.endswith(".tsv.gz"):
                        release_files.append(self._file_info_from_path(
                            path,
                            file_type="homology",
                            provider=DEFAULT_PROVIDER,
                            scope="dataset",
                            dataset_release_source=provider_key,
                            dataset_release_date=release_date,
                        ))
                if include_directory_listing:
                    release_files = self._augment_release_with_directory_listing(release_files)

                default_gff = self._default_gff3_filename(release_files)
                for item in release_files:
                    if item.type == "gff3":
                        item.selected_by_default = bool(default_gff and item.filename == default_gff)
                    elif item.type in {"homology", "cdna", "protein", "xref"}:
                        item.selected_by_default = True
                    else:
                        item.selected_by_default = False

                dataset_releases.append({
                    "key": self._release_key(provider_key, release_date),
                    "source": provider_key,
                    "date": release_date,
                    "label": self._release_label(provider_key, release_date),
                    "directory_url": self._release_directory_url_from_files(release_files, provider_key, release_date),
                    "is_default": False,
                    "files": [item.model_dump() for item in release_files],
                })

        alignment_files = self._get_pairwise_alignment_file_infos(species_key, assembly, species, asm_data)
        if alignment_files:
            release = alignment_files[0]
            dataset_releases.append({
                "key": release.dataset_release_key,
                "source": release.dataset_release_source,
                "date": release.dataset_release_date,
                "label": release.dataset_release_label or PAIRWISE_ALIGNMENT_RELEASE_LABEL,
                "directory_url": PAIRWISE_ALIGNMENT_DIRECTORY_URL,
                "is_default": False,
                "files": [item.model_dump() for item in alignment_files],
            })

        if dataset_releases:
            dataset_releases[0]["is_default"] = True
        return {
            "provider": DEFAULT_PROVIDER,
            "species_key": species_key,
            "assembly": assembly,
            "assembly_files": [item.model_dump() for item in assembly_files],
            "dataset_releases": dataset_releases,
            "default_dataset_release_key": dataset_releases[0]["key"] if dataset_releases else "",
        }

    def _get_ensembl_download_urls(
        self,
        species_key: str,
        assembly: str,
        file_types: Optional[List[str]] = None,
    ) -> List[FileInfo]:
        """
        Extract relevant file URLs for a given species/assembly.
        file_types: subset of available file types. None = default core types.
        """
        want = set(file_types) if file_types else {"fasta", "gff3", "homology", "metadata"}
        availability = self.get_file_availability(species_key, assembly, provider=DEFAULT_PROVIDER)
        selected: List[FileInfo] = []

        for raw in availability.get("assembly_files") or []:
            item = FileInfo(**raw)
            if item.type not in want:
                continue
            if item.type == "fasta" and any(existing.type == "fasta" for existing in selected):
                continue
            if item.type == "fasta" and not item.selected_by_default:
                continue
            selected.append(item)

        default_release_key = availability.get("default_dataset_release_key") or ""
        release = next(
            (entry for entry in availability.get("dataset_releases") or [] if entry.get("key") == default_release_key),
            None,
        )
        chosen_types = set()
        if release:
            for raw in release.get("files") or []:
                item = FileInfo(**raw)
                if item.type not in want:
                    continue
                if item.type in chosen_types and item.type in {"gff3", "cdna", "protein", "xref"}:
                    continue
                if item.type == "gff3" and not item.selected_by_default:
                    continue
                selected.append(item)
                chosen_types.add(item.type)
        return selected

    def _get_ncbi_download_urls(
        self,
        species_key: str,
        assembly: str,
        file_types: Optional[List[str]] = None,
    ) -> List[FileInfo]:
        want = set(file_types) if file_types else {"fasta", "gff3", "metadata"}
        accession = str(assembly or "").strip()
        if not accession:
            return []

        files: List[FileInfo] = []

        # Use a separate dehydrated bundle per file type so each download task
        # only fetches the entries it needs.  A combined bundle would cause the
        # GFF3 task to stream the entire FASTA from NCBI FTP before touching the
        # GFF3 — multiplying download time needlessly.
        if "fasta" in want:
            fasta_params = [
                ("include_annotation_type", "GENOME_FASTA"),
                ("hydrated", "DATA_REPORT_ONLY"),
                ("filename", "ncbi_dataset.zip"),
            ]
            files.append(
                FileInfo(
                    url=f"{NCBI_DATASETS_API_BASE}/genome/accession/{quote(accession)}/download?{urlencode(fasta_params)}",
                    filename="ncbi_dataset_fasta.zip",
                    type="fasta",
                    provider=NCBI_PROVIDER,
                    scope="assembly",
                    selected_by_default=True,
                )
            )
        if "gff3" in want:
            gff_params = [
                ("include_annotation_type", "GENOME_GFF"),
                ("hydrated", "DATA_REPORT_ONLY"),
                ("filename", "ncbi_dataset.zip"),
            ]
            files.append(
                FileInfo(
                    url=f"{NCBI_DATASETS_API_BASE}/genome/accession/{quote(accession)}/download?{urlencode(gff_params)}",
                    filename="ncbi_dataset_gff3.zip",
                    type="gff3",
                    provider=NCBI_PROVIDER,
                    scope="dataset",
                    dataset_release_key="ncbi/current",
                    dataset_release_source=NCBI_PROVIDER,
                    dataset_release_date="current",
                    dataset_release_label="RefSeq current",
                    selected_by_default=True,
                )
            )

        if "metadata" in want:
            metadata_url = f"{NCBI_DATASETS_API_BASE}/genome/accession/{quote(accession)}/sequence_reports?page_size=1000"
            files.append(
                FileInfo(
                    url=metadata_url,
                    filename=f"{accession}.sequence_report.json",
                    type="metadata",
                    provider=NCBI_PROVIDER,
                    scope="assembly",
                )
            )
        return files

    def get_download_urls(
        self,
        species_key: str,
        assembly: str,
        file_types: Optional[List[str]] = None,
        provider: str = DEFAULT_PROVIDER,
    ) -> List[FileInfo]:
        normalized_provider = str(provider or DEFAULT_PROVIDER).strip().lower() or DEFAULT_PROVIDER
        if normalized_provider == NCBI_PROVIDER:
            return self._get_ncbi_download_urls(species_key, assembly, file_types=file_types)
        return self._get_ensembl_download_urls(species_key, assembly, file_types=file_types)

    def _extract_ncbi_bundle(self, bundle_path: Path, assembly_dir: Path, assembly: str) -> Dict[str, str]:
        def _prefixed_name(member_name: str) -> str:
            base = Path(member_name).name
            if not base:
                return base
            if base.lower().startswith(str(assembly or "").strip().lower()):
                return base
            return f"{assembly}.{base}"

        def _choose_member(kind: str, members: List[str]) -> Optional[str]:
            candidates: List[str] = []
            for member in members:
                lower = member.lower()
                if kind == "fasta":
                    if not lower.endswith((".fna", ".fa", ".fasta", ".fna.gz", ".fa.gz", ".fasta.gz")):
                        continue
                    if any(token in lower for token in ("/cds_", "/rna_", "/protein_", "protein.faa", "cds_from_", "rna_from_")):
                        continue
                elif kind == "gff3":
                    if not lower.endswith((".gff", ".gff3", ".gff.gz", ".gff3.gz")):
                        continue
                elif kind == "metadata":
                    if "sequence_report" not in lower:
                        continue
                    if not lower.endswith((".json", ".jsonl", ".tsv", ".tsv.gz")):
                        continue
                else:
                    continue
                candidates.append(member)

            if not candidates:
                return None
            candidates.sort(
                key=lambda member: (
                    0 if "/data/" in member.lower() else 1,
                    0 if "genomic" in member.lower() else 1,
                    len(member),
                    member.lower(),
                )
            )
            return candidates[0]

        extracted: Dict[str, str] = {}
        with zipfile.ZipFile(bundle_path) as archive:
            members = [info.filename for info in archive.infolist() if not info.is_dir()]
            selected = {
                "fasta": _choose_member("fasta", members),
                "gff3": _choose_member("gff3", members),
                "metadata": _choose_member("metadata", members),
            }
            for kind, member in selected.items():
                if not member:
                    continue
                destination = assembly_dir / _prefixed_name(member)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as src, open(destination, "wb") as handle:
                    shutil.copyfileobj(src, handle)
                extracted[kind] = str(destination)
        return extracted

    def _parse_ncbi_fetch_entries(self, bundle_path: Path) -> List[Dict[str, str]]:
        catalog_sizes: Dict[str, int] = {}

        def _normalize_catalog_path(value: str) -> str:
            path = str(value or "").strip().replace("\\", "/").lstrip("/")
            if path.startswith("data/"):
                path = path[5:]
            return path

        def _infer_kind(relative_path: str) -> Optional[str]:
            lower = str(relative_path or "").strip().lower()
            if not lower:
                return None
            if "sequence_report" in lower and lower.endswith((".json", ".jsonl", ".tsv", ".tsv.gz")):
                return "metadata"
            if lower.endswith((".gff", ".gff3", ".gff.gz", ".gff3.gz")):
                return "gff3"
            if lower.endswith((".fna", ".fa", ".fasta", ".fna.gz", ".fa.gz", ".fasta.gz")):
                if any(token in lower for token in ("/rna", "/cds", "/protein", "protein.faa", "cds_from_", "rna_from_")):
                    return None
                return "fasta"
            return None

        try:
            with zipfile.ZipFile(bundle_path) as archive:
                try:
                    catalog_payload = json.loads(archive.read("ncbi_dataset/data/dataset_catalog.json").decode("utf-8"))
                    for assembly in catalog_payload.get("assemblies") or []:
                        if not isinstance(assembly, dict):
                            continue
                        for file_entry in assembly.get("files") or []:
                            if not isinstance(file_entry, dict):
                                continue
                            file_path = _normalize_catalog_path(file_entry.get("filePath") or "")
                            if not file_path:
                                continue
                            try:
                                catalog_sizes[file_path] = int(file_entry.get("uncompressedLengthBytes") or 0)
                            except Exception:
                                catalog_sizes[file_path] = 0
                except Exception:
                    catalog_sizes = {}
                try:
                    raw_fetch = archive.read("ncbi_dataset/fetch.txt").decode("utf-8")
                except KeyError:
                    return []
        except Exception:
            return []

        entries: List[Dict[str, str]] = []
        for line in raw_fetch.splitlines():
            parts = [str(part or "").strip() for part in line.split("\t")]
            if len(parts) < 3:
                continue
            remote_url = parts[0]
            relative_path = parts[-1]
            kind = _infer_kind(relative_path)
            if not remote_url or not relative_path or not kind:
                continue
            normalized_path = _normalize_catalog_path(relative_path)
            entries.append({
                "url": remote_url,
                "path": relative_path,
                "kind": kind,
                "expected_size": int(catalog_sizes.get(normalized_path) or 0),
            })
        return entries

    def _is_ncbi_datasets_api_url(self, url: str) -> bool:
        try:
            parsed = urlparse(str(url or "").strip())
        except Exception:
            return False
        return (
            parsed.scheme == "https"
            and (parsed.hostname or "").lower() == NCBI_DATASETS_API_HOST
            and (parsed.path or "").startswith(NCBI_DATASETS_API_PATH_PREFIX)
        )

    def _ncbi_api_delay_seconds(self) -> float:
        raw = os.environ.get("ENSEMBL_LOCAL_NCBI_API_DELAY_SECONDS", "")
        try:
            return max(0.0, float(raw)) if raw.strip() else NCBI_API_DEFAULT_DELAY_SECONDS
        except ValueError:
            return NCBI_API_DEFAULT_DELAY_SECONDS

    def _wait_for_ncbi_api_slot(self) -> None:
        delay = self._ncbi_api_delay_seconds()
        elapsed = time.monotonic() - self._ncbi_api_last_request_at
        if elapsed < delay:
            time.sleep(delay - elapsed)
        self._ncbi_api_last_request_at = time.monotonic()

    def _retry_after_seconds(self, response: Any) -> Optional[float]:
        raw = str(getattr(response, "headers", {}).get("Retry-After", "") or "").strip()
        if not raw:
            return None
        try:
            return max(0.0, float(raw))
        except ValueError:
            return None

    async def download_file(self, url: str, destination: Path, task_id: str):
        """Download a file with progress tracking, saving to a structured directory."""
        task = self.tasks[task_id]

        def _download_sync():
            temp_file = destination.with_suffix(destination.suffix + ".tmp")
            resolved_url = str(url or "").strip()

            def _is_cancelled() -> bool:
                return bool(getattr(task, "cancel_requested", False)) or str(task.status or "") == "canceled"

            def _raise_if_cancelled() -> None:
                if _is_cancelled():
                    raise DownloadCancelled("Canceled by user")

            def _unlink_quietly(path: Optional[Path]) -> None:
                if not path:
                    return
                try:
                    if path.exists():
                        path.unlink()
                except Exception:
                    pass

            try:
                max_download_bytes = int(os.environ.get("ENSEMBL_LOCAL_MAX_DOWNLOAD_BYTES", str(25 * 1024 * 1024 * 1024)))
            except ValueError:
                max_download_bytes = 25 * 1024 * 1024 * 1024
            try:
                _raise_if_cancelled()
                task.status = "downloading"
                task.warning = None
                destination.parent.mkdir(parents=True, exist_ok=True)

                def _download_once(
                    download_url: str,
                    target_path: Path,
                    progress_floor: float = 0.0,
                    progress_ceiling: float = 1.0,
                    expected_size: int = 0,
                ) -> None:
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    validate_remote_download_url(download_url)
                    is_ncbi_api_url = self._is_ncbi_datasets_api_url(download_url)

                    def _request_and_stream() -> None:
                        task.current_download_path = str(target_path)
                        try:
                            _raise_if_cancelled()
                            with get_with_validated_redirects(
                                download_url, validate_remote_download_url, stream=True, timeout=60
                            ) as response:
                                response.raise_for_status()
                                _raise_if_cancelled()
                                total_size = int(response.headers.get("content-length", 0))
                                if total_size > max_download_bytes:
                                    raise RuntimeError(
                                        f"Download is larger than the configured limit ({max_download_bytes} bytes)"
                                    )
                                content_encoding = str(response.headers.get("content-encoding") or "").strip().lower()
                                task.progress = progress_floor
                                downloaded = 0

                                with open(target_path, "wb") as f:
                                    for chunk in response.iter_content(chunk_size=65536):
                                        _raise_if_cancelled()
                                        if not chunk:
                                            continue
                                        f.write(chunk)
                                        downloaded += len(chunk)
                                        if downloaded > max_download_bytes:
                                            raise RuntimeError(
                                                f"Download exceeded the configured limit ({max_download_bytes} bytes)"
                                            )
                                        progress_size = total_size if total_size > 0 else int(expected_size or 0)
                                        if progress_size > 0:
                                            span = max(0.0, progress_ceiling - progress_floor)
                                            task.progress = progress_floor + min(1.0, (downloaded / progress_size)) * span

                            # Content-Length is only reliable for strict on-disk validation when
                            # transfer encoding is identity. Some hosts return compressed transfer
                            # content that requests transparently decodes, making byte counts differ.
                            enforce_exact_size = total_size > 0 and content_encoding in {"", "identity"}
                            if enforce_exact_size and downloaded != total_size:
                                raise RuntimeError(
                                    f"Download size mismatch for {target_path.name}: expected {total_size} bytes, got {downloaded}"
                                )
                        except DownloadCancelled:
                            _unlink_quietly(target_path)
                            raise
                        finally:
                            if task.current_download_path == str(target_path):
                                task.current_download_path = None

                    if is_ncbi_api_url:
                        with self._ncbi_api_download_lock:
                            _raise_if_cancelled()
                            self._wait_for_ncbi_api_slot()
                            _request_and_stream()
                    else:
                        _request_and_stream()

                    _raise_if_cancelled()
                    # Basic integrity check: gzip files should start with gzip magic bytes.
                    if target_path.suffix.lower() in {".gz", ".bgz"}:
                        with open(target_path, "rb") as fh:
                            magic = fh.read(2)
                        if magic != b"\x1f\x8b":
                            raise RuntimeError(f"Downloaded file is not valid gzip data: {target_path.name}")

                def _download_with_retries(
                    download_url: str,
                    target_path: Path,
                    progress_floor: float = 0.0,
                    progress_ceiling: float = 1.0,
                    expected_size: int = 0,
                    max_attempts: int = 3,
                ) -> None:
                    if self._is_ncbi_datasets_api_url(download_url):
                        max_attempts = max(max_attempts, 6)
                    last_error: Optional[Exception] = None
                    for attempt in range(max_attempts):
                        _raise_if_cancelled()
                        retry_delay: Optional[float] = None
                        try:
                            _download_once(
                                download_url,
                                target_path,
                                progress_floor=progress_floor,
                                progress_ceiling=progress_ceiling,
                                expected_size=expected_size,
                            )
                            return
                        except DownloadCancelled:
                            raise
                        except requests.HTTPError as exc:
                            response = getattr(exc, "response", None)
                            status_code = getattr(response, "status_code", None)
                            last_error = exc
                            if int(status_code or 0) == 429:
                                retry_delay = self._retry_after_seconds(response)
                            elif status_code and int(status_code) < 500:
                                raise
                        except requests.RequestException as exc:
                            last_error = exc
                        if target_path.exists():
                            try:
                                target_path.unlink()
                            except Exception:
                                pass
                        if attempt + 1 < max_attempts:
                            if retry_delay is None:
                                retry_delay = (
                                    NCBI_API_DEFAULT_429_DELAY_SECONDS
                                    if self._is_ncbi_datasets_api_url(download_url)
                                    else min(2 ** attempt, 3)
                                )
                            time.sleep(min(max(0.0, retry_delay), 60.0))
                    if last_error:
                        raise last_error

                if str(task.provider or "").strip().lower() == NCBI_PROVIDER and task.file_type in {"fasta", "gff3"}:
                    _download_with_retries(resolved_url, temp_file, 0.0, 0.05)
                    _raise_if_cancelled()
                    if not zipfile.is_zipfile(temp_file):
                        raise RuntimeError(f"NCBI bundle download did not produce a valid zip archive: {destination.name}")

                    fetch_entries = self._parse_ncbi_fetch_entries(temp_file)
                    if fetch_entries:
                        def _prefixed_name(relative_path: str) -> str:
                            base = Path(relative_path).name
                            if not base:
                                return base
                            if base.lower().startswith(str(task.assembly or "").strip().lower()):
                                return base
                            return f"{task.assembly}.{base}"

                        # Only download the file type this task was created for.
                        # A combined bundle would otherwise make the GFF3 task
                        # stream the entire FASTA before touching the GFF3.
                        relevant_entries = [entry for entry in fetch_entries if entry.get("kind") == (task.file_type or "")]
                        downloaded_files: Dict[str, str] = {}
                        total_entries = max(1, len(relevant_entries))
                        for index, entry in enumerate(relevant_entries):
                            _raise_if_cancelled()
                            target = destination.parent / _prefixed_name(entry.get("path") or "")
                            progress_floor = 0.05 + (0.95 * index / total_entries)
                            progress_ceiling = 0.05 + (0.95 * (index + 1) / total_entries)
                            _download_with_retries(
                                entry["url"],
                                target,
                                progress_floor,
                                progress_ceiling,
                                expected_size=int(entry.get("expected_size") or 0),
                            )
                            downloaded_files[str(entry.get("kind") or "")] = str(target)
                        try:
                            temp_file.unlink(missing_ok=True)
                        except Exception:
                            pass
                        requested_file = downloaded_files.get(task.file_type or "")
                        if not requested_file:
                            raise RuntimeError(f"NCBI data bundle did not contain a {task.file_type} file for {task.assembly}")
                        task.status = "completed"
                        task.progress = 1.0
                        return

                    extracted = self._extract_ncbi_bundle(temp_file, destination.parent, task.assembly)
                    try:
                        temp_file.unlink(missing_ok=True)
                    except Exception:
                        pass
                    requested_file = extracted.get(task.file_type or "")
                    if not requested_file:
                        raise RuntimeError(f"NCBI data bundle did not contain a {task.file_type} file for {task.assembly}")
                    task.status = "completed"
                    task.progress = 1.0
                    return

                try:
                    _download_with_retries(resolved_url, temp_file)
                except requests.HTTPError as http_err:
                    status_code = getattr(getattr(http_err, "response", None), "status_code", None)
                    if task.file_type == "homology" and int(status_code or 0) == 404:
                        fallback_url = self._resolve_live_homology_url(resolved_url)
                        if fallback_url and fallback_url != resolved_url:
                            _download_with_retries(fallback_url, temp_file)
                            task.warning = "Catalogue homology export date was stale; downloaded the live FTP export instead."
                            task.url = fallback_url
                            resolved_url = fallback_url
                        else:
                            raise
                    else:
                        can_fallback = (
                            task.file_type == "fasta"
                            and int(status_code or 0) == 404
                            and "softmask" in resolved_url.lower()
                        )
                        if not can_fallback:
                            raise
                        fallback_url = re.sub(r"softmasked", "unmasked", resolved_url, count=1, flags=re.IGNORECASE)
                        if not fallback_url or fallback_url == resolved_url:
                            raise
                        _download_with_retries(fallback_url, temp_file)
                        task.warning = "Softmasked FASTA not found on FTP; downloaded unmasked FASTA instead."
                        task.url = fallback_url
                        resolved_url = fallback_url

                if temp_file.exists():
                    _raise_if_cancelled()
                    temp_file.rename(destination)

                task.status = "completed"
                task.progress = 1.0

            except DownloadCancelled:
                logger.info(f"Download canceled for {resolved_url or url}")
                task.status = "canceled"
                task.progress = 0.0
                task.error = None
                current_path = Path(task.current_download_path) if task.current_download_path else None
                _unlink_quietly(current_path)
                _unlink_quietly(temp_file)
                task.current_download_path = None
            except Exception as e:
                logger.error(f"Download failed for {resolved_url or url}: {e}")
                task.status = "failed"
                task.error = str(e)
                _unlink_quietly(temp_file)

        await asyncio.to_thread(_download_sync)

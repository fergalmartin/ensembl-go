"""Where the backend finds its bundled resources, its writable cache and MAFFT.

Resolved once at import. This module must stay directly in backend/: the source-run
paths are derived from this file's own location (backend/cache in development).
"""

import os
import shutil
import sys
from pathlib import Path
from typing import Dict, Tuple


# Configuration
def get_base_path():
    """Return the resource directory for a source or PyInstaller build."""
    if getattr(sys, 'frozen', False):
        # Running as PyInstaller bundle — _MEIPASS has bundled data files
        return Path(sys._MEIPASS)
    else:
        # Running as script
        return Path(__file__).parent


def get_cache_dir():
    """Return the writable cache directory, creating it if needed.

    Electron supplies its user-data directory through ENSEMBL_GO_USER_DATA_DIR
    (or the older ENSEMBL_LOCAL_USER_DATA_DIR). Without an override, source runs
    use backend/cache and frozen builds use a platform-specific user directory.
    """
    user_data_override = (
        os.environ.get("ENSEMBL_GO_USER_DATA_DIR")
        or os.environ.get("ENSEMBL_LOCAL_USER_DATA_DIR")
        or ""
    ).strip()
    if user_data_override:
        cache = Path(user_data_override).expanduser().resolve() / "cache"
    elif getattr(sys, 'frozen', False):
        # Packaged app — use a stable user-writable location
        if sys.platform == 'darwin':
            app_data = Path.home() / "Library" / "Application Support" / "Ensembl Go"
        elif sys.platform == 'win32':
            local_app_data = os.environ.get("LOCALAPPDATA")
            app_data = Path(local_app_data) / "Ensembl Go" if local_app_data else Path.home() / "AppData" / "Local" / "Ensembl Go"
        else:
            app_data = Path.home() / ".ensembl_go"
        cache = app_data / "cache"
    else:
        # Source runs without an override keep their cache beside the backend.
        cache = Path(__file__).parent / "cache"
    cache.mkdir(exist_ok=True, parents=True)
    return cache


BASE_PATH = get_base_path()


CACHE_DIR = get_cache_dir()


# MAFFT discovery
def find_mafft() -> Tuple[str, Dict[str, str]]:
    """Find MAFFT and any environment overrides needed for its helper binaries."""
    env_overrides: Dict[str, str] = {}
    executable_names = ["mafft"]
    if sys.platform == "win32":
        executable_names = ["mafft.bat", "mafft.exe", "mafft.cmd", "mafft"]

    # Electron passes explicit bundled MAFFT locations in packaged builds.
    env_mafft_path = os.environ.get("ENSEMBL_LOCAL_MAFFT_PATH")
    env_mafft_binaries = os.environ.get("ENSEMBL_LOCAL_MAFFT_BINARIES")
    if env_mafft_binaries:
        env_overrides["MAFFT_BINARIES"] = env_mafft_binaries
    if env_mafft_path and os.path.exists(env_mafft_path):
        return env_mafft_path, env_overrides

    candidates = []

    if getattr(sys, 'frozen', False):
        exe_dir = Path(sys.executable).resolve().parent
        for executable_name in executable_names:
            candidates.extend([
                str(exe_dir / "mafft_bin" / "bin" / executable_name),
                str(exe_dir / "mafft" / "bin" / executable_name),
                str(BASE_PATH / executable_name),
            ])

        bundled_binaries = [
            str(exe_dir / "mafft_bin" / "libexec" / "mafft"),
            str(exe_dir / "mafft" / "libexec" / "mafft"),
        ]
        for binaries in bundled_binaries:
            if os.path.isdir(binaries):
                env_overrides["MAFFT_BINARIES"] = binaries
                break

    candidates.extend([
        "/opt/homebrew/bin/mafft",
        "/usr/local/bin/mafft",
    ])
    candidates.extend(executable_names)

    for path in candidates:
        try:
            if os.path.isabs(path) or os.path.sep in path or (os.path.altsep and os.path.altsep in path):
                if os.path.exists(path):
                    return path, env_overrides
                continue
            resolved = shutil.which(path)
            if resolved:
                return resolved, env_overrides
        except Exception:
            continue

    return ("mafft.exe" if sys.platform == "win32" else "mafft"), env_overrides


def _mafft_missing_error() -> RuntimeError:
    return RuntimeError(
        "MAFFT executable was not found. Install MAFFT on this machine or bundle it into the packaged app."
    )


MAFFT_PATH, MAFFT_ENV = find_mafft()


# Resolve optional repository resources from the source root or bundle directory.
if getattr(sys, 'frozen', False):
    # Running as frozen bundle — data files are inside _MEIPASS
    PROJECT_ROOT = BASE_PATH
else:
    # Running from source
    PROJECT_ROOT = Path(__file__).resolve().parent.parent


# Optional starting catalogue for development and offline use.
def _resolve_species_json_path() -> Path:
    env_path = os.environ.get("ENSEMBL_LOCAL_SPECIES_JSON")
    if env_path:
        p = Path(env_path).expanduser()
        if p.exists():
            return p

    # Distributions do not bundle a species catalogue; it is downloaded from Ensembl on
    # first run (see DownloadManager.ensure_catalog_available). These paths only serve
    # development and offline use, where a catalogue can be placed in the repository or
    # pointed at with ENSEMBL_LOCAL_SPECIES_JSON.
    candidates = [
        BASE_PATH / "cluster_test_data" / "species.new_ftp_structure.json",
        BASE_PATH / "cluster_test_data" / "species.json",
        PROJECT_ROOT / "cluster_test_data" / "species.new_ftp_structure.json",
        PROJECT_ROOT / "cluster_test_data" / "species.json",
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]


SPECIES_JSON_PATH = _resolve_species_json_path()


_ENA_METADATA_CACHE_PATH = CACHE_DIR / "ena_metadata_cache.json"

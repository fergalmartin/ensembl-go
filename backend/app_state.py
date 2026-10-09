"""Process-wide singletons shared by every part of the backend.

Refer to them as `app_state.<name>` (not `from app_state import ...`), so that a
test patching `app_state.download_manager` is seen by every caller.
"""

import os

import app_paths
from download_manager import DownloadManager


# Initialize Download Manager
download_manager = DownloadManager(app_paths.SPECIES_JSON_PATH, cache_dir=app_paths.CACHE_DIR)


API_TOKEN = os.environ.get("ENSEMBL_LOCAL_API_TOKEN", "").strip()
API_TOKEN_HEADER = "x-ensembl-local-token"
# Routes serving the sandboxed 3D structure viewer. Kept off /api because these
# are framed navigations and third-party subresource fetches rather than calls
# the app's own fetch wrapper makes; see enforce_local_origin.
STRUCTURE_VIEWER_PREFIX = "/structure/"

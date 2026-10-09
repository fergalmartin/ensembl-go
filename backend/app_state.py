"""Process-wide singletons shared by every part of the backend.

Refer to them as `app_state.<name>` (not `from app_state import ...`), so that a
test patching `app_state.download_manager` is seen by every caller.
"""

import app_paths
from download_manager import DownloadManager


# Initialize Download Manager
download_manager = DownloadManager(app_paths.SPECIES_JSON_PATH, cache_dir=app_paths.CACHE_DIR)

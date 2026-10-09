"""Keep the test suite away from the developer's real data.

`main` resolves its cache directory, and with it `config.json`, when it is first
imported. Without this, any test that reaches `load_config()` without patching the
config path reads the real configuration, whose `output_dir` holds the user's genomes,
notes, achievements and stats caches -- and the endpoint under test may write there.

pytest imports this file before it collects any test module, so pointing the
user-data directory at a throwaway location here takes effect before `import main`.
"""

import os
import shutil
import tempfile
from pathlib import Path

import pytest

_ISOLATED_USER_DATA_DIR = Path(tempfile.mkdtemp(prefix="ensembl-go-tests-"))
os.environ["ENSEMBL_GO_USER_DATA_DIR"] = str(_ISOLATED_USER_DATA_DIR)
os.environ.pop("ENSEMBL_LOCAL_USER_DATA_DIR", None)


@pytest.fixture(scope="session", autouse=True)
def _isolated_user_data_dir():
    yield _ISOLATED_USER_DATA_DIR
    shutil.rmtree(_ISOLATED_USER_DATA_DIR, ignore_errors=True)

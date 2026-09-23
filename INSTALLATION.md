# Installation and first run

This guide covers running Ensembl Go from a source checkout. macOS is the
currently tested desktop platform. Linux installation and packaging are an
initial implementation awaiting tests on Linux desktops. A Linux AppImage or
`.deb`, once built, contains the frontend and backend; its users do not need
Node.js or Python. The same is true of the packaged macOS application. The
packaged Windows application uses a native Electron shell and a Python backend
inside WSL; see
[the Windows checklist](./electron/WINDOWS_TEST_CHECKLIST.md).

If you are using a packaged build, skip the source-development sections below.
On macOS, install the application package. On Linux, run the AppImage or install
the `.deb` supplied by the builder, then follow the [Linux first-test
checks](./electron/RELEASE.md#validate-artifacts-before-sharing). On Windows,
the first-run setup screen checks WSL and provides the commands needed to
prepare its backend.

## Source-development prerequisites

These are for developers running or packaging the source code:

- Node.js `20.19` or newer and npm;
- Python `3.9` or newer.

For source development on Debian or Ubuntu, install `lsof` and `netcat-openbsd`
as well. The development launcher uses their `lsof` and `nc` commands:

```bash
sudo apt install lsof netcat-openbsd
```

Check `node --version` and `python3 --version` before bootstrapping. The versions
provided by a distribution's default packages may be older than the minimums
above; use a newer installation of either tool if needed.

## Optional dependency: MAFFT

MAFFT enables Feature Alignment of genic regions from two or more genomes, with
gene annotation overlaid on the aligned sequence. It is not needed for genome
browsing, downloads, statistics, or the Structural Variation view.

On macOS, install it with Homebrew if you want that functionality:

```bash
brew install mafft
```

On Ubuntu or Debian, including Linux desktops and WSL:

```bash
sudo apt install mafft
```

## Install the source dependencies

From the repository root:

```bash
./scripts/bootstrap_dev.sh
```

This checks the Python and Node.js versions, creates `.venv`, installs the backend
requirements into it, and runs `npm ci` for both `frontend` and `electron`. It is
safe to re-run; an existing virtual environment is reused rather than rebuilt. Add
`--with-packaging` to also install PyInstaller, which is needed to build a
distributable package but not to run the application.

When run interactively it also offers to refresh the species grouping data, which
decides how species are grouped in the download view. Saying no is fine — the copy in
the checkout works, it just may not cover species Ensembl has added recently.
Refreshing downloads about 76 MB from NCBI. Use `--with-grouping` or `--no-grouping`
to answer in advance, which is also what non-interactive runs need.

To do the same by hand instead:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt

npm --prefix frontend ci
npm --prefix electron ci
```

`npm ci` uses the committed lockfiles. Use `npm install` only when intentionally
updating dependencies.

Current Electron versions no longer download their runtime binary during `npm ci`,
so a manual install leaves that to the first launch, which then pauses to fetch
roughly 100 MB. `bootstrap_dev.sh` fetches it up front instead. To do that by hand:

```bash
(cd electron && node node_modules/electron/install.js)
```

The backend runtime versions are pinned through
`backend/constraints.txt`. Developers creating a release package also need
PyInstaller; it is not needed to run a packaged application:

```bash
python -m pip install -r backend/requirements-build.txt
```

## Run the desktop application in development

Activate the Python environment, then start the backend, Vite, and Electron:

```bash
source .venv/bin/activate
./run_ensembl_go.sh
```

The development backend listens on `127.0.0.1:8000`, and Electron loads Vite
from `http://127.0.0.1:5173`. If either port already has a listening process,
the launcher shows its details and asks whether to stop it or abort. It handles
the two ports separately and never stops a process without confirmation.

`run_ensembl_go.sh` also starts Electron and stops only the development
processes it started when Electron exits. It expects the standard macOS/Linux
utilities `lsof` and `nc`.

This fixed-port behaviour applies only to source development. Packaged macOS
and Linux applications do not stop an existing process or ask the user to manage
ports. Their managed backend prefers port 8000 and automatically selects another
free loopback port if 8000 is unavailable. Electron passes that selected
address to the frontend internally.

For browser-only development, use two terminals:

```bash
# Terminal 1
source .venv/bin/activate
cd backend
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

```bash
# Terminal 2, from the repository root
npm --prefix frontend run dev
```

Open `http://127.0.0.1:5173`. A browser-only backend launched this way does not
require the per-launch API token used by Electron.

## First run: the species catalogue

The list of downloadable species comes from a catalogue that is fetched from the
Ensembl FTP site the first time the backend starts. The fetch begins at startup
rather than when the download view is opened, so it is normally finished before
you get there. While it is in progress the download view shows "Fetching species
catalogue", and the list fills in on its own when it completes — no reload needed.
Local genomes remain available throughout.

The catalogue is cached under the application's user data directory, so later
starts load it from disk and refresh it in the background once a day. A cached
catalogue is only used when it is verifiably complete: a truncated or empty file,
which is what an interrupted first run leaves behind, is discarded and downloaded
again rather than being treated as valid.

A build can also ship a bundled catalogue, in which case it is used immediately and
no first-run download is needed. Builds made on a machine without a catalogue
available ship an empty placeholder instead, which is detected and replaced by the
download described above. This means a first run needs network access to
`ftp.ebi.ac.uk` unless a real catalogue was bundled.

## First-run data setup

For the normal downloaded-genome workflow, the user-facing setup is short:

1. Open Configuration and choose an output directory.
2. Open Download and download the assemblies you want to inspect.
3. Add optional custom tracks through Track Manager.

For genomes obtained through Download, Ensembl Go handles the supporting data
setup by default: it downloads and registers the sequence and annotation files
and prepares the indexes used by the views. You only need to manage FASTA,
GFF3, or index files yourself when importing an assembly manually or
troubleshooting an incomplete download.

The output directory owns the application catalogue and cached data under its
`local_data` directory. Keep using the same output directory if you want saved
genomes, playlists, tracks, and registered SV alignments to remain available.

For the extra files and registration steps used by the SV view, see
[Structural-variation view and alignment registration](./docs/STRUCTURAL_VARIATION.md).

## Verify the installation

For the backend test suite, install the test-only `pytest` and `httpx` packages
in the active virtual environment. They are not needed to run the application:

```bash
python -m pip install pytest httpx
```

Then run:

```bash
python -m pytest backend/tests -q
TZ=UTC npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
```

The frontend build can report a large-bundle warning. That warning is not a
build failure. Lint errors are failures; lint warnings currently track existing
cleanup work. `TZ=UTC` avoids two screenshot filename tests that currently
assume UTC even though the application formats timestamps in local time.

## Packaging

For an unsigned local macOS package:

```bash
npm --prefix electron run dist:mac:unsigned
```

For an initial Linux package (AppImage and deb), run on a Linux build host:

```bash
npm --prefix electron run dist:linux
```

Each platform must be packaged on itself. The macOS and Linux backends are native
PyInstaller executables, so they cannot be cross-built, and the packaging scripts
stop with an explanation rather than producing an artifact containing a backend for
the wrong platform. On Linux the build host's glibc also sets the minimum version
the package will run on, so build on the oldest distribution you want to support.
The Linux package still needs a clean-machine installation and launch test before
it is shared more broadly.

To include multiple-alignment support, MAFFT must be available on `PATH`, or
`MAFFT_BUNDLE_ROOT` must point to an installation containing `bin/mafft` and
`libexec/mafft` (or `lib/mafft`). To package the rest of the application without
that optional functionality:

```bash
SKIP_MAFFT_BUNDLE=1 npm --prefix electron run dist:mac:unsigned
# On Linux:
SKIP_MAFFT_BUNDLE=1 npm --prefix electron run dist:linux
```

Signed and notarized macOS releases, and the full Linux and Windows packaging
procedures, are described in [electron/RELEASE.md](./electron/RELEASE.md).

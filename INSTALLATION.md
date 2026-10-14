# Installation and first run

Ensembl Go runs from a source checkout. There are no prebuilt downloads at
present.

- [Platform support](#platform-support)
- [Prerequisites](#prerequisites)
- [Install and run](#install-and-run)
- [Optional dependency: MAFFT](#optional-dependency-mafft)
- [First run](#first-run)
- [Windows](#windows)
- [Developer notes](#developer-notes)

## Platform support

**macOS** is the supported, tested platform.

**Linux is experimental.** The same source setup runs on Debian and Ubuntu once
a few extra system packages are installed, but installation and application
features have not been fully tested, and your system may need steps not listed
here. Run the application in a graphical desktop session. If something fails,
keep the terminal output and note your distribution, its version, and your CPU
architecture.

**Windows is in development** and has no supported installation route yet; see
[Windows](#windows).

## Prerequisites

Every platform needs:

- Node.js `20.19` or newer, including npm (Node 22 LTS is recommended);
- Python `3.9` or newer.

Check them with `node --version` and `python3 --version`. A Linux
distribution's default packages may be older than these minimums; if so,
install Node.js from the [Node.js download page](https://nodejs.org/en/download).

**macOS** needs nothing else.

**Linux (Debian or Ubuntu)** also needs Python's virtual-environment and build
support, and the `lsof` and `nc` commands used by the launcher:

```bash
sudo apt update
sudo apt install python3 python3-venv python3-pip python3-dev \
  build-essential ca-certificates lsof netcat-openbsd
```

On other distributions, install the equivalent packages.

## Install and run

Clone or download the source repository and open a terminal in its root
directory (the one containing `backend`, `frontend`, and `electron`). Then run:

```bash
./scripts/bootstrap_dev.sh
source .venv/bin/activate
./run_ensembl_go.sh
```

`bootstrap_dev.sh` checks the Python and Node.js versions, creates a Python
virtual environment in `.venv`, installs the Python and JavaScript dependencies,
and downloads the Electron runtime (about 100 MB). It is safe to re-run: an
existing `.venv` is reused.

It also offers to refresh the species grouping data used by the Download view.
The copy in the repository works, but may not group recently added species. The
refresh downloads about 76 MB from NCBI. Pass `--with-grouping` or
`--no-grouping` to answer in advance.

`run_ensembl_go.sh` starts the backend, the frontend, and the desktop window.
Keep the terminal open while you use the application; closing the window stops
everything the launcher started.

On later runs, only the last two commands are needed:

```bash
source .venv/bin/activate
./run_ensembl_go.sh
```

The launcher uses ports 8000 and 5173. If either is already in use, it shows
the process using it and asks whether to stop that process or abort. It never
stops a process without asking.

## Optional dependency: MAFFT

MAFFT is needed wherever Ensembl Go computes a new alignment: mainly Feature
Alignment, which aligns genic regions from two or more genomes and overlays
their annotation, and Gene Trees when you request a new sequence alignment.
Genome browsing, downloads, statistics, and the Structural Variation view do not
need it.

On macOS, with Homebrew:

```bash
brew install mafft
```

On Debian or Ubuntu:

```bash
sudo apt install mafft
```

## First run

The first time the backend starts, it downloads the species catalogue from
Ensembl. The Download view shows "Fetching species catalogue" until it is ready,
then fills the list automatically; local genomes remain available meanwhile.
Later starts use a cached copy and refresh it in the background once it is more
than a day old.

Then:

1. Open **Configuration** and choose an output directory.
2. Open **Download** and download the assemblies you want to inspect.
3. Optionally, add custom tracks in **Track Manager**.

For downloaded genomes, Ensembl Go fetches and registers the sequence and
annotation files and builds the indexes the views need. You only handle FASTA,
GFF3, or index files yourself when importing your own assembly or
troubleshooting an incomplete download.

The output directory holds the catalogue of your local genomes and their data
under `local_data`. Keep using the same output directory to keep your genomes,
playlists, tracks, and registered SV alignments.

Installing dependencies, fetching the catalogue, and downloading genomes need
internet access. Downloaded genomes can then be explored offline. The
[user guides](./docs/README.md) explain each view.

## Windows

Windows is not supported yet. The setup and launch scripts above need a Unix
shell, so a source checkout does not run directly on Windows.

An experimental Windows build exists: a Windows desktop application whose
backend runs inside WSL 2 (Ubuntu or Debian). There is no published installer,
so trying it means building one yourself on Windows; see
[Windows packaging](./electron/RELEASE.md#windows) in the packaging guide.

## Developer notes

Nothing in this section is needed to use Ensembl Go.

### Installing dependencies by hand

`bootstrap_dev.sh` is equivalent to:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
npm --prefix frontend ci
npm --prefix electron ci
(cd electron && node node_modules/electron/install.js)
```

`npm ci` installs exactly what the committed lockfiles specify; use
`npm install` only when intentionally changing dependencies. The last command
fetches the Electron runtime, which `npm ci` no longer does; without it, the
first launch pauses to download it. Backend package versions are pinned through
`backend/constraints.txt`.

### Browser-only development

To work without Electron, run the backend and Vite in two terminals:

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

Open `http://127.0.0.1:5173`. A backend started this way does not require the
per-launch API token that Electron uses.

### Running the tests

The backend tests need `pytest` and `httpx`, which the application does not:

```bash
source .venv/bin/activate
python -m pip install pytest httpx
python -m pytest backend/tests -q
TZ=UTC npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
```

`TZ=UTC` is needed because two screenshot-filename tests assume UTC, although the
application formats timestamps in local time. The frontend build may warn about
bundle size, and lint may report warnings; only lint errors are failures.

### Local species catalogue

To start from a local catalogue instead of downloading one, place a complete
`species.json` in `cluster_test_data/` at the repository root, or point
`ENSEMBL_LOCAL_SPECIES_JSON` at one.

### Building packages

Building a macOS app, a Linux AppImage or `.deb`, or a Windows installer is
covered in [electron/RELEASE.md](./electron/RELEASE.md). None of these is needed
to run from source.

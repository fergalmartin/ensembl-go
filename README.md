# Ensembl Go

Ensembl Go is a version of the Ensembl platform that runs locally on a desktop or
laptop. It supports browsing and analysing genomes and annotations, downloading
Ensembl data for offline use, and adding custom genomes, annotations, and tracks.
macOS is the currently tested desktop platform. An initial Linux implementation
can be built from source as an AppImage or `.deb`, but it has not yet been tested
on Linux desktops. Linux users are welcome to help with that first round of
installation testing. Windows support is still in development.

## Install and run

For a source checkout, follow [INSTALLATION.md](./INSTALLATION.md). The short
version for macOS is:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt

npm --prefix frontend ci
npm --prefix electron ci

./run_ensembl_go.sh
```

On Linux, check the additional source prerequisites in the installation guide
before running `./scripts/bootstrap_dev.sh`. A Linux package must be built on
Linux; see [Linux packaging and first-test checks](./electron/RELEASE.md#linux-packaging).

MAFFT is optional. Installing it enables Feature Alignment, which aligns genic
regions from two or more genomes and displays their annotation over the aligned
sequence.

The development launcher uses ports 8000 and 5173. If either is already in
use, it identifies the listening process and asks before stopping it; choosing
not to stop it aborts the launch without changing that process.

## Documentation

- [Installation and first run](./INSTALLATION.md)
- [Development and packaging](./DEVELOPMENT.md)
- [Structural-variation view and alignment registration](./docs/STRUCTURAL_VARIATION.md)
- [Release packaging, including initial Linux builds](./electron/RELEASE.md)
- [Windows/WSL test checklist](./electron/WINDOWS_TEST_CHECKLIST.md)

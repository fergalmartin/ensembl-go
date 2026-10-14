# Ensembl Go

Ensembl Go is a version of the Ensembl platform that runs locally on a desktop or
laptop. It supports browsing and analysing genomes and annotations, downloading
Ensembl data for offline use, and adding custom genomes, annotations, and tracks.
macOS is the currently tested desktop platform. Linux packages can be built from
source as an AppImage or `.deb`. A tester has reported building the Debian package
on Ubuntu 24.04 through Docker for `linux/amd64`, with a catalogue URL adjustment.
Linux desktop installation and launch still need validation. Windows support is
still in development.

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

- [User guides for every view](./docs/README.md)
- [Installation and first run](./INSTALLATION.md)
- [Structural-variation alignment config template](./docs/examples/sv-alignments.template.cfg)
- [Release packaging, including initial Linux builds](./electron/RELEASE.md)
- [Windows/WSL test checklist](./electron/WINDOWS_TEST_CHECKLIST.md)

# Ensembl Go

Ensembl Go is a version of the Ensembl platform that runs locally on a desktop or
laptop. It supports browsing and analysing genomes and annotations, downloading
Ensembl data for offline use, and adding custom genomes, annotations, and tracks.

## Platform support

Ensembl Go runs from a source checkout; there are no prebuilt downloads.

| Platform | Status |
| --- | --- |
| macOS | Supported and tested |
| Linux (Debian/Ubuntu) | Experimental: the source setup runs, but has not been fully tested |
| Windows | In development: no supported installation route yet |

## Install and run

Install Node.js `20.19` or newer (including npm) and Python `3.9` or newer.
Clone or download the source, then run these commands from the repository root:

```bash
./scripts/bootstrap_dev.sh
source .venv/bin/activate
./run_ensembl_go.sh
```

Linux needs a few extra system packages first. See
[INSTALLATION.md](./INSTALLATION.md) for the prerequisites on each platform, the
optional MAFFT dependency, and first-run setup.

## Documentation

- [Installation and first run](./INSTALLATION.md)
- [User guides for every view](./docs/README.md)
- [Structural-variation alignment config template](./docs/examples/sv-alignments.template.cfg)
- [Building packages](./electron/RELEASE.md) (maintainers and testers)

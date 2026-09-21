# Ensembl Go

Ensembl Go is a version of the Ensembl platform that can be run locally on a desktop or laptop. It provides a wide range of ways to view and analyse genomes and annotations, easily download Ensembl data locally and can be run offline. It also support custom data such as genomes, annotations and tracks. Note that it is currently only working on macOS though official Linux and Windows support will be added in future. 

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

MAFFT is optional. Installing it enables multiple alignments of genic regions,
including annotation overlays on the alignment. Genome browsing, alignment
viewing, and the SV view work without it.

The development launcher uses ports 8000 and 5173. If either is already in
use, it identifies the listening process and asks before stopping it; choosing
not to stop it aborts the launch without changing that process.

## Documentation

- [Installation and first run](./INSTALLATION.md)
- [Development and packaging](./DEVELOPMENT.md)
- [Structural-variation view and alignment registration](./docs/STRUCTURAL_VARIATION.md)
- [macOS release packaging](./electron/RELEASE.md)
- [Windows/WSL test checklist](./electron/WINDOWS_TEST_CHECKLIST.md)

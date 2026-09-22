# Ensembl Go

Ensembl Go is a desktop genome browser for working with local Ensembl and NCBI
assemblies, feature alignments across two or more genomes, comparative views,
and structural-variation (SV) alignments.

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

MAFFT is optional. Installing it enables Feature Alignment, which aligns genic
regions from two or more genomes and displays their annotation over the aligned
sequence. Genome browsing and the SV view work without it.

The development launcher uses ports 8000 and 5173. If either is already in
use, it identifies the listening process and asks before stopping it; choosing
not to stop it aborts the launch without changing that process.

## Documentation

- [Installation and first run](./INSTALLATION.md)
- [Development and packaging](./DEVELOPMENT.md)
- [Structural-variation view and alignment registration](./docs/STRUCTURAL_VARIATION.md)
- [macOS release packaging](./electron/RELEASE.md)
- [Windows/WSL test checklist](./electron/WINDOWS_TEST_CHECKLIST.md)

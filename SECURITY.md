# Security notes

## Threat model

Ensembl Go runs on the user's desktop with:

- Electron renderer on the user's machine
- FastAPI backend bound to `127.0.0.1`
- Local filesystem data selected by the user
- Outbound HTTPS downloads to approved genome and Track Hub sources

The backend is not intended to be exposed to a LAN or the internet. Non-loopback
clients are rejected unless `ENSEMBL_LOCAL_ALLOW_NON_LOOPBACK=1` is set for an
explicit test.

## Local API token

Electron generates a per-launch token and starts the backend with
`ENSEMBL_LOCAL_API_TOKEN`. API requests to `/api/**` must include
`X-Ensembl-Local-Token` when that token is configured. `/api/health` stays public
so Electron can attach to or diagnose the backend.

Browser development remains possible without a token by starting the backend
manually without `ENSEMBL_LOCAL_API_TOKEN`.

## Filesystem access

- Read-only file browsing is available for user file selection.
- Managed-genome deletion is limited to the configured
  `output_dir/local_data` species/assembly tree.
- Manual-genome removal checks ownership before deleting generated sidecars or
  converted annotations. The source FASTA and annotation remain protected.
- Symlink escapes and path traversal are rejected for managed-delete paths.
- Export and config writes require leaf filenames with expected extensions.
- Directory creation requires an existing parent and a single leaf name.

## Outbound requests

Genome downloads are restricted to HTTPS URLs from approved EBI/NCBI hosts and
their expected path prefixes. Each redirect is validated before its destination
is requested.

Track Hub imports require HTTPS, reject credentials, and block localhost/private
host targets. Imported Track Hub files are written with atomic temp-file
replacement and bounded by a 2 GB per-file limit.

Protein annotation lookups use a separate, narrower allowlist
(`validate_annotation_service_url`) covering read-only metadata endpoints only:
`alphafold.ebi.ac.uk` under `/api/prediction/` and `/files/`,
`rest.uniprot.org` under `/uniprotkb/`, and `www.ebi.ac.uk` under
`/interpro/api/`. It is kept apart from the genome-download allowlist so neither
can reach the other's hosts. Downloaded AlphaFold models are capped at 96 MB and
written with the same atomic temp-file replacement.

## Sandboxed structure viewer

The Feature Explorer's Structure panel renders AlphaFold models with Mol*
(via PDBe Mol*), which requires `'unsafe-eval'`. The viewer runs in a sandboxed
iframe served by the loopback backend, with its own Content-Security-Policy.
`connect-src` permits that origin and the `data:` URI used for WebAssembly.
The app renderer keeps its stricter policy and permits loopback frames through
`frame-src`.

Because a frame navigation and the viewer's own subresource fetches cannot carry
a header, routes under `/structure/` take the API token from the query string.
That exception is confined to this prefix: the query token is not accepted on
`/api/**`, and loopback and origin checks still apply. Electron's
`will-frame-navigate` holds sub-frames to the same loopback rule as the top
frame.

## Data locations

Electron supplies its user-data directory through `ENSEMBL_GO_USER_DATA_DIR`;
the backend puts its cache beneath it. On macOS this is
`~/Library/Application Support/Ensembl Go/cache`; on Linux it is normally
`~/.config/Ensembl Go/cache`.

Without an override, source runs use `backend/cache`. Frozen builds fall back to:

- macOS: `~/Library/Application Support/Ensembl Go/cache`
- Windows: `%LOCALAPPDATA%/Ensembl Go/cache`
- Linux/other: `~/.ensembl_go/cache`

Downloaded genomes live under the user-selected `output_dir/local_data`.

## Dependency checks

Check dependencies for each release rather than relying on a previous audit:

```bash
npm --prefix frontend audit --omit=dev
npm --prefix electron audit --omit=dev
npm --prefix electron run check:electron-runtime
```

The runtime check matters because Electron is a dev dependency but its binary
ships with the app. A production npm audit excludes it. Python runtime versions
are pinned in `backend/constraints.txt`.

Also review the full npm audit for build-tool findings. Assess their exposure
and the effect of proposed upgrades; do not apply `npm audit fix --force`
without reviewing the dependency changes. See [release packaging](electron/RELEASE.md)
for the preflight and smoke checks.

## Non-goals

This release does not provide hosted-service authentication, multi-user tenant
isolation, or TLS termination for a public backend. Do not deploy the backend as
a public web service without a separate server-oriented hardening pass.

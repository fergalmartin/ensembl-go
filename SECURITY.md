# Security Notes

## Supported Threat Model

Ensembl Go is a desktop-local application. The supported production shape is:

- Electron renderer on the user's machine
- FastAPI backend bound to `127.0.0.1`
- Local filesystem data selected by the user
- Outbound HTTPS downloads to approved genome and Track Hub sources

The backend is not intended to be exposed to a LAN or the internet. Non-loopback
clients are rejected unless `ENSEMBL_LOCAL_ALLOW_NON_LOOPBACK=1` is set for an
explicit test.

## Local API Token

Electron generates a per-launch token and starts the backend with
`ENSEMBL_LOCAL_API_TOKEN`. API requests to `/api/**` must include
`X-Ensembl-Local-Token` when that token is configured. `/api/health` stays public
so Electron can attach to or diagnose the backend.

Browser development remains possible without a token by starting the backend
manually without `ENSEMBL_LOCAL_API_TOKEN`.

## Filesystem Scope

- Read-only file browsing is available for user file selection.
- Destructive local-data endpoints are limited to the configured
  `output_dir/local_data` species/assembly tree.
- Symlink escapes and path traversal are rejected for managed-delete paths.
- Export and config writes require leaf filenames with expected extensions.
- Directory creation takes an existing parent plus a single leaf name, so the
  browser can add a folder where the user is looking without exposing a
  create-arbitrary-trees-anywhere primitive.

## Outbound Network Policy

Genome downloads are restricted to HTTPS URLs from approved EBI/NCBI hosts and
their expected path prefixes. Redirects are followed one hop at a time and each
hop is revalidated *before* it is requested, so a redirect toward a disallowed
host is never fetched at all.

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

## Sandboxed 3D Structure Viewer

The Feature Explorer's Structure panel renders AlphaFold models with Mol*
(via PDBe Mol*), which requires `'unsafe-eval'`. Rather than weaken the
renderer's policy — the renderer holds the per-launch API token over the Electron
context bridge — the viewer runs in an iframe served from the loopback backend
under its own Content-Security-Policy, with `connect-src` limited to that origin
plus the `data:` URI Mol* instantiates its WebAssembly from. The app's own policy
is unchanged apart from `frame-src` for loopback.

Because a frame navigation and the viewer's own subresource fetches cannot carry
a header, routes under `/structure/` take the API token from the query string.
That exception is confined to this prefix: the query token is not accepted on
`/api/**`, and loopback and origin checks still apply. Electron's
`will-frame-navigate` holds sub-frames to the same loopback rule as the top
frame.

## Data Locations

Development cache defaults to `backend/cache`. Packaged builds use the user's
application-support area:

- macOS: `~/Library/Application Support/Ensembl Go/cache`
- Windows: `%LOCALAPPDATA%/Ensembl Go/cache`
- Linux/other: `~/.ensembl_go/cache`

Downloaded genomes live under the user-selected `output_dir/local_data`.

## Dependency Advisories

Shipped dependencies carry no known advisories: `npm audit --omit=dev` is clean
in both `frontend/` and `electron/`, and the Python requirements are pinned in
`backend/constraints.txt`.

A plain `npm audit` does report findings, all of them in build-time-only
packages that never reach a user's machine. Two are left deliberately unfixed,
because the available fix costs more than the flaw:

- `frontend/`: a denial-of-service in `brace-expansion`, reached only through
  ESLint's own glob handling. The fix requires ESLint 10, which changes the rule
  set enough to turn a currently clean `npm run lint` into 26 errors.
- `electron/`: the same `brace-expansion` issue by way of `electron-builder`.
  The fix is a major *downgrade* of the packager, to 25.x.

Both would need attacker-controlled glob patterns in a developer's own build
configuration to matter. Revisit when ESLint 10 support lands in
`eslint-plugin-react-hooks` and when `electron-builder` refreshes its
dependencies.

## Non-goals

This release does not provide hosted-service authentication, multi-user tenant
isolation, or TLS termination for a public backend. Do not deploy the backend as
a public web service without a separate server-oriented hardening pass.

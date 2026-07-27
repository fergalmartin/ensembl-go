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

## Outbound Network Policy

Genome downloads are restricted to HTTPS URLs from approved EBI/NCBI hosts and
their expected path prefixes. Redirect targets are revalidated before data is
accepted.

Track Hub imports require HTTPS, reject credentials, and block localhost/private
host targets. Imported Track Hub files are written with atomic temp-file
replacement and bounded by a 2 GB per-file limit.

## Data Locations

Development cache defaults to `backend/cache`. Packaged builds use the user's
application-support area:

- macOS: `~/Library/Application Support/Ensembl Go/cache`
- Windows: `%LOCALAPPDATA%/Ensembl Go/cache`
- Linux/other: `~/.ensembl_go/cache`

Downloaded genomes live under the user-selected `output_dir/local_data`.

## Non-goals

This release does not provide hosted-service authentication, multi-user tenant
isolation, or TLS termination for a public backend. Do not deploy the backend as
a public web service without a separate server-oriented hardening pass.

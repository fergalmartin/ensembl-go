# Ensembl Go Frontend

React/Vite renderer for the Ensembl Go desktop app. In production it runs inside
Electron and talks to the local FastAPI backend on `127.0.0.1`.

## Runtime Contract

- Backend URL comes from Electron runtime metadata, then `VITE_API_BASE` /
  `VITE_BACKEND_URL`, then `http://127.0.0.1:8000`.
- Electron also provides a per-launch API token. `src/backendRuntime.js`
  installs a fetch shim and exports `apiFetch()` so requests to `/api/**` carry
  `X-Ensembl-Local-Token` automatically.
- Browser-only development still works without a token when the backend is
  launched without `ENSEMBL_LOCAL_API_TOKEN`.

## Development

From the repository root:

```bash
./run_ensembl_go.sh
```

For frontend-only work:

```bash
npm --prefix frontend ci
npm --prefix frontend run dev
```

`npm run dev` starts Vite, and `npm run build` creates the production frontend
bundle. No additional language toolchain is required.

The user-facing SV file formats and alignment-registration steps are documented
in [../docs/STRUCTURAL_VARIATION.md](../docs/STRUCTURAL_VARIATION.md).

## Release Checks

Run these before packaging:

```bash
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend audit --omit=dev
```

`npm run lint` is a release gate: it must exit successfully. Existing warnings
track legacy cleanup work but should not block packaging.

## Notes

- `src/lib/ensembl-sv` is treated as vendored library code by ESLint.
- Backup files (`*~`) and build output are excluded from lint and source
  snapshots.

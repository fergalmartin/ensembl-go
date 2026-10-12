# Ensembl Go Frontend

React/Vite renderer for the Ensembl Go desktop app. In production it runs inside
Electron and talks to the local FastAPI backend on `127.0.0.1`.

## Backend connection

- Backend URL comes from Electron runtime metadata, then `VITE_API_BASE` /
  `VITE_BACKEND_URL`, then `http://127.0.0.1:8000`.
- Electron also provides a per-launch API token. `src/backendRuntime.js`
  installs a fetch wrapper and exports `apiFetch()` so requests to `/api/**` carry
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

## Checks before packaging

Run these before packaging:

```bash
npm --prefix frontend ci
TZ=UTC npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend audit --omit=dev
```

Lint must exit successfully; existing warnings do not block packaging.
`TZ=UTC` matches the screenshot filename tests' assumptions.

## Notes

- `src/lib/ensembl-sv` is treated as vendored library code by ESLint.
- Backup files (`*~`) and build output are excluded from lint and source
  snapshots.

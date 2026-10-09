# Development Workflow

Complete the source installation in [INSTALLATION.md](./INSTALLATION.md) before
using these commands. On a fresh checkout that is:

```bash
./scripts/bootstrap_dev.sh
source .venv/bin/activate
```

`run_ensembl_go.sh` checks that the Python and Node dependencies are actually
installed before it starts anything, and points at the bootstrap script if they
are not.

For rapid development without rebuilding the application, use the
`run_ensembl_go.sh` script.

## Fast Dev Mode (Hot Reload)

Instead of rebuilding the Electron app every time you make a change, you can run:

```bash
./run_ensembl_go.sh
```

This script will:
1. Start the **Backend** (FastAPI) with auto-reload enabled (port 8000).
2. Start the **Frontend** (Vite) with HMR (Hot Module Replacement) enabled (port 5173).
3. launch **Electron** pointing to your local dev servers.

Ports 8000 and 5173 are checked independently before anything starts. If a
port is occupied, the script displays the listening process and asks whether
to stop it or abort. It first requests a graceful stop; if that does not work,
it asks again before forcing the process to stop. A non-interactive launch
aborts safely when either port is occupied.

The packaged macOS application and initial Linux package handle ports
differently. Their managed backend prefers port 8000, but automatically uses a
free loopback port when 8000 is unavailable and does not terminate the existing
process.

In this fast mode the backend is started without `ENSEMBL_LOCAL_API_TOKEN`, so
browser development remains frictionless. When Electron launches the backend
itself, it generates a per-launch token and the frontend sends it automatically.

### Benefits
- **Backend changes**: Modify any module under `backend/` and the server restarts instantly (this also cancels any download in progress).
- **Frontend changes**: Modify React components and the browser updates instantly without losing state.
- **Electron changes**: You still need to restart the script if you change `electron/main.js`, but you don't need to rebuild the binary.

## Code layout and conventions

### Backend

`backend/main.py` is only the entry point: logging, the FastAPI app and its lifespan,
CORS and the local-origin middleware, the `include_router` calls and the `__main__`
block. Electron, PyInstaller and `uvicorn main:app` all start it, and under Electron and
the packaged app it runs as `__main__`.

- **Shared core modules** sit directly in `backend/`: `app_paths` (base, cache and
  project paths; MAFFT discovery), `app_state` (process singletons such as the download
  manager and API token), `config_store` (config file, defaults, migrations, load/save),
  `file_io` (indexed FASTA and gzip helpers), `gff_index` (GFF parsing, SQLite indexing,
  the index worker), `local_inventory` (what is on disk), `genome_context` (browse
  context, browse DB, chromosome resolution), plus `data_paths`, `mafft`,
  `sequence_windows`, `transcript_translation`, `sv_datasets` and `package_providers`.
  `app_paths` uses `Path(__file__)`, so it must stay in `backend/`.
- **Endpoints** live in `backend/routes/<domain>.py`, one `router = APIRouter()` per
  domain together with its request/response models and private helpers. Larger features
  keep their own packages (`alignment_explorer/`, `sequence_view/`, `gene_trees/`, ...),
  wired up in `main.py`.
- **Nothing may `import main`.** Doing so would load a second copy of the app with its
  own state. `tests/test_module_boundaries.py` enforces this.
- **Import core modules as modules** (`import config_store`, then
  `config_store.load_config()`), not `from config_store import load_config`. A test that
  patches the defining module then reaches every caller.
- **Tests patch the module that defines a name**, for example
  `patch.object(config_store, "CONFIG_FILE", ...)`. `tests/conftest.py` points
  `ENSEMBL_GO_USER_DATA_DIR` at a temporary directory, so a patch that misses cannot write
  to real user data.
- **`def` versus `async def`** matters. Handlers that only do blocking work are `def`, so
  they run on the threadpool; see the docstring in `routes/__init__.py`.
- `tests/test_route_contract.py` snapshots every route and the OpenAPI schema
  (`tests/fixtures/route_contract.json`). Regenerate the fixture deliberately when you
  change the API, and keep request/response model names unique.

### Frontend

- `src/App.jsx` holds the app's state and wiring. Its pure helpers and the bodies of its
  larger handlers and effects live in `src/app/`; the top-level render tree is in
  `src/components/app-shell/AppLayout.jsx`.
- Views live in feature folders under `src/components/` (`genome-browser/`,
  `structural-variation/`, `genome-selector/`, `track-manager/`, `download/`, `stats/`,
  ...). `genome-browser/` holds `GenomeBrowser.jsx` (one panel) and its modules for
  painting, input, fetching, projection and export; `genome-browser/view/` holds the
  multi-panel `GenomeBrowserView` pieces.
- Large hooks and handlers are split out as plain functions that take a context object:
  `fn(ctx, ...args)`, starting with `const { ... } = ctx`. The component keeps the
  `useCallback`/`useEffect` and its dependency array, and calls the function. Keep
  dependency arrays and hook order unchanged when moving code.
- **Anything carrying a `data-tour-id` must stay under `src/components/`** (or in
  `App.jsx`); `tests/tutorialTargets.test.js` checks this.
- Node tests can only import `.js` modules. Testable modules use explicit `.js` import
  extensions and no JSX, `?raw` imports or `import.meta.env`.
- Tests that assert on source text use `readSources(...)` from
  `tests/helpers/readSource.js` and read a whole feature folder, so moving code between
  files of the same feature does not break them.

## Building for Production

The standard frontend is built directly with Vite and has no additional
language toolchain prerequisites. WSL remains supported for browser
development, while Windows Electron packaging should run from PowerShell.

To build the final distributable application:

```bash
cd electron
npm run dist
```

`npm run dist` now performs a macOS release build preflight and expects:
- A valid `Developer ID Application` certificate in your keychain.
- Notarization credentials in environment variables.

For local packaging without signing/notarization:

```bash
cd electron
npm run dist:mac:unsigned
```

The other targets are `npm run dist:linux` (initial AppImage and deb builds) and
`npm run dist:win` (NSIS and zip). Each must run on its target platform. The macOS
and Linux backends are native PyInstaller executables and cannot be cross-built;
the packaging scripts stop with an explanation instead of shipping a backend
for the wrong platform. `dist:linux:dir` and `dist:win:dir` produce a faster
unpacked build for checking a change before generating installers. A Linux
package needs a launch and install test on a clean Linux machine before it can
be treated as supported.

See `electron/RELEASE.md` for full release setup and validation commands for all three
platforms.

The Structural Variation input and registration contract is documented in
[`docs/STRUCTURAL_VARIATION.md`](./docs/STRUCTURAL_VARIATION.md).

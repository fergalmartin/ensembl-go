# Development

Complete the source installation in [INSTALLATION.md](./INSTALLATION.md) before
using these commands. On a fresh checkout that is:

```bash
./scripts/bootstrap_dev.sh
source .venv/bin/activate
```

## Run with hot reload

From the repository root:

```bash
./run_ensembl_go.sh
```

The launcher checks dependencies, then starts FastAPI with auto-reload on port
8000, Vite with hot module replacement on port 5173, and Electron using those
servers. Missing dependencies are reported with a link to the bootstrap script.

Ports 8000 and 5173 are checked independently before anything starts. If a
port is occupied, the script displays the listening process and asks whether
to stop it or abort. It first requests a graceful stop; if that does not work,
it asks again before forcing the process to stop. A non-interactive launch
aborts safely when either port is occupied.

The packaged macOS application and initial Linux package handle ports
differently. Their managed backend prefers port 8000, but automatically uses a
free loopback port when 8000 is unavailable and does not terminate the existing
process.

The development backend runs without `ENSEMBL_LOCAL_API_TOKEN`. When Electron
manages the backend itself, it generates a per-launch token that the frontend
sends automatically.

Backend edits restart the server and cancel active downloads. Frontend edits
usually update in place, though changes that cannot be hot-reloaded reload the
page. Restart the launcher after editing Electron's main or preload code.

## Code layout and conventions

### Backend

`backend/main.py` assembles the FastAPI app, logging, startup tasks, middleware
and routers. Electron runs it as `__main__`; browser development imports it
through `uvicorn main:app`.

- **Endpoints** live in `backend/routes/<domain>.py`, one `router = APIRouter()` per
  domain together with its request/response models and private helpers. Larger features
  keep their own packages (`alignment_explorer/`, `sequence_view/`, `gene_trees/`, ...),
  wired up in `main.py`.
- **Application modules must not `import main`.** Under Electron, this would load
  a second app instance. `tests/test_module_boundaries.py` enforces the boundary.
- **Import core modules as modules** (`import config_store`, then
  `config_store.load_config()`), not `from config_store import load_config`. A test that
  patches the defining module then reaches every caller.
- **Tests patch the module that defines a name**, for example
  `patch.object(config_store, "CONFIG_FILE", ...)`. `tests/conftest.py` points
  `ENSEMBL_GO_USER_DATA_DIR` at a temporary directory, so a patch that misses cannot write
  to real user data.
- **Use `def` for blocking handlers**, so FastAPI runs them in its threadpool.
  An `async def` handler must move blocking work into `run_in_threadpool`.
  See `routes/__init__.py` for the conventions.
- `tests/test_route_contract.py` snapshots every route and the OpenAPI schema
  (`tests/fixtures/route_contract.json`). Regenerate the fixture deliberately when you
  change the API, and keep request/response model names unique.

Shared services sit directly in `backend/`:

| Module | Responsibility |
| --- | --- |
| `app_paths`, `data_paths` | Resource, cache and genome paths; MAFFT discovery. |
| `app_state` | Process-wide download manager and API token. |
| `config_store` | Configuration, playlists, migrations and atomic writes. |
| `file_io`, `gff_index` | FASTA access and annotation indexing. |
| `local_inventory`, `genome_context` | Local genomes, browse context and region aliases. |
| `sequence_windows`, `transcript_translation` | Sequence geometry and shared protein translation. |
| `mafft`, `sv_datasets` | Alignment execution and structural-variation data. |
| `package_providers` | Adapters injected into feature-package routers. |

Keep `app_paths` directly in `backend/`: source paths are derived from its
`__file__` location.

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

### Comments and documentation

Use short, direct sentences and British spelling in prose. Keep identifiers,
file names and labels as written in the code. Explain a module's role, a
constraint or a reason that is not clear from the implementation. State
coordinate conventions and units where they matter. Keep detailed design
history in dated review documents and link to it when useful.

After moving code, update documentation to name the module that now owns it.
Keep current behaviour separate from proposals and historical measurements.

## Check a change

From the repository root, with the Python environment active:

```bash
python -m pytest backend/tests -q
TZ=UTC npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
```

Backend tests also need `pytest` and `httpx`; see the installation guide.
`TZ=UTC` matches the screenshot filename tests' assumptions. Lint errors fail
the check; existing warnings and Vite's large-bundle warning do not.

## Build packages

The standard frontend is built directly with Vite and has no additional
language toolchain prerequisites. WSL remains supported for browser
development, while Windows Electron packaging should run from PowerShell.

To build the final distributable application:

```bash
cd electron
npm run dist
```

`npm run dist` performs a macOS release preflight and requires:

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

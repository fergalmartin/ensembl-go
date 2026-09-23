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
- **Backend changes**: Modify `backend/main.py` and the server restarts instantly.
- **Frontend changes**: Modify React components and the browser updates instantly without losing state.
- **Electron changes**: You still need to restart the script if you change `electron/main.js`, but you don't need to rebuild the binary.

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

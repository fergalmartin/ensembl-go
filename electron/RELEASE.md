# Building packages

This guide is for maintainers and testers who build installable packages. People
using Ensembl Go run it from source; see [INSTALLATION.md](../INSTALLATION.md).
No packages are currently distributed, so every target below exists for testing.

| Target | Command | Status | Backend shipped as | Build on |
| --- | --- | --- | --- | --- |
| Linux AppImage and `.deb` | `npm run dist:linux` | Experimental | PyInstaller executable | Linux, or a Linux container |
| Windows installer and zip | `npm run dist:win` | Experimental | Python source, run in WSL 2 | Windows |
| macOS app, unsigned | `npm run dist:mac:unsigned` | Local testing only | PyInstaller executable | macOS |
| macOS app, signed and notarized | `npm run dist` | Not currently used | PyInstaller executable | macOS |

PyInstaller produces an executable for the machine it runs on, so macOS and Linux
packages must be built on the platform they target; `check-backend-prereqs.js`
rejects a mismatched target. Output goes to `electron/dist` for every target.

- [Before building (all targets)](#before-building-all-targets)
- [After building (all targets)](#after-building-all-targets)
- [Linux](#linux)
- [Windows](#windows)
- [macOS](#macos)

## Before building (all targets)

### Build environment

On macOS or Linux, start from the source setup in
[INSTALLATION.md](../INSTALLATION.md), adding the packaging dependencies
(PyInstaller):

```bash
./scripts/bootstrap_dev.sh --with-packaging
source .venv/bin/activate
```

Keep the virtual environment active while building: the build scripts find
PyInstaller and the backend dependencies through the active `python3`. Windows
uses a different setup; see [Windows](#windows).

### Release checks

From a clean checkout, with the virtual environment active:

```bash
python -m pip install pytest httpx
python -m pytest backend/tests -q
python -m compileall -q backend
TZ=UTC npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend audit --omit=dev
npm --prefix electron audit --omit=dev
python backend/scripts/check_classification_coverage.py
```

The frontend build may warn about the large main bundle; that is a performance
backlog item, not a blocker. Lint warnings do not block packaging; lint errors
do. `TZ=UTC` matches the screenshot-filename tests' assumptions.

### Species grouping artifacts

The Download view uses `backend/data/taxonomy_classification.json` to group
species by NCBI lineage. Species missing from that file fall back to name
heuristics, which can place them in less specific groups. The catalogue is
downloaded at runtime and gains new species, so refresh the classification data
before building.

`dist`, `dist:win` and `dist:linux` run `npm run refresh:classification` before
packaging. It:

1. Downloads the current catalogue and measures classification coverage.
2. Stops if at most 1% of species are uncovered.
3. Otherwise downloads the NCBI taxdump (about 76 MB), regenerates the taxonomy
   classification, and refreshes `project_classification.json`.

To run it by hand, or to see where things stand without building:

```bash
npm --prefix electron run refresh:classification          # refresh if needed
python backend/scripts/check_classification_coverage.py   # report only, changes nothing
npm --prefix electron run refresh:classification -- --force
npm --prefix electron run refresh:classification -- --max-uncovered-percent 0.5
```

The taxdump is cached under `backend/cache/build/`. NCBI rebuilds it daily, so the
cache only helps repeated builds on the same day; it is safe to delete. The
underlying generators, `backend/scripts/generate_taxonomy_classification.py` and
`generate_project_classification.py`, can be run directly to point at a specific
catalogue or taxdump; both take `--audit-only` to report without writing.
`check-backend-prereqs.js` fails the build if either artifact is missing.

### Dependency audit

Use `npm audit --omit=dev` for production npm dependencies, and review the full
audit separately for build tools such as Vite, Rollup, ESLint and
electron-builder. Rerun the audit for each build you share. Review dependency
changes before applying fixes: `npm audit fix --force` can change the major
version of Electron or the packager.

Electron is a dev dependency, but its runtime ships with the application and the
production audit excludes it. Check it separately:

```bash
npm --prefix electron run check:electron-runtime
```

This compares the bundled version with the support window configured in
`scripts/check-electron-runtime.js`, and fails the `dist*` builds that run it when
the runtime falls outside that window.

### MAFFT bundling

macOS and Linux packages bundle MAFFT from `PATH` by default, so Feature
Alignment works without a separate install. To bundle a specific installation,
point at its root, which must contain `bin/mafft` and either `libexec/mafft` or
`lib/mafft`. To package without MAFFT, set `SKIP_MAFFT_BUNDLE=1`:

```bash
export MAFFT_BUNDLE_ROOT=/absolute/path/to/mafft/install/root   # bundle this installation
SKIP_MAFFT_BUNDLE=1 npm run dist:linux                          # or package without MAFFT
```

Homebrew's `mafft` on macOS and the Debian/Ubuntu `mafft` package (`/usr/bin/mafft`
with helpers in `/usr/lib/mafft`) are both recognised. Windows packages never
bundle MAFFT; users install it inside WSL.

## After building (all targets)

### Smoke test

Launch the package, on a clean machine other than the build host where the
platform allows, and check:

- The Home screen renders.
- Backend status reaches ready. This is the check that fails if the backend was
  not bundled or does not match the machine.
- File selection works.
- The species catalogue loads, and a genome can be downloaded and opened.
- If MAFFT is bundled, Feature Alignment succeeds with at least three genomes and
  displays their annotation overlays.
- Screenshot/export save writes the expected file extension.

Packaged applications do not use the source launcher's fixed ports. Their managed
backend prefers port 8000 and picks another free loopback port if 8000 is taken.

### Security checks

- The backend binds to `127.0.0.1` by default.
- `/api/health` responds without a token.
- `/api/config` returns 401 when `ENSEMBL_LOCAL_API_TOKEN` is set and the token
  header is missing.
- Remote genome downloads and Track Hub imports reject non-HTTPS/private-host
  URLs.
- Managed-genome deletion rejects paths outside `output_dir/local_data`.
- Manual-genome removal preserves source files and checks generated-file ownership.

## Linux

**Linux packages are experimental. Installation, launch, and application
features have not been fully tested on Linux desktops, and these steps may need
more for your system.**

Packages contain a native Electron shell and a native PyInstaller backend; people
installing them do not need Python, Node.js, or Docker. The targets are
`AppImage` and `deb`.

### Build host

The build environment's glibc sets the oldest system the package will run on, so
build on the oldest distribution you intend to support; a package built on current
Fedora can fail to start on an older Ubuntu release with a loader error. Choose a
baseline that also has the required Python and Node.js versions.
`verify-linux-backend.js` prints the glibc version it built against; record it
with the test results. Building on an older baseline helps, but Electron and the
backend's native dependencies (`pysam`, `pyBigWig`) still need testing on each
intended distribution.

The architecture follows the build host: an x86-64 host produces an x86-64
package, an arm64 host an arm64 one. Do not pass an explicit `--x64`/`--arm64`
that disagrees with the host, or the Electron shell and the PyInstaller backend
will not match.

### Build directly on Linux

On Debian or Ubuntu, install the [Linux prerequisites](../INSTALLATION.md#prerequisites)
plus the `.deb` packaging tools, set up the [build environment](#build-environment),
and build:

```bash
sudo apt install dpkg fakeroot
sudo apt install mafft      # optional; bundled when present
./scripts/bootstrap_dev.sh --with-packaging
source .venv/bin/activate
cd electron
npm run dist:linux
```

This runs the release preflight and prebuild, verifies that the produced backend
is an ELF binary matching the host architecture, then builds the AppImage and
`.deb`. For a faster unpacked build to check first, use `npm run dist:linux:dir`.

### Build in Docker (Debian 12, amd64)

The repository's [Dockerfile](../Dockerfile.linux-amd64) builds inside Debian 12
(Bookworm) with Node.js 22, Python 3.11, the native build tools, and MAFFT.
Dependencies are installed inside the container; host virtual environments,
`node_modules`, and previous builds are excluded by the adjacent
`Dockerfile.linux-amd64.dockerignore`.

Use Docker with Linux containers. On an ARM host such as an Apple Silicon Mac,
the Docker environment must support x86-64 emulation, and emulated builds are
slower; see [Docker's platform guidance](https://docs.docker.com/build/building/multi-platform/).
With Colima on macOS, an x86-64 VM provides that:

```bash
colima start amd64 --arch x86_64 --vm-type=qemu --cpu 6 --memory 12 --disk 80
docker context use colima-amd64
```

Docker Desktop users can use their existing Linux-container context instead.

From the repository root, build the image, then run the packaging command and
copy its artifacts into `dist-linux` on the host:

```bash
docker build --platform linux/amd64 \
  -f Dockerfile.linux-amd64 \
  -t ensembl-go-linux-amd64-builder .

mkdir -p dist-linux
docker run --rm --platform linux/amd64 \
  -v "$PWD/dist-linux:/output" \
  ensembl-go-linux-amd64-builder \
  bash -c 'npm run dist:linux && cp -r --no-preserve=ownership dist/. /output/'
```

The image contains a copy of the checkout, so rebuild it after source changes.
Use an empty output directory for each build to avoid mixing old and new
artifacts. Do not mount your checkout over `/opt/ensembl-go`: that would hide the
container's installed dependencies.

The output includes `Ensembl Go-<version>-linux-x86_64.AppImage`,
`ensembl-go_<version>_amd64.deb`, and `linux-unpacked/`. On a native Linux Docker
host the exported files may be owned by root. Building in Docker does not test the
graphical application; install the result on an x86-64 Linux desktop.

Record the source commit (`git rev-parse HEAD` on the host), builder image ID,
Python and Node.js versions, and glibc version with the artifacts; the base image
tag and downloaded dependencies can change, so the Dockerfile alone does not pin
every input:

```bash
docker image inspect ensembl-go-linux-amd64-builder --format '{{.Id}}'
docker run --rm --platform linux/amd64 ensembl-go-linux-amd64-builder \
  bash -c 'python --version; node --version; npm --version; getconf GNU_LIBC_VERSION'
```

### Using a different catalogue URL

Packaging needs internet access for the species catalogue and, when grouping
needs regenerating, the NCBI taxonomy data. The build-time refresh uses
`https://ftp.ebi.ac.uk/pub/ensemblorganisms/species.json`. A checkout that still
fails with a 404 for `species.new_ftp_structure.json` predates that URL; update it
(and rebuild the Docker image) before retrying.

To use another endpoint, pass `--catalog-url` to the refresh, then run the
remaining steps yourself so `dist:linux` does not repeat the refresh with the
default URL. For Docker, first open a shell at the repository root inside the
container:

```bash
docker run --rm -it --platform linux/amd64 \
  -v "$PWD/dist-linux:/output" -w /opt/ensembl-go \
  ensembl-go-linux-amd64-builder bash
```

Then, from the repository root:

```bash
npm --prefix electron run check:electron-runtime
npm --prefix electron run refresh:classification -- --catalog-url <url>
npm --prefix electron run prebuild:linux
npm --prefix electron run verify:linux-backend
(cd electron && node node_modules/electron-builder/cli.js --linux AppImage deb)
```

In Docker, copy the artifacts out with
`cp -r --no-preserve=ownership electron/dist/. /output/` before exiting. The
running application's catalogue URL is separate: it already tries both catalogue
URLs and accepts `ENSEMBL_LOCAL_SPECIES_JSON_URL`, which does not affect the
build-time refresh.

### Installing a test build

There is no code signing on Linux. Use a desktop with a graphical session and a
package matching its CPU architecture. Replace the version and architecture in
these examples with your package's filename.

On Debian or Ubuntu, install the `.deb` with `apt` so its declared system
dependencies are installed too, then launch it from a terminal or the
application menu:

```bash
sudo apt update
sudo apt install ./ensembl-go_1.0.0_amd64.deb
ensembl-go
```

Or make the AppImage executable and run it. Its filename contains a space
(it follows the `${productName}` naming of the other platforms), so keep the
quotes:

```bash
chmod +x "Ensembl Go-1.0.0-linux-x86_64.AppImage"
./"Ensembl Go-1.0.0-linux-x86_64.AppImage"
```

If the AppImage reports a FUSE error, follow the
[AppImage FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
or use the `.deb`. If the package was built without MAFFT, install it with
`sudo apt install mafft`.

Run the [smoke test](#smoke-test), and also check that an output directory outside
`$HOME` is writable. Record the distribution and version, architecture, package
filename, source commit, and any startup errors with the results.

### Known Linux specifics

- The backend is a PyInstaller `--onefile` build, so it unpacks to a temporary
  directory on each launch. On hardened systems that mount `/tmp` with `noexec`
  it will fail to start; set `TMPDIR` to an exec-capable path. Switching to
  `--onedir` would remove the caveat and start faster, at the cost of a larger
  resource tree.
- Electron needs a working Chromium sandbox. Requirements vary with the
  distribution's user-namespace policy and the package format. If launch reports
  a sandbox error, keep the error for troubleshooting rather than disabling the
  sandbox as a normal installation step.
- `snap` is deliberately not a target. Its confinement interferes with launching
  the bundled backend and with reaching output directories outside the snap's own
  writable area.
- User data goes to `~/.config/Ensembl Go`, which Electron passes to the backend.
  The backend's own fallback, used only when that variable is absent, is
  `~/.ensembl_go`.

## Windows

**The Windows build is experimental.**

The Windows package is a native Electron shell whose backend runs in a Python
virtual environment inside an Ubuntu or Debian WSL 2 distro, over localhost HTTP.
It does not ship a native backend executable. Instead it bundles the backend
source, copies it into the distro's native filesystem under
`~/.local/share/ensembl-go/backend/<source-hash>/`, and launches it through
`wsl.exe`. A changed backend gets a new directory.

### Build

On a Windows machine, install Node.js `20.19` or newer. `dist:win` also needs a
Windows Python 3 (`py -3`, `python`, or `ENSEMBL_LOCAL_PYTHON`) for the
[species grouping refresh](#species-grouping-artifacts); `dist:win:dir` does not.
From PowerShell at the repository root:

```powershell
npm --prefix frontend ci
npm --prefix electron ci
cd electron
npm run dist:win:dir
npm run dist:win
```

`dist:win:dir` is a faster unpacked build (`dist\win-unpacked\Ensembl Go.exe`)
for a first check. `dist:win` produces the NSIS installer and zip,
`dist\Ensembl Go-<version>-win-x64.exe` and `.zip`.

### Installing a test build

The test machine needs WSL 2 with an Ubuntu or Debian distro; see Microsoft's
[WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install).
Windows Python and MAFFT are not needed.

Install and launch Ensembl Go. On first launch it copies its backend into the
distro's default user's home directory and, when `uv` is available in WSL,
creates the backend's virtual environment automatically, showing progress first.
If setup fails, the setup screen offers copyable `uv` and Python venv commands.
The `uv` route can download Python 3.12 itself; the venv route needs `python3`
and `python3-venv` in WSL. Nothing is installed into the Windows host or the WSL
system Python. MAFFT is optional: install it inside WSL with
`sudo apt install mafft`.

Data paths inside the app must be WSL-visible Linux paths, such as `/mnt/c/...`
for Windows drives. Keep large genome datasets in the WSL filesystem for best
performance.

The backend keeps its configuration and caches in
`~/.local/share/ensembl-go/user-data` in WSL, outside the per-version backend
directories, so they carry over when the bundled backend changes. Uninstalling
from Windows leaves everything under `~/.local/share/ensembl-go/` in place.

Work through [WINDOWS_TEST_CHECKLIST.md](./WINDOWS_TEST_CHECKLIST.md) for the
setup screen, retry flow, and installer checks.

## macOS

### Unsigned local build

With the [build environment](#build-environment) active:

```bash
cd electron
npm run dist:mac:unsigned
```

This builds an unsigned DMG and zip, bundling MAFFT as described under
[MAFFT bundling](#mafft-bundling). It skips the Electron runtime check and the
species grouping refresh that the other `dist` commands run, so run those first
if you need them. The result is not signed or notarized, so use it for local
testing, not distribution.

### Signed and notarized release (not currently used)

`npm run dist` (`dist:mac:release`) builds a signed, notarized DMG and zip.
Its preflight, `scripts/check-macos-release-prereqs.js`, stops unless a
`Developer ID Application` certificate is in the keychain and notarization
credentials are set: `APPLE_API_KEY_PATH`, `APPLE_API_KEY_ID` and
`APPLE_API_ISSUER`; or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`; or a notarytool keychain profile (`APPLE_KEYCHAIN` and
`APPLE_KEYCHAIN_PROFILE`).

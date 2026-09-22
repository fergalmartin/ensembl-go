# Release Packaging

Use this when creating distributable artifacts for other users. Sections 0-3 cover
macOS; Windows and Linux have their own sections at the end.

Each platform packages its backend differently, and this is the main thing to keep
in mind when releasing:

| Target  | Backend shipped as                               | Must be built on |
| ------- | ------------------------------------------------ | ---------------- |
| macOS   | native PyInstaller executable in app resources   | macOS            |
| Linux   | native PyInstaller executable in app resources   | Linux            |
| Windows | Python source tree, run through WSL at first use | Windows          |

PyInstaller emits a host-native executable, so the macOS and Linux targets cannot be
cross-built. `check-backend-prereqs.js` refuses a target that does not match the host
rather than letting a long build silently package a foreign binary.

## 0) Release preflight

Run from a clean source checkout before packaging:

```bash
npm --prefix frontend ci
npm --prefix electron ci
python3 -m pip install -r backend/requirements.txt
python3 -m pytest backend/tests -q
python3 -m py_compile backend/main.py backend/download_manager.py backend/security_utils.py backend/assembly_report.py backend/genome_identity.py backend/stats_utils.py backend/trackhub_registry.py
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend audit --omit=dev
npm --prefix electron audit --omit=dev
python3 backend/scripts/check_classification_coverage.py
```

Expected notes:

- Frontend build may warn about the large main bundle; that is a performance
  backlog item, not a release blocker.
- Frontend lint may report warnings; packaging should stop only on lint errors.
- The backend dependency set is constrained by `backend/constraints.txt`.

### Species grouping artifacts

The download view groups species (Mammals, Insects, Plants and so on) using
`backend/data/taxonomy_classification.json`, which maps each catalogue taxid to its
NCBI lineage. That artifact does most of the work: with it, every species in the
catalogue it was generated against lands in a real group, and without it the name
heuristic leaves roughly a third of them in "Other".

The artifact is generated at build time, but the species catalogue is downloaded at
run time and Ensembl keeps adding to it, so coverage decays. Species the artifact does
not cover fall back to the heuristic.

**The distribution builds handle this themselves.** `dist:mac:release`, `dist:win` and
`dist:linux` all run `npm run refresh:classification` before packaging, so a release
cannot ship a stale artifact by accident. That step:

1. downloads the current species catalogue (small) and measures coverage;
2. stops there if coverage is within 1%, which costs about a second;
3. otherwise downloads the NCBI taxdump (~76 MB), regenerates the artifact, and
   refreshes `project_classification.json` too.

To run it by hand, or to see where things stand without building:

```bash
npm --prefix electron run refresh:classification          # refresh if needed
python backend/scripts/check_classification_coverage.py   # report only, changes nothing
```

Useful arguments, passed through the npm script after `--`:

```bash
npm --prefix electron run refresh:classification -- --force
npm --prefix electron run refresh:classification -- --max-uncovered-percent 0.5
```

The taxdump is cached under `backend/cache/build/`. NCBI rebuilds it daily, so the
cache only helps for repeated builds on the same day; it is safe to delete.

The underlying generators, `backend/scripts/generate_taxonomy_classification.py` and
`generate_project_classification.py`, can still be run directly if you need to point at
a specific catalogue or taxdump. Both take `--audit-only` to report without writing.

`check-backend-prereqs.js` additionally fails the build if either artifact is missing,
since a package without them mis-groups a large share of the catalogue.

### Reading the npm audit output

`npm audit` without `--omit=dev` reports a large number of findings for both
packages. Those are build tooling — Vite, Rollup, PostCSS, electron-builder and
its dependencies — which runs on the build machine and is never shipped. The
`--omit=dev` runs above are the ones that gate a release, and they cover what
actually reaches users.

Do not run `npm audit fix --force` to clear the noise. Nearly all of these need
major version bumps, and `--force` would silently change Electron and
electron-builder majors mid-release.

**The production audit has one blind spot.** `electron` is a devDependency, so
`--omit=dev` ignores it, but electron-builder bundles the Electron *runtime
binary* into the shipped application. An unsupported Electron therefore ships
unpatched Chromium to users while the audit reports zero production
vulnerabilities. Check it explicitly:

```bash
npm --prefix electron run check:electron-runtime
```

Electron supports only the latest three majors. The check compares the bundled
version against the current release and, because the runtime is currently within
that window, runs in `--strict` mode: it **fails** the release builds if the
bundled Electron falls out of support. That is deliberate — it is what stops the
runtime drifting out of support unnoticed again. If you ever need to ship from an
unsupported runtime knowingly, drop `--strict` from the `check:electron-runtime`
script rather than removing the check.

Desktop security smoke checks:

- The backend binds to `127.0.0.1` by default.
- `/api/health` responds without a token.
- `/api/config` returns 401 when `ENSEMBL_LOCAL_API_TOKEN` is set and the token
  header is missing.
- Remote genome downloads and Track Hub imports reject non-HTTPS/private-host
  URLs.
- Deleting a local file outside `output_dir/local_data` is rejected.

## 1) Configure Apple signing + notarization

### Code signing certificate
Install a `Developer ID Application` certificate in your login keychain.

Check:

```bash
security find-identity -v -p codesigning
```

You should see at least one identity containing `Developer ID Application`.

### Notarization credentials
Set one of these credential sets before building:

API key method:

```bash
export APPLE_API_KEY_PATH=/absolute/path/AuthKey_XXXX.p8
export APPLE_API_KEY_ID=XXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

or Apple ID method:

```bash
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=ABCDE12345
```

## 2) Build distributable artifacts

```bash
cd electron
npm run dist
```

This command:
- runs a preflight check for signing/notarization
- bundles MAFFT into app resources by default, enabling multiple genic-region
  alignments with annotation overlays
- builds signed/notarized `dmg` and `zip`

If MAFFT is not on PATH, point to an installation root (must contain `bin/mafft` and `libexec/mafft`):

```bash
export MAFFT_BUNDLE_ROOT=/absolute/path/to/mafft/install/root
npm run dist
```

MAFFT is optional for the rest of the application. To package without
multiple-alignment support:

```bash
SKIP_MAFFT_BUNDLE=1 npm run dist
```

Output folder:

`electron/dist`

## 3) Validate artifacts before sharing

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Ensembl Go.app"
spctl -a -t exec -vv "dist/mac-arm64/Ensembl Go.app"
xcrun stapler validate "dist/Ensembl Go-1.0.0-mac-arm64.dmg"
```

Launch the app once from the generated DMG/ZIP and smoke test:

- Home screen renders.
- Backend status reaches ready.
- File selection works.
- If MAFFT is bundled, Feature Alignment succeeds with at least three genomes
  and displays their annotation overlays.
- Screenshot/export save writes the expected file extension.

## Unsigned local packaging (not for distribution)

```bash
cd electron
npm run dist:mac:unsigned
```

## Windows packaging

The supported Windows target is now:

- native Electron shell on Windows
- Python backend running inside Ubuntu or Debian WSL over `http://127.0.0.1:8000`

This means the Windows package no longer builds or ships a native backend executable. Instead it bundles the backend source tree into the app and launches it through `wsl.exe` at runtime.

From a Windows build machine:

```powershell
cd electron
npm run dist:win
```

For a faster first pass before generating the installer:

```powershell
cd electron
npm run dist:win:dir
```

Notes:

- Host-side Python is no longer required for `dist:win`.
- MAFFT is optional and is not bundled into the Windows package. Install it
  inside WSL only for multiple genic-region alignments with annotation
  overlays.
- The packaged Windows app will show a setup screen with exact copyable WSL commands if the backend is not ready yet.
- By default the setup flow now creates a local WSL virtualenv under the bundled backend root and installs Python requirements there.
- Windows data paths inside the app must be WSL-visible Linux paths such as `/mnt/c/...`.
- A practical validation checklist lives in `WINDOWS_TEST_CHECKLIST.md`.

## Linux packaging

The supported Linux target mirrors macOS rather than Windows: a native Electron shell
plus a native PyInstaller backend bundled into app resources. There is no WSL step and
no host Python requirement for end users.

Targets produced are `AppImage` and `deb`.

### Build host

Because the backend is a native executable, **the Linux package must be built on
Linux**, and the build host's glibc sets the floor for what the package will run on.
Build on the oldest distribution you intend to support; a package built on current
Fedora will fail to start on Ubuntu LTS with a confusing loader error. Ubuntu 22.04 or
20.04 is a reasonable baseline. `verify-linux-backend.js` prints the glibc version it
built against so you can record it in the release notes.

Electron itself is not the binding constraint here. The bundled Electron 43 binaries
require at most `GLIBC_2.25` on both x86-64 and arm64, which every currently supported
distribution satisfies. The floor is set by the PyInstaller backend and its native
wheels (`pysam`, `pyBigWig`), so the build host is what decides compatibility.

The architecture follows the build host. Build on x86-64 for a conventional desktop
package; an arm64 host produces an arm64 package, with the backend and shell matching.
Do not pass an explicit `--x64`/`--arm64` that disagrees with the host, or the Electron
shell and the PyInstaller backend will not match.

### Prerequisites

```bash
sudo apt install python3 python3-venv python3-pip nodejs npm
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements-build.txt

npm --prefix frontend ci
npm --prefix electron ci
```

Optional, for multiple genic-region alignments:

```bash
sudo apt install mafft
```

### Build

```bash
cd electron
npm run dist:linux
```

This runs the same preflight and prebuild sequence as the other targets, verifies the
produced backend is an ELF binary matching the host architecture, then builds the
AppImage and deb. Output lands in `electron/dist`.

For a faster unpacked pass before generating installers:

```bash
cd electron
npm run dist:linux:dir
```

MAFFT is picked up from `PATH` and bundled by default. As on macOS, point at an
installation root explicitly, or skip it:

```bash
export MAFFT_BUNDLE_ROOT=/absolute/path/to/mafft/install/root   # contains bin/mafft and lib/mafft
SKIP_MAFFT_BUNDLE=1 npm run dist:linux                          # package without it
```

On Debian and Ubuntu the packaged `mafft` lays out as `/usr/bin/mafft` with its helper
binaries in `/usr/lib/mafft`, which the bundler already recognises.

### Validate artifacts before sharing

There is no code signing step on Linux. Smoke test both artifacts on a clean machine
that is not the build host:

```bash
cd electron
appimage="$(echo dist/*.AppImage)"
chmod +x "$appimage"
"$appimage"

sudo apt install "$PWD/$(echo dist/*.deb)"
ensembl-go
```

The AppImage keeps the `${productName}` naming used by the other platforms, so its
filename contains a space; quote it. The deb is named to Debian convention
(`ensembl-go_<version>_<arch>.deb`) because `apt` and `dpkg` are handled more easily
without one.

Then check:

- Home screen renders.
- Backend status reaches ready. This is the important one: it is what fails if the
  backend was not bundled or does not match the host.
- File selection works, and a chosen output directory outside `$HOME` is writable.
- If MAFFT is bundled, Feature Alignment succeeds with at least three genomes
  and displays their annotation overlays.
- Screenshot/export save writes the expected file extension.

### Known Linux specifics

- The backend is a PyInstaller `--onefile` build, so it unpacks to a temporary
  directory on each launch. On hardened systems that mount `/tmp` with `noexec` it will
  fail to start; those users can set `TMPDIR` to an exec-capable path. Switching to
  `--onedir` would remove the caveat and start faster, at the cost of a larger and less
  tidy resource tree.
- Electron's `chrome-sandbox` helper needs to be setuid root. The AppImage runtime and
  the deb's post-install script both handle this. A plain unpacked tarball does not,
  which is why one is not produced.
- `snap` is deliberately not a target. Its confinement interferes with launching the
  bundled backend and with reaching user-chosen output directories outside the snap's
  own writable area.
- User data goes to `~/.config/Ensembl Go`, which Electron passes to the backend. The
  backend's own fallback, used only when that variable is absent, is `~/.ensembl_go`.

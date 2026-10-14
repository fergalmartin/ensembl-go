# Windows Test Checklist

Use this on a real Windows machine to test the experimental Windows build. How
that build works, and how to produce it, is in
[RELEASE.md](./RELEASE.md#windows). In short:

- native Electron app on Windows
- backend running in a virtual environment inside Ubuntu or Debian WSL 2
- frontend and backend talking over `http://127.0.0.1:8000`

## 1) Build

Build the unpacked app and the installer as described in
[RELEASE.md](./RELEASE.md#build), using `npm ci` for the dependencies.
`dist:win:dir` needs no Windows Python; `dist:win` needs one for the species
grouping refresh.

After `npm run dist:win:dir`, check:

- `electron\dist\win-unpacked\Ensembl Go.exe` exists.
- `electron\build_backend\windows\backend_source\backend\main.py` exists.
- `electron\dist\win-unpacked\resources\backend_source\backend\main.py` exists.
- No `alignment_server.exe` is expected for the Windows target.

After `npm run dist:win`, check:

- `electron\dist\Ensembl Go-<version>-win-x64.exe` exists.
- `electron\dist\Ensembl Go-<version>-win-x64.zip` exists.

## 2) First launch and setup screen

Install a WSL 2 distro such as Ubuntu or Debian, and verify its version with
`wsl -l -v`. Then launch either:

- `electron\dist\win-unpacked\Ensembl Go.exe`, or
- the NSIS `.exe` installer, then the app from the Start Menu/Desktop shortcut.

Verify:

- The app opens to the Windows backend setup screen if the backend is not already running.
- If `uv` is available in WSL and the new backend has no environment, the app shows automatic setup progress, installs requirements into `backend/.venv`, and then launches the backend.
- The setup banner shows backend connection status. The setup cards follow this order:
  - WSL
  - WSL 2 distro
  - backend files copied to the native WSL filesystem
  - backend virtual environment
  - Python dependencies
  - optional MAFFT in WSL
- The backend files and `.venv` are under `~/.local/share/ensembl-go/backend/<source-hash>/backend/` in WSL, not under `/mnt/c`.
- If automatic setup fails, the screen keeps the error and offers selectable `uv` (when detected) and Python venv commands. The system Python package command appears only with the Python venv option.

## 3) WSL dependency setup

If automatic setup fails, open Ubuntu or Debian WSL 2, select one setup method,
and use its commands.
The `uv` method uses Python 3.12, downloading a user-managed interpreter if
needed. The Python venv method needs `python3` and `python3-venv` in WSL. No
global Python packages are needed.

For the Python venv method, confirm these steps succeed:

```bash
sudo apt update && sudo apt install -y python3 python3-venv # only if Python is missing
python3 -m venv '<path shown by the app>/backend/.venv'
'<path shown by the app>/backend/.venv/bin/python' -m pip install -r '<path shown by the app>/backend/requirements.txt'
```

When `uv` is installed in WSL, its selected option instead shows `uv venv
--python 3.12` and `uv pip install --python` commands targeting the same
`backend/.venv`. The first system package command is not shown in this mode.

To enable multiple alignments of genic regions with annotation overlays:

```bash
sudo apt install -y mafft
```

The exact backend path should come from the app's setup screen. It is based on the bundled source contents and remains in the distro's native filesystem.
If you already manage your own WSL virtual environment, you can keep doing that by setting `ENSEMBL_LOCAL_WSL_PYTHON` before launching the app.

## 4) Retry flow

After running the WSL commands:

- click `Retry connection`
- if the backend still is not up, click `Retry launch`

Verify:

- The app transitions out of the setup screen automatically once `/api/health` responds.
- Restarting the app re-attaches cleanly if the backend is already healthy.
- `/api/health` remains reachable without a token, while other `/api/*` calls use the per-launch token shown in the generated manual backend command.

## 5) Runtime smoke test

After the backend is connected, verify:

- **Help → Backend setup…** reopens setup while the backend is running, shows its installation directory with **Copy path**, and **Return to app** restores the app view.
- The home screen renders correctly.
- The genome/file browser works using WSL-visible paths.
- Windows-hosted files can be reached through `/mnt/c/...`.
- Configuration and cache files appear under `~/.local/share/ensembl-go/user-data/cache` in WSL, not inside the `backend/<source-hash>/` directory.
- After installing a build with a changed backend, the chosen output directory and other settings are still in place.

## 6) Feature Alignment test

Verify:

- If MAFFT is installed, Feature Alignment succeeds with at least three genomes
  through the WSL backend and displays their annotation overlays.
- If MAFFT is intentionally missing, the setup screen marks it as optional and
  still allows the backend to launch.
- If the backend is manually launched, use the setup screen's full command so `ENSEMBL_LOCAL_API_TOKEN` matches the Electron session.

## 7) Installer polish checks

If you installed the NSIS artifact, verify:

- Installer icon is the Ensembl icon.
- Installer allows choosing the destination directory.
- Start Menu shortcut is created.
- Desktop shortcut is created.
- App icon displays correctly in Start Menu and taskbar.
- Uninstall entry appears as `Ensembl Go`.

## 8) Uninstall behavior

- Uninstall the app from Windows Settings or the uninstaller.
- Confirm the app binaries are removed.
- Confirm `~/.local/share/ensembl-go/` in WSL, holding the backend copies and `user-data`, remains. The Windows uninstaller does not remove it; delete it by hand if needed.

## 9) Regression notes to capture

If anything fails, note:

- Windows version
- WSL distro and version from `wsl -l -v`
- Node version from `node --version`
- Whether the setup screen reported WSL, Python, or modules as the blocker
- The first failing command
- Any dialog/error text shown by the app

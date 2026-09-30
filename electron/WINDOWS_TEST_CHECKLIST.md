# Windows Test Checklist

Use this on a real Windows machine. The supported Windows path is:

- native Electron app on Windows
- backend running in a virtual environment inside Ubuntu or Debian WSL 2
- frontend and backend talking over `http://127.0.0.1:8000`

## 1) Build machine setup

- Install Node.js and npm on Windows.
- Install a WSL 2 distro such as Ubuntu or Debian; verify its version with `wsl -l -v`.
- Open a fresh PowerShell in the repo.
- Ensure frontend and Electron dependencies are installed:

```powershell
npm --prefix frontend install
npm --prefix electron install
```

Host-side Python is not required for `dist:win`.

## 2) Fast smoke build

Run the unpacked Windows build first:

```powershell
cd electron
npm run dist:win:dir
```

Check:

- `electron\\dist\\win-unpacked\\Ensembl Go.exe` exists.
- `electron\\build_backend\\windows\\backend_source\\backend\\main.py` exists.
- `electron\\dist\\win-unpacked\\resources\\backend_source\\backend\\main.py` exists after packaging.
- No `alignment_server.exe` is expected for the Windows target anymore.

## 3) Installer build

Build the installer artifacts:

```powershell
cd electron
npm run dist:win
```

Check:

- `electron\\dist\\Ensembl Go-<version>-win-x64.exe` exists.
- `electron\\dist\\Ensembl Go-<version>-win-x64.zip` exists.

## 4) First launch and setup screen

Launch either:

- `electron\\dist\\win-unpacked\\Ensembl Go.exe`, or
- install the NSIS `.exe` and launch from the Start Menu/Desktop shortcut.

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

## 5) WSL dependency setup

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

## 6) Retry flow

After running the WSL commands:

- click `Retry connection`
- if the backend still is not up, click `Retry launch`

Verify:

- The app transitions out of the setup screen automatically once `/api/health` responds.
- Restarting the app re-attaches cleanly if the backend is already healthy.
- `/api/health` remains reachable without a token, while other `/api/*` calls use the per-launch token shown in the generated manual backend command.

## 7) Runtime smoke test

After the backend is connected, verify:

- **Help → Backend setup…** reopens setup while the backend is running, shows its installation directory with **Copy path**, and **Return to app** restores the app view.
- The home screen renders correctly.
- The genome/file browser works using WSL-visible paths.
- Windows-hosted files can be reached through `/mnt/c/...`.
- Cache files appear under `%LOCALAPPDATA%\\AlignmentViewer\\cache`.

## 8) Feature Alignment test

Verify:

- If MAFFT is installed, Feature Alignment succeeds with at least three genomes
  through the WSL backend and displays their annotation overlays.
- If MAFFT is intentionally missing, the setup screen marks it as optional and
  still allows the backend to launch.
- If the backend is manually launched, use the setup screen's full command so `ENSEMBL_LOCAL_API_TOKEN` matches the Electron session.

## 9) Installer polish checks

If you installed the NSIS artifact, verify:

- Installer icon is the Ensembl icon.
- Installer allows choosing the destination directory.
- Start Menu shortcut is created.
- Desktop shortcut is created.
- App icon displays correctly in Start Menu and taskbar.
- Uninstall entry appears as `Ensembl Go`.

## 10) Uninstall behavior

- Uninstall the app from Windows Settings or the uninstaller.
- Confirm the app binaries are removed.
- Confirm user cache under `%LOCALAPPDATA%\\AlignmentViewer\\cache` is preserved unless you intentionally delete it.

## 11) Regression notes to capture

If anything fails, note:

- Windows version
- WSL distro and version from `wsl -l -v`
- Node version from `node --version`
- Whether the setup screen reported WSL, Python, or modules as the blocker
- The first failing command
- Any dialog/error text shown by the app

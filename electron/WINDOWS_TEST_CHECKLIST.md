# Windows Test Checklist

Use this on a real Windows machine. The supported Windows path is:

- native Electron app on Windows
- backend running inside Ubuntu or Debian WSL
- frontend and backend talking over `http://127.0.0.1:8000`

## 1) Build machine setup

- Install Node.js and npm on Windows.
- Install a WSL distro such as Ubuntu or Debian.
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
- The setup screen shows status rows for:
  - backend health
  - WSL
  - default distro
  - backend source bundle
  - Python in WSL
  - Python modules in WSL
  - optional MAFFT in WSL
- The setup screen shows copyable commands for package install, Python dependency install, and manual backend launch.

## 5) WSL dependency setup

Inside Ubuntu or Debian WSL, use the commands shown in the app.

At minimum, confirm these steps succeed:

```bash
sudo apt update && sudo apt install -y python3 python3-pip python3-venv
python3 -m venv '<path shown by the app>/.venv'
'<path shown by the app>/.venv/bin/python' -m pip install --upgrade pip
'<path shown by the app>/.venv/bin/python' -m pip install -r '<path shown by the app>/backend/requirements.txt'
```

To enable multiple alignments of genic regions with annotation overlays:

```bash
sudo apt install -y mafft
```

The exact backend path should come from the app's setup screen, because it depends on whether you are using `win-unpacked` or the installed app.
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

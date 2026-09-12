# Starting self-contained, and handing the session back

Two properties make a tutorial safe to run, and both are worth more than any step in it:

**A tutorial is a sandbox.** It never writes the user's configuration. It publishes a
`configOverride` — a scratch directory inside their output directory, and its own set of
active genomes — which App layers over the real one. So there is nothing to restore when it
ends, nothing to recover if the app is killed mid-run, and no dialogue asking what they
would like to keep.

**Leaving simply hands the session back.** There is no snapshot to roll back, because
nothing of the user's was changed.

A new tutorial has to *keep* both properties. They are not automatic: every round of
refinement found another thing the override did not cover.

## What starting does

`start()` in `frontend/src/hooks/useTutorial.jsx`, in this order — and the order is the
substance:

1. **`resetTutorialWorkspace(root)`** — clears anything an interrupted run left behind, so
   every run begins from the same state. The app does this at launch too.
2. **`createTutorialWorkspace(root)`** → `<output_dir>/.ensembl_go_tutorial`.
3. **Install every embedded dataset** into that workspace, and `registerTutorialGenome` each
   one (`POST /api/tutorial/session`) so the backend will resolve it — the override is a
   frontend fact and the browser resolves genomes server-side.
4. **`resolveDatasetGenomes`** maps each installed record onto the record *the app's own
   catalogue* lists. The two disagree about dataset release and therefore about genome
   identity; selecting the installer's record leaves a pill in the top bar whose own row in
   the list below still reads as unselected.
5. **`setTutorialSandboxActive(true)`** — raised *before* the override exists, so nothing can
   persist the temporary blank state in the window before React publishes it.
6. **`setConfigOverride({ output_dir: workspace, ...SANDBOX_BLANK_FIELDS, ...settings, active_species })`**.
7. State initialised, autoplay off.

`SANDBOX_BLANK_FIELDS` is what makes the scene self-contained rather than the user's scene
with extra genomes in it: `active_species`, `manual_species`, `genome_playlists`,
`selected_genome_playlist_id`, `next_previous_session_genomes`, and the reference/comparison
file fields. Without these the user's own genomes, manual entries and playlists sit alongside
the tutorial's all the way through. **Add to that list if a tutorial needs another kind of
the user's data hidden.**

### What guards the real configuration

In ascending order of how much they can be relied on:

1. `setConfig` in App refuses while the sandbox is up — one choke point, many callers.
2. `fetchConfig` is suppressed, or it would read the sidecar for the scratch directory and
   write its empty genome list over the real one in state.
3. `apiFetch` refuses config writes outright — `isBlockedDuringTutorial` in
   `frontend/src/tutorials/sandbox.js` blocks any non-GET to `/api/config*`. Reads are fine;
   a tutorial shows the real configuration view.
4. The backend will not store an `output_dir` naming a tutorial workspace.

The first three are timing-dependent. **The fourth is not, and is the one that actually
guarantees it.** Anything new a tutorial can write needs a guard of the fourth kind.

## What the sandbox does not cover

The override is a *frontend configuration* fact, which is a smaller claim than it sounds.
Each of the following leaked at least once and had to be handled separately:

| Not covered | Fix |
| --- | --- |
| The backend's idea of which genomes exist | `POST /api/tutorial/session` registers them for the life of the process |
| Notes | Every notes endpoint resolves its store from `load_config()` — the *real* config. `main._notes_config` swaps in the tutorial workspace while a session is registered, and drops the global store from the merge |
| The browser's own controls — Detail, Flatten, the gene-class filter, the track master switch | `preTutorialViewRef` in `GenomeBrowserView.jsx` snapshots on the way in and restores on the way out |
| The focused gene | Lives in App state, not config. `preTutorialBrowserFocusRef` in `App.jsx` |
| Anything derived from a focused gene | Focusing pushes the name into the comparison-view inputs, which look it up against the user's reference genome |

**The rule for anything new:** snapshot and restore if it is the user's, or suppress while
the sandbox is up if it is meaningless during a tutorial. **Assume a new surface is in this
category until shown otherwise** — in particular, anything that reaches for `load_config()`
rather than for the frontend's configuration.

## What leaving does

`teardown()` — and the order matters again:

- The sandbox flag is lowered **only once the override is gone**, so the writes that follow
  are unambiguously the user's own.
- Autoplay, the pulse, the cursor, `readyStepId`, `runtimeProblem` and the selector-list
  presentation are all cleared.
- `dialogRequest` is set to `'none'`, so a run that ends with a dialog open closes it rather
  than leaving it over the app.
- Browser interaction is reset to `'all'` — **a limit one step wanted must not follow the
  reader out**, whatever the last step asked for.
- `clearTutorialGenome()` drops the backend session.
- `resetTutorialWorkspace(root)` removes the scratch directory, fire-and-forget: the user is
  already back in their own session, and a failed cleanup is swept at next launch.

The same teardown runs for Exit, for Finish, and for a tutorial abandoned by navigating away.
**Check all three.** A tutorial that only cleans up on Finish leaves the sandbox standing for
anyone who pressed Exit, which is most readers.

## What to verify, every time

1. **The configuration file is byte-identical** before and after a complete run. Diff it
   directly — do not eyeball the UI.
2. **Nothing leaked into the user's lists** — no tutorial genomes in the selector, no tutorial
   playlists, no tutorial notes.
3. **Nothing is left on disk** but `.ensembl_go_tutorial`, and that goes on exit.
4. **The three exits** — Finish, Exit, and navigating away mid-run — all land the user back
   in the session they had: the same focused gene, the same browser switches, the same
   active genomes, the same view.
5. **The start is the same every time.** Run the tutorial twice in a row without restarting
   the app. The second run must look exactly like the first, including after a first run that
   was abandoned halfway.
6. **Interrupt it.** Kill the app mid-run and relaunch: the workspace should be swept at
   launch and the user's configuration untouched.
7. **A step's own state does not survive it** — a `genomeSelection`, a `dialog`, a
   `browserControls` or an `interaction: 'zoom-only'` set by the last step must not still be
   in force afterwards.

The handoff records that the browser-tutorial run was checked this way and the configuration
was byte-identical throughout, with nothing left behind. That is the standard to meet.

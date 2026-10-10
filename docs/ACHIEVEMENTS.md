# Achievements

Achievements rewards exploration of Ensembl Go. Open it from Home or add it to
the top bar. Progress is tracked silently until **Enable achievements** is
pressed, which unlocks achievement #1 and reveals earlier progress. Top-bar
visibility does not affect tracking.

## Code layout

| Part | File |
|---|---|
| The list of achievements (data only) | `frontend/src/achievements/catalogue.js` |
| Every id ever shipped, with its number | `frontend/src/achievements/achievements.lock.json` |
| Rule evaluation (pure functions) | `frontend/src/achievements/rules.js` |
| Tracker: recording, unlocking, syncing, time | `frontend/src/achievements/tracker.js` |
| View, medal, unlock toast | `frontend/src/components/achievements/` |
| Store format, merging, disk | `backend/achievements_store.py` |
| Store paths, endpoints, download/delete events | `backend/routes/achievements.py` |
| Tests | `frontend/tests/achievements.test.js`, `backend/tests/test_achievements_store.py` |

## Adding an achievement

1. Append an entry to `ACHIEVEMENTS` in `catalogue.js` with the **next unused number**
   and a new snake_case `id`.
2. Add `{ id, number }` to `achievements.lock.json`.
3. If its rule waits for a new event, add one
   `trackAchievement('area.event')` call next to code that already runs when the user
   does the thing. Use `trackAchievement('area.set', key)` for "N different things" and
   `raiseAchievementCount('area.count', n)` for totals read off existing state.
4. Run `npm --prefix frontend test` from the repository root. Tests reject:
   - an id was removed or renamed;
   - a number was changed or reused;
   - an id is missing from the lock file;
   - an event named in the catalogue is no longer recorded anywhere in `src/`.

Never rename or reuse an `id`: progress is stored under it. To withdraw an achievement,
set `retired: true`. It stays visible to people who unlocked it and leaves the totals.

### Rule types

| type | satisfied when | progress bar |
|---|---|---|
| `event` | the event has happened | no |
| `count` | the event has happened `target` times | yes, if `target > 1` |
| `distinct` | `target` different keys seen for `set` (only `keys`, if given) | yes, if `target > 1` |
| `taxon` | a downloaded genome's lineage includes any of `taxa` | no |
| `allOf` | every rule in `rules` | yes |
| `meta` | `target` achievements unlocked | yes |
| `duration` | `metric` has `targetMs` of active use | yes |

`source: 'backend'` marks rules whose facts the backend records itself: downloads,
deletions and GRCh37.

## Rules for call sites

Tracking must remain cheap on common interaction paths.

- **Only in intent handlers.** Call the tracker from click, change or commit handlers,
  or from a successful fetch. Never call it from render, `pointermove`, scroll,
  animation frames or effects on fast-changing state. An effect is fine when its
  dependencies are a few primitives that change only on user action (see
  `useNoteStore.jsx`).
- **Cheap once finished.** A call whose achievements are all unlocked is a `Set` lookup
  and a return.
- **Silent to React.** Nothing re-renders because something was tracked. Only the view
  and the toast subscribe.
- **Batched I/O.** Changes are sent to the backend in batches a few seconds later, and
  flushed with `keepalive` when the window is hidden.

## Tutorials

A running tutorial is a sandbox. The tracker ignores every event while
`isTutorialSandboxActive()` is true, except those in `TUTORIAL_ALLOWED_EVENTS`
(completion, autoplay, step jump).

The backend records a download or deletion only when it happens in the configured
output or working directory, and never while a tutorial session is registered. It
always resolves store paths from the saved configuration, never from a request.

Time spent in the app counts even during a tutorial.

## Enabling achievements and notifications

- **Tracking always runs.** Before achievements are switched on, unlocks are recorded
  silently and the view shows the cabinet greyed out and empty.
- **Switching on.** The Enable achievements button calls `enableAchievements()` and
  records `achievements.enabled` (#1). It stores `settings.enabled` in the achievements
  file, turns notifications on, and announces everything unlocked so far as a single
  notice. Because the switch is stored, the notice never repeats. Anyone who unlocked #1
  under the earlier rule (adding the view to the top bar) counts as switched on, and a
  reset keeps the switch and gives #1 straight back.
- **The toast.**
  - It stays for about five seconds, then fades.
  - Hovering holds it.
  - It has a close button, and clicking it opens the view at that achievement.
  - Unlocks that arrive together merge into "You've unlocked N achievements".
- **The toggle.** "Enable notifications" in the view is stored in the achievements file,
  so it follows the output directory.
- **Suppression.** Notifications are hidden during tutorials and screenshot mode.

## Storage and upgrades

Progress is stored in `<output_dir>/local_data/achievements.json`, beside
`user_notes.json`. The same file can also exist in the working directory and in the
cache directory, which is used before an output directory is set. Every copy is read
and merged, and writes go to the output directory.

Progress merges only move forwards:

- unlocks keep their earliest date;
- counters keep their highest value;
- sets and taxa take the union;
- durations keep their highest value.

An unlock is never taken back, even if a later version tightens its rule.

- **Unknown ids and fields** are carried through untouched.
- **A newer file.** A file with a higher `schema` is shown but never written, and a
  configuration warning says why.
- **A corrupt file** is renamed to `achievements.json.corrupt-<time>`, and a new one is
  started.
- **Every write** keeps the previous copy as `.bak`.
- **A reset** keeps a `.backup-<time>` of every copy, rewrites them all, and re-awards
  whatever is still true.

### Credit for what already exists

After the store loads, and after a reset, reconcilers re-derive what is already true:

- genomes on disk;
- notes, tasks and tags;
- playlists;
- custom genomes;
- genome colours;
- a rearranged button bar;
- completed tutorials.

Genome clades come from the lineages in `backend/data/taxonomy_classification.json`.
The Download view sends each species' taxid, which is kept in the genome manifest.
For older downloads without a taxid, the backend tries these sources
in order:

1. the Ensembl catalogue;
2. an assembly report;
3. the genome's name or genus.

A genome none of these can place still counts towards the download totals, but not
towards a clade.

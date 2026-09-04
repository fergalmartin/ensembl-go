import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const builder = readFileSync(new URL('../src/components/TutorialBuilderOverlay.jsx', import.meta.url), 'utf8')
const provider = readFileSync(new URL('../src/hooks/useTutorial.jsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/tutorials/demoGenomeApi.js', import.meta.url), 'utf8')
const selector = readFileSync(new URL('../src/components/GenomeSelectorView.jsx', import.meta.url), 'utf8')

test('picking and recording expose the whole app instead of leaving the builder panel over it', () => {
  assert.match(builder, /const captureMode = Boolean\(builder\.picking \|\| builder\.recording\)/)
  assert.match(builder, /\{renderBuilderPanel && <aside[\s\S]*data-tutorial-builder-panel="true"/)
  assert.match(builder, /pointer-events-none fixed left-1\/2 top-3/)
  assert.match(builder, /Recording tutorial actions/)
  assert.match(builder, /Select a tutorial target/)
})

test('Escape cancels target picking or stops recording and restores the builder', () => {
  assert.match(builder, /if \(event\.key !== 'Escape'\) return/)
  assert.match(builder, /document\.activeElement\?\.blur\?\.\(\)/)
  assert.match(builder, /picking: false,[\s\S]*recording: false/)
  assert.match(builder, /Recording stopped\. Review and annotate the captured steps\./)
  assert.match(builder, /Target selection cancelled\./)
})

test('builder transparency can fade the authoring chrome without losing its slider', () => {
  assert.match(builder, /aria-label="Builder transparency"/)
  assert.match(builder, /max="90"/)
  assert.match(builder, /const builderOpacity = Math\.max\(0\.1, 1 - \(builderTransparency \/ 100\)\)/)
  assert.match(builder, /data-tutorial-builder-transparency-control="true"/)
  assert.match(builder, /data-tutorial-builder-transparency-control="true" className=/)
  assert.match(builder, /window\.localStorage\.setItem\(BUILDER_TRANSPARENCY_KEY/)
  assert.match(builder, /opacity: builderOpacity/)
  const infoCard = builder.slice(builder.indexOf('data-tutorial-builder-info-card="true"'))
  assert.doesNotMatch(infoCard.slice(0, 900), /opacity: builderOpacity/)
})

test('the builder panel can be dragged wider or narrower from its left edge', () => {
  assert.match(builder, /BUILDER_DEFAULT_WIDTH = 470/)
  assert.match(builder, /aria-label="Resize tutorial builder"/)
  assert.match(builder, /onPointerDown=\{startBuilderResize\}/)
  assert.match(builder, /resize\.startWidth \+ resize\.startX - event\.clientX/)
  assert.match(builder, /style=\{\{ width: builderWidth, transform: builderPanelTransform \}\}/)
  assert.match(builder, /window\.localStorage\.setItem\(BUILDER_WIDTH_KEY/)
  assert.match(builder, /window\.innerWidth - cardSize\.width - 10/)
})

test('wider builder panels use horizontal space to reduce vertical scrolling', () => {
  assert.match(builder, /const wideBuilder = builderWidth >= 720/)
  assert.match(builder, /narrowBuilder \? 'grid-cols-\[154px_316px\]' : 'grid-cols-\[154px_1fr\]'/)
  assert.match(builder, /grid grid-cols-2 items-start gap-3/)
  assert.match(builder, /wideBuilder \? 'grid-cols-4' : 'grid-cols-2'/)
  assert.match(builder, /extraWideBuilder \? 'grid-cols-4' : wideBuilder \? 'grid-cols-3' : 'grid-cols-2'/)
  assert.match(builder, /min-w-\[470px\]/)
})

test('a highlighted control has an explicit interaction permission', () => {
  assert.match(builder, /Allow interaction with highlighted target/)
  assert.match(builder, /targetInstanceLabel\(selectedTarget\)/)
  assert.match(builder, /checked=\{highlightedTargetAllowed\}/)
  assert.match(builder, /sameTargetReference\(entry\.target, selectedTarget\)/)
})

test('the primary highlight can be removed or replaced by a live parameterised target', () => {
  assert.match(builder, /Primary highlighted target/)
  assert.match(builder, /No primary highlighted target/)
  assert.match(builder, /Remove primary highlight/)
  assert.match(builder, /setStepSpotlight\(step, null\)/)
  assert.match(builder, /additional highlighted targets were kept/)
  assert.match(builder, /if \(contract\.parameters\) \{[\s\S]*?picking: true,[\s\S]*?pickPurpose: 'spotlight'/)
})

test('replacing a primary highlight preserves unrelated allowed controls', () => {
  assert.match(builder, /removeStepTargetReferences\(step, previous\)/)
  assert.match(builder, /interactionPolicy = \{[\s\S]*?filter\([\s\S]*?!sameTargetReference\(entry\.target, target\)/)
  assert.doesNotMatch(builder, /step\.interactionPolicy = \{ targets: \[\] \}/)
  assert.match(builder, /Promoting an additional highlight to primary should not draw it twice/)
})

test('click completion and autoplay automatically grant their required interaction', () => {
  assert.match(builder, /const setManualCompletion = \(type\) => commitDocument/)
  assert.match(builder, /const setAutoplayCapability = \(capability\) => commitDocument/)
  assert.match(builder, /ensureStepInteraction\(step, target, capability\)/)
  assert.match(builder, /Activate the highlighted\/allowed control/)
  assert.match(builder, /When the highlighted\/allowed control is clicked/)
})

test('the builder can highlight several rows and wait for every allowed checkbox', () => {
  assert.match(builder, /Additional highlighted targets/)
  assert.match(builder, /Pick another highlighted target/)
  assert.match(builder, /step\.reveals = \[\.\.\.existing, \{ target: ref, ring: true \}\]/)
  assert.match(builder, /When every allowed control has been clicked/)
  assert.match(builder, /step\.advanceOn = \{ type: 'all-clicks', targets \}/)
  assert.match(builder, /step\.holdMs = 650/)
  assert.match(builder, /Activate every allowed control/)
  assert.match(provider, /progress\.selectors\.size >= anchors\.length/)
  assert.match(provider, /'checked' in node && !node\.checked/)
  assert.match(provider, /dispatchAfterHold\(\{ type: 'all-clicks', stepId: activeStep\.id \}\)/)
})

test('the builder can attach the eight-genome synthetic playlist fixture', () => {
  assert.match(builder, /Turtles &amp; friends · 8 fake genomes/)
  assert.match(builder, /generateTutorialFixture/)
  assert.match(builder, /fixture_id: TURTLES_AND_FRIENDS_FIXTURE_ID/)
  assert.match(builder, /turtlesAndFriendsDatasets\.length === 8/)
  assert.match(builder, /Attached to tutorial/)
  assert.match(builder, /Detach set/)
  assert.match(builder, /turtlesAndFriendsDatasets\.map\(\(dataset\) => dataset\.recipeId\)/)
})

test('attached generated datasets can be detached without touching other references', () => {
  assert.match(builder, /const detachTutorialDatasets = \(recipeIds/)
  assert.match(builder, /document\.datasets = \(document\.datasets \|\| \[\]\)\.filter/)
  assert.match(builder, /detachTutorialDatasets\(\[dataset\.recipeId\]\)/)
  assert.match(builder, /Use Undo to restore them/)
})

test('attached tutorial genomes can start all active, all inactive or as a custom set', () => {
  assert.match(builder, /Initially active genomes/)
  assert.match(builder, /Inactive genomes still appear in the selector and can be added to playlists/)
  assert.match(builder, /setInitialDatasetActivation\(true\)/)
  assert.match(builder, /setInitialDatasetActivation\(false\)/)
  assert.match(builder, /setInitialDatasetActivation\(event\.target\.checked, dataset\.recipeId\)/)
  assert.match(builder, /checked=\{tutorialDatasetStartsActive\(dataset\)\}/)
})

test('builder scenes use the tutorial sandbox and restore the author session on exit', () => {
  assert.match(builder, /prepareBuilderPreview\(current\.document/)
  assert.match(builder, /prepareBuilderStep\(current\.document/)
  assert.match(builder, /await stopBuilderPreview\(\)/)
  assert.match(provider, /const prepareBuilderPreview = useCallback/)
  assert.match(provider, /installTutorialDataset\(/)
  assert.match(provider, /const stopBuilderPreview = useCallback/)
  assert.match(app, /sandboxInactiveSnapshotRef/)
})

test('the selected builder step previews playback dimming and live spotlight geometry', () => {
  assert.match(builder, /data-tutorial-builder-presentation-preview="true"/)
  assert.match(builder, /cutoutPathD\(presentationGeometry\.size, presentationCutouts\)/)
  assert.match(builder, /visibleElementRect\(node, viewport\)/)
  assert.match(builder, /data-tutorial-builder-spotlight-ring="true"/)
  assert.match(builder, /Scene preview · Step/)
  assert.match(builder, />Reset scene</)
})

test('the builder preview separates adjacent authored highlight rings', () => {
  assert.match(builder, /const MULTI_HIGHLIGHT_INSET = -2/)
  assert.match(builder, /presentationEntries\[index\]\?\.ring && presentationRingCount > 1 \? MULTI_HIGHLIGHT_INSET : 6/)
  assert.match(builder, /style=\{\{ left: rect\.left, top: rect\.top, width: rect\.width, height: rect\.height \}\}/)
})

test('playlist edits in a tutorial scene update scratch config rather than being ignored', () => {
  assert.match(app, /if \(tutorialConfig\) \{[\s\S]*?updateSandboxConfig\(nextConfig\)/)
  assert.match(app, /if \(isTutorialSandboxActive\(\)\) \{[\s\S]*?updateSandboxConfig\(newConfig\)/)
  assert.match(provider, /const updateSandboxConfig = useCallback/)
})

test('the whole Genome Selector list is available as a spotlight target', () => {
  const selectorTargets = readFileSync(new URL('../src/tutorialTargets/genomeSelector.js', import.meta.url), 'utf8')
  const selectorView = readFileSync(new URL('../src/components/GenomeSelectorView.jsx', import.meta.url), 'utf8')
  assert.match(selectorTargets, /id: 'selector\.genomeList'/)
  assert.match(selectorTargets, /anchor: 'selector-genome-list'/)
  assert.match(selectorTargets, /label: 'Genome list'/)
  assert.match(selectorTargets, /id: 'selector\.genomeList'[\s\S]*?capabilities: \['spotlight'\]/)
  assert.match(selectorTargets, /presentation: \{ scrollIntoView: 'center', deferUntilReady: true \}/)
  assert.match(selectorView, /data-tour-id="selector-genome-list"/)
})

test('the Genome Selector shows ten rows and delegates vertical scrolling to the full-width page', () => {
  const selectorTargets = readFileSync(new URL('../src/tutorialTargets/genomeSelector.js', import.meta.url), 'utf8')
  const selectorView = readFileSync(new URL('../src/components/GenomeSelectorView.jsx', import.meta.url), 'utf8')
  assert.match(selectorView, /const LOCAL_PAGE_SIZE = 10/)
  assert.match(selectorTargets, /id: 'selector\.genomeList'[\s\S]*?capabilities: \['spotlight'\]/)
  assert.match(selectorView, /overflowAnchor: 'none'/)
  assert.match(selectorView, /className="overflow-x-auto overflow-y-hidden flex-1 min-h-0"/)
  assert.doesNotMatch(selectorView, /calc\(100vh - 440px\)/)
  assert.match(app, /data-tutorial-page-scroll=\{currentView === 'genome_selector'/)
  assert.match(app, /currentView === 'structural_variation' \|\| currentView === 'genome_selector'/)
  assert.match(app, /scrollContainerNode=\{mainContentNode\}/)
})

test('Genome Selector steps can frame a complete fixed list without granting scroll interaction', () => {
  const selectorView = readFileSync(new URL('../src/components/GenomeSelectorView.jsx', import.meta.url), 'utf8')
  assert.match(builder, /Genome list arrival state/)
  assert.match(builder, /Frame a fixed, complete genome list/)
  assert.match(builder, /fitAllRows: true/)
  assert.match(builder, /preserveOrder: true/)
  assert.match(builder, /lockScroll: true/)
  assert.match(builder, /This changes only the scene layout\. It does not highlight the list or allow interaction with it\./)
  assert.match(provider, /applySelectorListArrival/)
  assert.match(provider, /behavior: 'auto'/)
  assert.match(app, /tutorialListPresentation=\{tutorialRuntime\.selectorListPresentation\}/)
  assert.match(app, /const reserveTutorialSelectorPills = Boolean/)
  assert.match(app, /speciesList=\{topBarSpecies\}/)
  assert.match(app, /data-tour-id="app-genome-pills"/)
  assert.match(provider, /setSelectorListPresentation\(null\)[\s\S]*?\}, \[state\]\)/)
  assert.match(selectorView, /tutorialListPresentation\?\.preserveOrder/)
  assert.doesNotMatch(selectorView, /tutorial-fixed-genome-list/)
  assert.match(selectorView, /const centerFixedTutorialList = useCallback/)
  assert.match(selectorView, /genomeListRef\.current\?\.scrollIntoView/)
  assert.match(provider, /event\.target\.closest\('\[data-tutorial-blocker\]'\)/)
  assert.match(provider, /pageScroller\.scrollBy\(\{ left: event\.deltaX, top: event\.deltaY, behavior: 'auto' \}\)/)
  assert.match(provider, /event\.target\.closest\(entry\.selector\)/)
  assert.doesNotMatch(provider, /return \{ node, capabilities: entry\.capabilities/)
})

test('a step can be authored to arrive with the tutorial genomes already selected', () => {
  // The authoring problem this solves: selecting genomes is the previous step's work, so
  // a step about the pills strip previewed on its own showed an empty bar.
  assert.match(builder, /Selected genomes on arrival/)
  assert.match(builder, /Set which genomes are selected when this step opens/)
  assert.match(builder, /updateArrival\('genomeSelection', \{ genomes: \[\] \}\)/)
  assert.match(builder, /genomes: event\.target\.checked \? sceneSelectedRecipeIds\(\) : undefined/)
  assert.match(builder, /tutorial\.selectedDatasetRecipeIds\?\.\(\)/)
  // The scene is rebuilt when the arrival changes, so the checkboxes act on the preview.
  assert.match(builder, /arrive: selectedStep\.arrive/)

  assert.match(provider, /applyGenomeSelectionArrival/)
  assert.match(provider, /rememberDatasetGenomes\(datasets, datasetGenomes\)/)
  // Selecting what the catalogue lists, so the pill in the top bar and the row in the
  // list below agree that the genome is chosen.
  assert.match(provider, /const resolveDatasetGenomes = useCallback/)
  assert.match(provider, /bySpecies\.get\(String\(record\.species_key \|\| ''\)\) \|\| record/)
  assert.match(api, /export async function fetchTutorialGenomeRecords/)
  // Both the builder's step preview and playback establish it, so a skipped or
  // re-entered step finds the same selection.
  assert.equal(provider.match(/if \(arrival\.type === 'genomeSelection'\) await applyGenomeSelectionArrival\(arrival\)/g)?.length, 2)
  // Selecting is a set, not a toggle: repeating it must not disturb the running step.
  assert.match(provider, /if \(same\) return previous/)

  // The records the arrival resolves against are rebuilt whenever the scene is reused,
  // not only when it is installed, or a reused scene selects nothing at all.
  assert.match(provider, /rememberDatasetGenomes\(datasets, previous\.genomes\)/)
  assert.match(provider, /This step arrives with genomes selected, but none of them are installed/)
})

test('a selection applied on a delay states its intent instead of flipping what it finds', () => {
  // The Genome Selector holds a tick for a second before applying it. A tutorial step's
  // `arrive` can select the same genome in that window, and a blind toggle then took the
  // user's own selection straight back off again — one pill short, every time.
  assert.match(selector, /desired === 'selected' && alreadySelected/)
  assert.match(selector, /applySpeciesToggleNow\(item, 'selector', \{ desired: 'selected' \}\)/)
  // Checked against the live set: the callback was built before the genome was selected.
  assert.match(selector, /selectedGenomeKeysRef\.current\.has\(itemKey\(item\)\)/)
  assert.match(app, /const desired = options\?\.desired \|\| ''/)
  assert.match(provider, /if \(\(desired === 'selected' && alreadyPresent\) \|\| \(desired === 'deselected' && !alreadyPresent\)\) return/)
})

test('a fixed selector scene keeps the pills strip in the layout instead of hiding it', () => {
  const pills = readFileSync(new URL('../src/components/SelectedSpeciesPillsBar.jsx', import.meta.url), 'utf8')
  // Selecting a genome must show its pill arriving, which is the point of the step.
  assert.doesNotMatch(app, /hideTutorialSelectorPills/)
  assert.match(app, /const reserveTutorialSelectorPills = Boolean/)
  assert.match(app, /\(topBarSpecies\.length > 0 \|\| reserveTutorialSelectorPills\)/)
  // Held open but invisible while empty, so the first pill does not push the rows down.
  assert.match(app, /visibility: topBarSpecies\.length === 0 \? 'hidden' : undefined/)
  assert.match(app, /reserveRowHeight=\{reserveTutorialSelectorPills\}/)
  assert.match(pills, /export const PILLS_ROW_HEIGHT = 46/)
  assert.match(pills, /reserveRowHeight \? \{ minHeight: PILLS_ROW_HEIGHT \} : undefined/)
})

test('a step can be re-done after Back, and Next never unticks what the user has ticked', () => {
  // Both halves of the same bug: coming back to a selection step, redoing it by hand, and
  // finding the step neither advanced nor safe to press Next on.
  assert.match(provider, /const allClickProgressRef = useRef\(\{ stepId: '', selectors: new Set\(\), completed: false \}\)/)
  assert.match(provider, /allClickProgressRef\.current = \{ stepId: '', selectors: new Set\(\), completed: false \}\n {4}let cancelled = false/)
  assert.match(provider, /const ticksBoxes = stepAdvance\(forStep\)\.type === 'all-clicks'/)
  assert.match(provider, /if \(ticksBoxes && 'checked' in target && target\.checked\) continue/)
})

test('a step can open with the page scrolled where the author framed it', () => {
  // Authored as "this target, this far down the page area" rather than as a raw scroll
  // position, so the same number frames the same picture at another window height.
  assert.match(builder, /View position on arrival/)
  assert.match(builder, /const sceneViewOffset = \(\) => \{/)
  assert.match(builder, /node\.getBoundingClientRect\(\)\.top - scrollerTop/)
  assert.match(builder, /updateArrival\('pageScroll', \{ target: viewPositionTarget, offset \}\)/)
  assert.match(builder, /Use current position/)

  assert.match(provider, /const applyPageScrollArrival = useCallback/)
  assert.match(provider, /scroller\.scrollBy\(\{ top: delta, left: 0, behavior: smooth && !moved \? 'smooth' : 'auto' \}\)/)
  // Held, not set once: the selector rescans as the tutorial's output directory takes
  // effect, and a page shorter than its viewport clamps the scroll position back to zero.
  assert.match(provider, /attempt < PAGE_SCROLL_ATTEMPTS && held < 2/)
  assert.match(provider, /if \(!node\?\.getBoundingClientRect\) \{\n {8}await sleep\(SETTLE_MS\)\n {8}continue/)
  // The rescue scroll centres its target, which would throw away the composition.
  assert.match(provider, /if \(!cancelled && !positionsThePage\) await bringAnchorIntoView\(step\)/)
  assert.match(provider, /if \(!positionsThePage\) \{\n {6}resetBrowserScroll\(\)\n {6}await bringAnchorIntoView\(forStep\)/)
  // The browser panel's own "back to the top" owns the *shared* page scroller, so on a
  // Genome Selector step it threw away the position the arrival had just established.
  assert.match(provider, /if \(!cancelled && !positionsThePage\) resetBrowserScroll\(\)/)
  // Applied last: opening a dialog or filling the pills strip changes the page height.
  assert.match(provider, /\/\/ After the selection, which is the set the dialog opens for\./)
  // And the fixed selector scene must stop recentring the list on top of it.
  assert.match(provider, /applySelectorListArrival\(arrival, \{ center: !positionsThePage \}\)/)
  assert.match(selector, /tutorialListPresentation\?\.center === false/)
})

test('a step about the playlist dialog can open it, and the step before it can close it', () => {
  const selectorTargets = readFileSync(new URL('../src/tutorialTargets/genomeSelector.js', import.meta.url), 'utf8')
  assert.match(selectorTargets, /id: 'selector\.playlistDialog'/)
  assert.match(selectorTargets, /anchor: 'playlist-membership-dialog'/)
  assert.match(selectorTargets, /anchorTemplate: 'playlist-membership-checkbox-\{playlistId\}'/)
  assert.match(selectorTargets, /anchor: 'playlist-membership-new-name'/)
  assert.match(selectorTargets, /anchor: 'playlist-membership-save'/)
  assert.match(selector, /data-tour-id="playlist-membership-dialog"/)
  assert.match(selector, /data-tour-id=\{`playlist-membership-checkbox-\$\{playlist\.id\}`\}/)

  assert.match(builder, /Dialog on arrival/)
  assert.match(builder, /updateArrival\('dialog', \{ dialog: event\.target\.value \|\| undefined \}\)/)
  assert.match(provider, /const applyDialogArrival = useCallback/)
  assert.match(app, /tutorialDialogRequest=\{tutorialRuntime\.dialogRequest\}/)
  // The dialog opens for whatever is selected, so it matches pressing the button by hand.
  assert.match(selector, /genomes: selectedAssemblies,\n {12}addOnly: true,\n {12}preset: tutorialDialogRequest\.fields \|\| null,/)
  // A dialog filled in over three steps loses its text when Back re-establishes it, so a
  // step that expects the form already filled says so.
  assert.match(selector, /setNewPlaylistName\(\(current\) => \(preset \?/)
  assert.match(selector, /if \(dialog !== 'playlistMembership'\) \{\n {12}setPlaylistMembershipDialog\(null\)/)
  // A run that ends with the dialog open must not leave it sitting over the app.
  assert.match(provider, /setDialogRequest\(\{ dialog: 'none', requestedAt: Date\.now\(\) \}\)/)
})

test('leaving a step with unsaved wording asks rather than discarding it', () => {
  const overlay = readFileSync(new URL('../src/components/TutorialOverlay.jsx', import.meta.url), 'utf8')
  // Next, Back, Skip and Exit all leave the step, and all of them used to take a
  // half-rewritten sentence with them without a word.
  assert.match(overlay, /const guardLeaving = useCallback\(\(run, label\) => \(\) => \{/)
  assert.match(overlay, /onClick=\{guardLeaving\(next, isLastStep \? 'finish' : 'move on'\)\}/)
  assert.match(overlay, /onClick=\{guardLeaving\(back, 'go back'\)\}/)
  assert.match(overlay, /onClick=\{guardLeaving\(skip, 'skip this step'\)\}/)
  assert.match(overlay, /onClick=\{guardLeaving\(exit, 'exit the tutorial'\)\}/)
  // The move is held, not refused: all three answers are offered.
  assert.match(overlay, /data-tutorial-unsaved-prompt="true"/)
  assert.match(overlay, /Save and continue/)
  assert.match(overlay, /Discard them/)
  assert.match(overlay, /Keep editing/)
  // Only a save that actually wrote lets the held move run.
  assert.match(overlay, /const saved = await saveEditing\(\)\n {4}setPendingNavigation\(null\)\n {4}if \(saved\) held\?\.run\?\.\(\)/)
  // And a timer must not do what the button was stopped from doing.
  assert.match(overlay, /setEditing\(true\)\n {4}\/\/ Nothing should move the step on while someone is writing on it/)
})

test("a draft's words are saved into the draft, not into a definition file", () => {
  // The in-card editor rewrites the JavaScript a built-in tutorial ships from. A draft has
  // no such file, so every edit made while running one was refused by the backend — and
  // the card said "Saved." anyway, which is how it went unnoticed.
  assert.match(provider, /const savePortableStepFields = useCallback/)
  assert.match(provider, /const portable = await savePortableStepFields\(\{ \[id\]: \{ \[field\]: value \} \}\)/)
  assert.match(provider, /const result = portable\n {6}\? \{ saved: true, file: 'tutorial\.json' \}\n {6}: await saveStepText/)
  // A section heading is shared, so renaming it writes every step that carries it — in one
  // document save, or a failure halfway leaves the draft half renamed.
  assert.match(provider, /Object\.fromEntries\(affected\.map\(\(candidate\) => \[String\(candidate\.id\), \{ section: value \}\]\)\)/)

  const overlay = readFileSync(new URL('../src/components/TutorialOverlay.jsx', import.meta.url), 'utf8')
  assert.match(overlay, /if \(result\?\.saved !== true\) \{ refused\.push\(field\); continue \}/)
  assert.match(overlay, /could not be saved\. Your text is still here/)
})

test('a dialog a step fills in keeps whatever the reader wrote', () => {
  // The preset exists so Back does not land on "press Add genomes" beside an empty form.
  // It fills what is empty rather than replacing what is there, or advancing from the
  // description step would throw away the description the reader had just written.
  assert.match(selector, /setNewPlaylistDescription\(\(current\) => \(preset \? \(String\(current \|\| ''\)\.trim\(\) \? current : String\(preset\.description \|\| ''\)\) : ''\)\)/)
  // And the author can say which of the two rules a field follows.
  assert.match(builder, /Only this value will do/)
  assert.match(builder, /checked=\{Boolean\(authoredAction\.overwrite\)\}/)
})

test('the playlists a tutorial creates are part of the state a step establishes', () => {
  // Without this, every step after the creation step depends on having come from it, and
  // redoing the creation step fails outright: the app refuses a duplicate playlist name.
  assert.match(provider, /const applyPlaylistsArrival = useCallback/)
  assert.match(provider, /genome_playlists: playlists, selected_genome_playlist_id: nextSelectedId/)
  assert.match(provider, /const scenePlaylists = useCallback/)
  assert.match(builder, /Playlists on arrival/)
  assert.match(builder, /updateArrival\('playlists', \{ playlists: \[\], selected: undefined \}\)/)

  // A playlist the tutorial builds and one the user builds by hand have to hold the same
  // thing, so both go through one snapshot.
  const playlistGenomes = readFileSync(new URL('../src/utils/playlistGenomes.js', import.meta.url), 'utf8')
  assert.match(playlistGenomes, /export const snapshotGenomeForPlaylist/)
  assert.match(playlistGenomes, /export const playlistTourSlug/)
  assert.match(selector, /snapshotGenomeForPlaylist,\n\} from '\.\.\/utils\/playlistGenomes'/)
  assert.match(provider, /import \{ snapshotGenomeForPlaylist \} from '\.\.\/utils\/playlistGenomes'/)
})

test('the playlist bar, the popover and the pill crosses are tutorial targets', () => {
  const appTargets = readFileSync(new URL('../src/tutorialTargets/app.js', import.meta.url), 'utf8')
  const selectorTargets = readFileSync(new URL('../src/tutorialTargets/genomeSelector.js', import.meta.url), 'utf8')
  const pills = readFileSync(new URL('../src/components/SelectedSpeciesPillsBar.jsx', import.meta.url), 'utf8')

  // Keyed on the playlist's slugged name, because its id is minted at random when the
  // user creates it and the name is the part the tutorial dictates.
  assert.match(appTargets, /anchorTemplate: 'app-playlist-option-\{playlist\}'/)
  assert.match(selectorTargets, /anchorTemplate: 'selector-playlist-row-\{playlist\}'/)
  assert.match(app, /data-tour-id=\{`app-playlist-option-\$\{playlistTourSlug\(playlist\.name\)\}`\}/)
  assert.match(selector, /data-tour-id=\{`selector-playlist-row-\$\{playlistTourSlug\(playlist\.name\)\}`\}/)
  assert.match(selector, /data-tour-id=\{`selector-playlist-delete-\$\{playlistTourSlug\(playlist\.name\)\}`\}/)

  assert.match(appTargets, /anchorTemplate: 'genome-pill-remove-\{speciesKey\}'/)
  assert.match(pills, /data-tour-id=\{`genome-pill-remove-\$\{species\?\.species_key \|\| ''\}`\}/)

  // The popover is only a target while it is open; closed, it is a hidden shell that a
  // spotlight would draw around.
  assert.match(app, /data-tour-id=\{genomePlaylistPopoverOpen \? 'app-playlist-popover' : undefined\}/)
  assert.match(app, /setGenomePlaylistPopoverOpen\(dialog === 'playlistPopover'\)/)
})

test('builder highlight geometry is repaired immediately when a nested panel scrolls', () => {
  assert.match(builder, /document\.addEventListener\('scroll', repair, true\)/)
  assert.match(builder, /document\.removeEventListener\('scroll', repair, true\)/)
})

test('row and bulk playlist controls are available as tutorial targets', () => {
  const selectorTargets = readFileSync(new URL('../src/tutorialTargets/genomeSelector.js', import.meta.url), 'utf8')
  const selectorView = readFileSync(new URL('../src/components/GenomeSelectorView.jsx', import.meta.url), 'utf8')
  assert.match(selectorTargets, /id: 'selector\.addToPlaylist'/)
  assert.match(selectorTargets, /anchorTemplate: 'selector-playlist-\{genomeKey\}'/)
  assert.match(selectorTargets, /id: 'selector\.addSelectedToPlaylist'/)
  assert.match(selectorTargets, /anchor: 'selector-playlist-selected'/)
  assert.match(selectorView, /data-tour-id=\{`selector-playlist-\$\{itemKey\(item\)\}`\}/)
  assert.match(selectorView, /data-tour-id="selector-playlist-selected"/)
})

test('bulk playlist and removal actions start from the active selected genomes', () => {
  const selectorView = readFileSync(new URL('../src/components/GenomeSelectorView.jsx', import.meta.url), 'utf8')
  assert.match(selectorView, /const selectedAssemblies = useMemo/)
  assert.match(selectorView, /genomes: selectedAssemblies,[\s\S]*addOnly: true/)
  assert.match(selectorView, /setRemovalKeys\(new Set\(selectedAssemblies\.map\(\(item\) => itemKey\(item\)\)\)\)/)
  assert.match(selectorView, /flaggedItems\(allAssemblies, removalKeys\)/)
})

test('moving or resizing the information card temporarily removes the builder panel', () => {
  assert.match(builder, /setCardDragActive\(true\)/)
  assert.match(builder, /setCardDragActive\(false\)/)
  assert.match(builder, /const renderBuilderPanel = !captureMode && !cardDragActive/)
  assert.match(builder, /onPointerCancel=\{finishDrag\}/)
})

test('the builder can fully collapse so a card underneath it remains reachable', () => {
  assert.match(builder, /aria-label="Collapse tutorial builder"/)
  assert.match(builder, /data-tutorial-builder-restore="true"/)
  assert.match(builder, /aria-label="Expand tutorial builder"/)
  assert.match(builder, /setBuilderPanelCollapsed\(false\)/)
  assert.match(builder, /function BuilderChevronGlyph/)
  assert.match(builder, /strokeWidth="2\.2"/)
  assert.match(builder, /top-3/)
})

test('dragging narrower past the minimum collapses the builder on release', () => {
  assert.match(builder, /BUILDER_COLLAPSE_DRAG_THRESHOLD = 48/)
  assert.match(builder, /const overshoot = Math\.max\(0, BUILDER_MIN_WIDTH - rawWidth\)/)
  assert.match(builder, /resize\.collapseArmed = overshoot >= BUILDER_COLLAPSE_DRAG_THRESHOLD/)
  assert.match(builder, /if \(allowCollapse && resize\.collapseArmed\) setBuilderPanelCollapsed\(true\)/)
  assert.match(builder, /Release to collapse/)
  assert.match(builder, /translateX\(100%\)/)
})

test('the card value can be authored, and told which field it fills', () => {
  assert.match(builder, /Value offered on the card/)
  assert.match(builder, /Pressing it copies to the clipboard/)
  assert.match(builder, /Pressing it fills \{target\.label\}/)
  // Only a field can be filled, so only fields are offered.
  assert.match(builder, /const copyFillTargets = viewTargets\.filter\(\s*\(target\) => \(target\.capabilities \|\| \[\]\)\.includes\('input'\)/)
  // Stored as a target reference, like every other target a document names.
  assert.match(builder, /updateStep\('copyTarget', event\.target\.value \? targetRef\(event\.target\.value\) : null\)/)
  // And dropped with the value it belonged to, rather than left pointing at nothing.
  assert.match(builder, /if \(!value\.trim\(\) && selectedStep\?\.copyTarget\) updateStep\('copyTarget', null\)/)
})

test('a step can complete when the app reports what it asked for happened', () => {
  assert.match(builder, /const SIGNAL_COMPLETIONS = Object\.freeze\(\[/)
  assert.match(builder, /name: 'browser\.regionSearched'/)
  assert.match(builder, /When the browser moves to a searched region/)
  // Offered only where the signal can actually be emitted.
  assert.match(builder, /SIGNAL_COMPLETIONS\.filter\(\(entry\) => entry\.views\.includes\(selectedStep\?\.view\)\)/)
  assert.match(builder, /step\.advanceOn = \{ type: 'signal', name: signal\.name \}/)
  // The result appears away from the control, so the step gets a beat to be watched
  // arriving — suggested, not imposed on an author who already chose one.
  assert.match(builder, /if \(step\.holdMs === undefined \|\| step\.holdMs === null\) step\.holdMs = signal\.holdMs/)
  // And the select still shows the choice it made.
  assert.match(builder, /selectedStep\?\.advanceOn\?\.type === 'signal' \? `signal:\$\{selectedStep\.advanceOn\.name\}`/)
})

test('the card chip puts its value in the field when the step names one', () => {
  const overlay = readFileSync(new URL('../src/components/TutorialOverlay.jsx', import.meta.url), 'utf8')
  assert.match(overlay, /const copyFills = Boolean\(stepCopyTarget\(step\)\)/)
  // Filled before the clipboard, so a browser that refuses the clipboard cannot stop the
  // thing the reader actually pressed for.
  assert.match(overlay, /const filled = copyFills \? fillCopyValue\(\) : false[\s\S]*navigator\?\.clipboard/)
  assert.match(overlay, /title=\{copyFills \? 'Put this in the box' : 'Copy to the clipboard'\}/)
  assert.match(overlay, /copied \? \(copyFills \? 'Filled in' : 'Copied'\)/)
  // Filling leaves the field focused and does not submit: pressing Return is the reader's.
  assert.match(provider, /const fillCopyValue = useCallback/)
  assert.match(provider, /setNativeInputValue\(node, value\)\s*\n\s*if \(typeof node\.focus === 'function'\) node\.focus\(\)/)
  assert.doesNotMatch(
    provider.slice(provider.indexOf('const fillCopyValue'), provider.indexOf('const advancing')),
    /KeyboardEvent/
  )
})

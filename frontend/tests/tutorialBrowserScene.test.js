import test from 'node:test'
import assert from 'node:assert/strict'
import { browserSceneMatches, browserSceneProblems, tutorialSettings } from '../src/utils/tutorialBrowserScene.js'
import { targetRef, targetRefAnchor, targetRefSelector, targetRefFromAnchor } from '../src/tutorialTargets/index.js'
import { legacyTutorialToDocument, materializeTutorialDocument, validateTutorialDocument } from '../src/utils/tutorialDocument.js'
import document from '../src/tutorials/generated/multi-genome-browsing.tutorial.json' with { type: 'json' }

const actual = { active: ['human','mouse'], link: 'gene', pan: true, zoom: true, panels: {
  human: { ready: true, focus: 'SAMD11', chrom: '1', start: 100, end: 200, tracks: { forward:true, reverse:false, sequence:true } },
  mouse: { ready: true, focus: 'Samd11', chrom: '4', start: 900, end: 1000, tracks: { forward:false, reverse:true, sequence:true } },
} }
test('completion waits for each named genome and linking state, and matches symbol case', () => {
  const wanted = { active: ['human','mouse'], link:'gene', pan:true, zoom:true, panels:{human:{focus:'SAMD11'},mouse:{focus:'SAMD11'}} }
  assert.equal(browserSceneMatches(wanted, actual), true)
  for (const patch of [{active:['human']},{link:'none'},{zoom:false},{panels:{...actual.panels,mouse:{...actual.panels.mouse,focus:'OTHER'}}}]) assert.equal(browserSceneMatches(wanted, {...actual,...patch}),false)
  assert.equal(browserSceneMatches({panels:{mouse:{tracks:{forward:false,reverse:true,sequence:true}}}}, actual),true)
  assert.equal(browserSceneMatches({panels:{mouse:{tracks:{reverse:false}}}}, actual),false)
})
test('exact scenes require a locus; preserving a result leaves a manually moved view alone', () => {
  assert.equal(browserSceneMatches({panels:{human:{locus:'1:100-200'}}},actual),true)
  assert.equal(browserSceneMatches({panels:{human:{locus:'1:500-600'}}},actual),false)
  assert.equal(browserSceneMatches({preserveView:true,panels:{human:{locus:'1:500-600'}}},actual),true)
})
test('scoped browser references round-trip and cannot select another genome', () => {
  for (const name of ['browser.viewport','browser.toolbar','browser.locationSearch','browser.focusBar','browser.toggleGF']) {
    const ref=targetRef(name,{recipeId:'mouse'})
    assert.match(targetRefSelector(ref),/^\[data-tutorial-genome="mouse"\] /)
    assert.deepEqual(targetRefFromAnchor(targetRefAnchor(ref)),ref)
  }
  assert.equal(targetRefSelector(targetRef('browser.locationSearch')),'[data-tour-id="browser-location-search"]')
})
test('tutorial settings copy a palette and preserve inactive dataset order', () => {
  const genomes=[{key:'human'},{key:'refseq'}], settings={showInactivePills:true,genomeColors:['#112233','#445566']}
  const result=tutorialSettings({settings},genomes)
  assert.deepEqual(result.tutorial_selected_genomes,genomes)
  settings.genomeColors[0]='#abcdef'
  assert.equal(result.tutorial_color_palette[0],'#112233')
  assert.deepEqual(tutorialSettings({},genomes),{})
})
test('invalid scene identities, loci and track states are rejected', () => {
  assert.ok(browserSceneProblems({active:['absent']},[{recipeId:'human'}]).length)
  assert.ok(browserSceneProblems({panels:{human:{locus:'wrong',tracks:{reverse:'off'}}}},[{recipeId:'human'}]).length>=2)
})
test('the shipped tutorial clones into an editable portable document without losing scoped actions', () => {
  const { format: _format, schemaVersion: _version, ...runtime } = materializeTutorialDocument(document)
  const clone=legacyTutorialToDocument(runtime,{id:'multi-genome-copy'})
  assert.deepEqual(validateTutorialDocument(clone),[])
  assert.deepEqual(clone.settings,document.settings)
  assert.deepEqual(clone.steps.find(s=>s.id==='search-samd11').autoplay.action.target,document.steps.find(s=>s.id==='search-samd11').autoplay.action.target)
  assert.equal(clone.steps.length,document.steps.length)
  for (let i=0;i<clone.steps.length;i++) {
    assert.deepEqual(clone.steps[i].reveals, document.steps[i].reveals)
    assert.deepEqual(clone.steps[i].interactionPolicy, document.steps[i].interactionPolicy)
  }
})
test('every multi-genome step restores an explicit scene and each task waits for its actual result', () => {
  for(const step of document.steps){
    assert.equal(step.arrive[0].type,'browserScene')
    assert.ok(step.arrive[0].active.length)
    if(step.autoplay) {assert.equal(step.advanceOn.name,'browser.state');assert.ok(step.completeWhen)}
  }
})

test('exploration has portable autoplay moves while manual Next remains passive', () => {
  for (const id of ['independent', 'try-linked', 'browse-four', 'try-gene-link']) {
    const step = document.steps.find(s => s.id === id)
    assert.equal(step.action.type, 'none')
    assert.ok(step.autoplayDemo.moves.some(m => m.pan))
    assert.ok(step.autoplayDemo.moves.some(m => m.zoom))
    for (const move of step.autoplayDemo.moves) assert.ok(step.arrive[0].active.includes(move.panelKey))
    const { format: _format, schemaVersion: _version, ...runtime } = materializeTutorialDocument(document)
    const clone = legacyTutorialToDocument(runtime)
    assert.deepEqual(validateTutorialDocument(clone), [])
    assert.deepEqual(clone.steps.find(s => s.id === id).autoplayDemo, step.autoplayDemo)
  }
})
test('focused scenes use normal gene framing and all four strand switches precede Hide', () => {
  for (const step of document.steps) for (const panel of Object.values(step.arrive[0].panels)) {
    if (panel.focus) assert.equal(panel.locus, undefined)
  }
  const switches = document.steps.find(s => s.id === 'switch-strands')
  assert.equal(switches.autoplay.actions.length, 4)
  assert.equal(Object.keys(switches.completeWhen.panels).length, 4)
  const hide = document.steps.find(s => s.id === 'hide-inactive')
  assert.equal(hide.arrive[0].hideInactive, false)
  assert.equal(hide.completeWhen.hideInactive, true)
  assert.equal(browserSceneMatches({ hideInactive: true }, { hideInactive: false }), false)
  assert.equal(browserSceneMatches({ hideInactive: true }, { hideInactive: true }), true)
})

test('the cycle wheel is declared open or shut by every step that can see it', () => {
  // The wheel is a full-screen overlay, so a step that inherits it rather than declaring
  // it sits behind one. Every step from the one before the section to the one after it
  // has to say which it expects — that is what makes them reachable backwards.
  const ids = ['browse-four', 'cycle-button', 'cycle-open', 'cycle-spin', 'cycle-actions',
    'cycle-pick-mouse', 'cycle-jump', 'cycle-jump-result', 'search-samd11']
  for (const id of ids) {
    const step = document.steps.find((entry) => entry.id === id)
    assert.ok(step, `${id} is missing`)
    assert.equal(typeof step.arrive[0].cycle?.open, 'boolean', `${id} does not declare the wheel`)
  }
  const section = document.steps.filter((step) => step.section === 'Moving between genomes')
  assert.deepEqual(section.map((step) => step.id), ids.slice(1, -1))
  // The exercise turns the wheel, so the steps before it must start somewhere else.
  for (const id of ['cycle-spin', 'cycle-actions', 'cycle-pick-mouse']) {
    assert.equal(document.steps.find((step) => step.id === id).arrive[0].cycle.genome, 'slice-f2b4e46327a2')
  }
  const jump = document.steps.find((step) => step.id === 'cycle-jump')
  assert.equal(jump.arrive[0].cycle.genome, 'slice-5ff4df6986ca')
  // Jump moves the reader; it must not change which genomes are open.
  assert.deepEqual(jump.completeWhen.active, jump.arrive[0].active)
  assert.equal(jump.completeWhen.cycle.open, false)
})

test('a declared wheel is compared by open state, genome and action alike', () => {
  const open = { open: true, genome: 'rat', action: 'add' }
  assert.equal(browserSceneMatches({ cycle: { open: true } }, { cycle: open }), true)
  assert.equal(browserSceneMatches({ cycle: { open: false } }, { cycle: open }), false)
  assert.equal(browserSceneMatches({ cycle: { open: true, genome: 'mouse' } }, { cycle: open }), false)
  assert.equal(browserSceneMatches({ cycle: { open: true, action: 'none' } }, { cycle: open }), false)
  // A shut wheel has nothing else to say, so the rest is not compared.
  const shut = { open: false, genome: '', action: 'none' }
  assert.equal(browserSceneMatches({ cycle: { open: false, genome: 'rat' } }, { cycle: shut }), true)
  assert.ok(browserSceneProblems({ cycle: { open: true, genome: 'absent' } }, [{ recipeId: 'rat' }]).length)
  assert.ok(browserSceneProblems({ cycle: { action: 'sideways' } }, [{ recipeId: 'rat' }]).length)
  assert.deepEqual(browserSceneProblems({ cycle: { open: true, genome: 'rat', action: 'focus' } }, [{ recipeId: 'rat' }]), [])
})

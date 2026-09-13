import test from 'node:test'
import assert from 'node:assert/strict'

const palettes = () => import('../src/components/alignment-explorer/palettes.js')
const conservation = () => import('../src/components/alignment-explorer/conservation.js')
const layers = () => import('../src/components/alignment-explorer/layers.js')
const schemes = () => import('../src/components/alignment-explorer/colourSchemes.js')

test('every base palette names all five bases in both themes, and no two the same',async()=>{
  const {BASE_PALETTES}=await palettes()
  assert.ok(BASE_PALETTES.length>=4,'the menu offers a choice worth calling one')
  for(const palette of BASE_PALETTES){
    for(const theme of ['light','dark']){
      const colours=palette[theme]
      for(const key of ['baseA','baseC','baseG','baseT','baseN'])
        assert.match(colours[key]||'',/^#[0-9a-f]{6}$/i,`${palette.id} ${theme} ${key}`)
      // Four bases that share a colour are four bases nobody can tell apart.
      const bases=['baseA','baseC','baseG','baseT'].map(key=>colours[key])
      assert.equal(new Set(bases).size,4,`${palette.id} ${theme} repeats a colour`)
    }
  }
})

test('every ramp runs from 0 to 1 in order, in both themes',async()=>{
  const {RAMP_PALETTES}=await palettes()
  assert.ok(RAMP_PALETTES.length>=4)
  for(const palette of RAMP_PALETTES){
    for(const theme of ['light','dark']){
      const stops=palette[theme]
      assert.equal(stops[0][0],0,`${palette.id} ${theme} starts at 0`)
      assert.equal(stops[stops.length-1][0],1,`${palette.id} ${theme} ends at 1`)
      for(let i=1;i<stops.length;i++)
        assert.ok(stops[i][0]>stops[i-1][0],`${palette.id} ${theme} stops climb`)
      for(const [,...rgb] of stops)
        for(const channel of rgb) assert.ok(channel>=0&&channel<=255,`${palette.id} ${theme} channel in range`)
    }
  }
})

test('a ramp gains contrast against its own page as the quantity rises',async()=>{
  const {RAMP_PALETTES}=await palettes()
  const {buildRamp,RAMP_SIZE}=await conservation()
  const luminance=colour=>{const [r,g,b]=colour.match(/\d+/g).map(Number);return .2126*r+.7152*g+.0722*b}
  // The ground is near-white in light mode and near-black in dark, so "more"
  // has to darken on one and brighten on the other. A palette that got this
  // backwards would read as an inverted scale rather than as a different one.
  for(const palette of RAMP_PALETTES){
    const dark=buildRamp(false,palette.id),light=buildRamp(true,palette.id)
    assert.ok(luminance(dark[RAMP_SIZE-1])>luminance(dark[0])+40,`${palette.id} brightens toward more on a dark page`)
    assert.ok(luminance(light[RAMP_SIZE-1])<luminance(light[0])-40,`${palette.id} darkens toward more on a light page`)
  }
})

test('every ramp is dense, deterministic and clear of the gold reserved for picked',async()=>{
  const {RAMP_PALETTES}=await palettes()
  const {buildRamp,RAMP_SIZE}=await conservation()
  for(const palette of RAMP_PALETTES){
    for(const light of [true,false]){
      const ramp=buildRamp(light,palette.id)
      assert.equal(ramp.length,RAMP_SIZE)
      assert.deepEqual(ramp,buildRamp(light,palette.id),'memoised per palette and theme, and the same every time')
      for(const colour of ramp){
        const [r,g,b]=colour.match(/\d+/g).map(Number)
        // Gold is high red, high green, low blue. What is picked owns that.
        assert.ok(!(r>195&&g>165&&g<215&&b<115),`${palette.id} ${light?'light':'dark'} ${colour} is too close to the picked gold`)
      }
    }
  }
  // Memoising on one key for every palette would have served one ramp for all.
  const [first,second]=RAMP_PALETTES
  assert.notDeepEqual(buildRamp(false,first.id),buildRamp(false,second.id))
})

test('an unknown palette falls back to one that exists, of the right kind',async()=>{
  const {paletteById,basePalette,rampStops,defaultPalette,BASE_PALETTES,RAMP_PALETTES}=await palettes()
  assert.equal(paletteById('base','nonesuch').id,BASE_PALETTES[0].id)
  assert.equal(paletteById('ramp','nonesuch').id,RAMP_PALETTES[0].id)
  // A ramp id asked of the base set is just as unknown as a made-up one.
  assert.equal(paletteById('base','heat').id,BASE_PALETTES[0].id)
  assert.equal(defaultPalette('base'),BASE_PALETTES[0].id)
  assert.ok(basePalette(undefined,false).baseA,'no choice yet still paints')
  assert.ok(rampStops(undefined,false).length)
})

test('a saved palette per scheme round-trips, and a wrong one is corrected not kept',async()=>{
  const {validPalettes}=await layers()
  const {BASE_PALETTES,RAMP_PALETTES}=await palettes()
  const base=BASE_PALETTES[1].id,ramp=RAMP_PALETTES[1].id
  assert.deepEqual(validPalettes({bases:base,conservation:ramp}),{bases:base,conservation:ramp})
  // A palette belonging to the other kind of scheme is not a palette here.
  assert.equal(validPalettes({bases:ramp}).bases,BASE_PALETTES[0].id)
  assert.equal(validPalettes({conservation:base}).conservation,RAMP_PALETTES[0].id)
  // Nothing saved stays nothing saved, rather than becoming a choice nobody made.
  assert.deepEqual(validPalettes(undefined),{})
  assert.deepEqual(validPalettes({bases:7}),{})
  assert.deepEqual(validPalettes({nosuchscheme:'heat'}),{})
})

test('a workspace carries the palettes and whether the key is overlaid',async()=>{
  const {validateLayerWorkspace,emptyWorkspace}=await layers()
  const {RAMP_PALETTES}=await palettes()
  const ramp=RAMP_PALETTES[1].id
  assert.deepEqual(emptyWorkspace().palette,{})
  // Off unless asked for: the key belongs in the Colour menu, where it always
  // is, and the alignment is what the window is for.
  assert.equal(emptyWorkspace().legendOverlay,false)
  const saved=validateLayerWorkspace({...emptyWorkspace(),palette:{conservation:ramp},legendOverlay:true},[])
  assert.equal(saved.palette.conservation,ramp)
  assert.equal(saved.legendOverlay,true)
  assert.equal(validateLayerWorkspace({...emptyWorkspace(),legendOverlay:undefined},[]).legendOverlay,false)
})

test('preset schemes offer a palette kind and a legend in the shape the key draws',async()=>{
  const {COLOUR_SCHEMES}=await schemes()
  const {palettesOfKind}=await palettes()
  for(const scheme of COLOUR_SCHEMES.filter(s=>s.id!=='motif')){
    assert.ok(['base','ramp','flat'].includes(scheme.palettes),`${scheme.id} says which palettes it takes`)
    assert.ok(palettesOfKind(scheme.palettes).length,`${scheme.id} has some`)
    // Every tab in the Colour menu shows a key, including the one that never
    // had one: a scheme with no legend would open on an empty tab.
    const legend=scheme.legend(false,undefined,palettesOfKind(scheme.palettes)[0].id)
    assert.ok(legend.note)
    if(legend.kind==='swatches'){
      assert.ok(legend.swatches.length>=1)
      for(const swatch of legend.swatches) assert.ok(swatch.label&&swatch.colour)
    } else {
      assert.equal(legend.kind,'ramp')
      assert.ok(legend.bar.length&&legend.across&&legend.low&&legend.high)
    }
  }
})

test('the selection kinds are one setting with a remembered choice',async()=>{
  const {SELECT_KINDS,isSelectMode,selectKind}=await import('../src/components/alignment-explorer/selectKinds.js')
  assert.deepEqual(SELECT_KINDS.map(k=>k.mode),['rectangle','columns'])
  assert.ok(isSelectMode('rectangle')&&isSelectMode('columns'))
  assert.ok(!isSelectMode('pan'),'Pan is the absence of this tool, not one of its kinds')
  // Pan is what the mode falls back to after every completed selection, so the
  // button has to read its label from the remembered kind instead.
  assert.equal(selectKind('columns').mode,'columns')
  assert.equal(selectKind('pan','columns').mode,'columns')
  assert.equal(selectKind('pan',undefined).mode,'rectangle')
})

test('a menu is pinned to its button and pulled back from the window edge',async()=>{
  const {menuPosition,MENU_WIDTH}=await import('../src/components/alignment-explorer/menuAnchor.js')
  const previous=globalThis.window
  globalThis.window={innerWidth:1000,innerHeight:800}
  try{
    const at=(left,right)=>({getBoundingClientRect:()=>({left,right,width:right-left,bottom:40})})
    const left=menuPosition(at(120,200))
    assert.equal(left.left,120,'hangs from the left edge of its button')
    assert.equal(left.top,49,'leaves space for the connector below the button')
    assert.equal(left.left+parseFloat(left['--al-menu-pointer']),160,'connector points at the button centre')
    // Near the right of the bar the menu would run off the window, so it is
    // pulled back by its own width rather than being clipped.
    const right=menuPosition(at(900,980))
    assert.equal(right.left,1000-MENU_WIDTH-8)
    assert.equal(right.left+parseFloat(right['--al-menu-pointer']),940,'clamping preserves the connection to the originating button')
    assert.ok(right.top+parseFloat(right['--al-menu-max-height'])<=window.innerHeight-8)
    assert.equal(menuPosition(at(900,980),320).width,320,'menus can request their own width')
    window.innerWidth=320
    const narrow=menuPosition(at(230,300))
    assert.ok(narrow.left>=8&&narrow.left+narrow.width<=312,'narrow windows keep the whole menu on screen')
    assert.equal(narrow.left+parseFloat(narrow['--al-menu-pointer']),265)
    assert.deepEqual(menuPosition(null),{top:0,left:8},'no button yet is not a crash')
  } finally { globalThis.window=previous }
})

test('uniform is a shading of the bases scheme, not a scheme of its own',async()=>{
  const {COLOUR_SCHEMES,SHADING_MODES,shadingById}=await schemes()
  const {presenceColour}=await palettes()
  // Motifs have their own user-defined colours; uniform remains base shading.
  assert.deepEqual(COLOUR_SCHEMES.map(s=>s.id),['bases','conservation','representation','motif'])
  const bases=COLOUR_SCHEMES.find(s=>s.id==='bases')
  assert.ok(bases.shading,'only bases has anything to shade')
  assert.ok(!COLOUR_SCHEMES.filter(s=>s.id!=='bases').some(s=>s.shading))
  assert.deepEqual(SHADING_MODES.map(m=>m.id),['relative','uniform'])
  assert.equal(shadingById('uniform').id,'uniform')
  assert.equal(shadingById('nonesuch').id,'relative','an unknown shading is the one it always was')
  assert.equal(shadingById(undefined).id,'relative')
  // Uniform paints in the colour this view already uses for bare presence,
  // rather than introducing a fifth thing to choose.
  assert.match(presenceColour(false),/^#[0-9a-f]{6}$/i)
  assert.notEqual(presenceColour(true),presenceColour(false))
})

test('the bases key names the flat colour only when it is on screen',async()=>{
  const {basesLegend}=await palettes()
  const relative=basesLegend(false,null,'classic','relative'),uniform=basesLegend(false,null,'classic','uniform')
  assert.deepEqual(relative.swatches.map(s=>s.label),['A','C','G','T','N'])
  // Under uniform shading a flat block is a thing the reader sees, so the key
  // has to be able to answer it.
  assert.deepEqual(uniform.swatches.map(s=>s.label),['A','C','G','T','N','Present'])
  assert.match(relative.note,/agreement with the comparison row/)
  assert.match(uniform.note,/one flat colour/)
})

test('a workspace carries the shading, and an unknown one falls back',async()=>{
  const {validateLayerWorkspace,emptyWorkspace}=await layers()
  assert.equal(emptyWorkspace().shading,'relative')
  assert.equal(validateLayerWorkspace({...emptyWorkspace(),shading:'uniform'},[]).shading,'uniform')
  assert.equal(validateLayerWorkspace({...emptyWorkspace(),shading:'nonesuch'},[]).shading,'relative')
})

test('a uniform span is one run of sequence, cut only where this row is absent',async()=>{
  const {uniformRuns}=await import('../src/components/alignment-explorer/paintUniform.js')
  // Detail: the row's own gaps, and everything either side merged as far as it goes.
  assert.deepEqual(uniformRuns(10,18,{sequence:'AC--GGTT'},{start:10,detail:true},true),
    [{start:10,end:12,gap:false},{start:12,end:14,gap:true},{start:14,end:18,gap:false}])
  // A span with nothing missing costs exactly one rectangle.
  assert.deepEqual(uniformRuns(0,400,{sequence:'A'.repeat(400)},{start:0,detail:true},true),
    [{start:0,end:400,gap:false}])
  // Bins: only a bin every sequence was absent from is a gap. The middle bin
  // here is three gaps and one base, which is sequence.
  assert.deepEqual(uniformRuns(0,9,{bins:[{'-':4},{A:1,'-':3},{'-':4}]},{start:0,end:9,bin_size:3},false),
    [{start:0,end:3,gap:true},{start:3,end:6,gap:false},{start:6,end:9,gap:true}])
  // Runs are clipped to the span asked for, never to the tile that holds it.
  assert.deepEqual(uniformRuns(4,8,{bins:[{'-':2},{A:2},{A:2},{A:2}]},{start:0,end:12,bin_size:3},false),
    [{start:4,end:8,gap:false}])
  // Nothing loaded yet is not nothing there: membership already said the row is
  // here, so it paints rather than reading as an absence.
  assert.deepEqual(uniformRuns(0,5,null,null,false),[{start:0,end:5,gap:false}])
  assert.deepEqual(uniformRuns(3,3,{sequence:'AAA'},{start:0,detail:true},true),[],'an empty span draws nothing')
})
